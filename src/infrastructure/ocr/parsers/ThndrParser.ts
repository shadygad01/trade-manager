import type { ParsedDividendCandidate, ParsedTradeCandidate, ParseConfidence } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { COMPANY_NAME_ALIASES, KNOWN_EGX_TICKERS, NON_STOCK_INSTRUMENTS } from "@domain/value-objects/knownTickers";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { BrokerParser, OrderRowText, OrderRowsParseResult, OrdersScreenParseResult } from "./BrokerParser";
import { defaultTrackedSince, isWithinTrackedRange, partitionByRange } from "./trackedDateRange";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Parses dd-mm-yyyy / yyyy-mm-dd / dd-mm-yy (after normalizing "/" to "-") statement dates into an ISO date string. */
function parseStatementDate(str: string): string | null {
  const clean = str.replace(/\//g, "-");
  let m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(clean);
  if (m) return toIsoDate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(clean);
  if (m) return toIsoDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  m = /^(\d{1,2})-(\d{1,2})-(\d{2})$/.exec(clean);
  if (m) return toIsoDate(2000 + parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
  return null;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
}

const CONFIDENCE_RANK: Record<ParseConfidence, number> = { low: 0, medium: 1, high: 2 };

/** The weaker of two confidence levels — used when a candidate passes through more than one uncertain step. */
function downgrade(a: ParseConfidence, b: ParseConfidence): ParseConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

export function normalizeCompanyKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,]/g, "")
    .replace(/\b(LTD|CO|SAE|PLC|CORP|COMPANY)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

const COMPANY_TICKER_MAP: Record<string, string> = {};
for (const { ticker, companyName } of KNOWN_EGX_TICKERS) {
  COMPANY_TICKER_MAP[normalizeCompanyKey(companyName)] = ticker;
}
for (const { ticker, companyName } of COMPANY_NAME_ALIASES) {
  COMPANY_TICKER_MAP[normalizeCompanyKey(companyName)] = ticker;
}

const CANONICAL_NAMES: Record<string, string> = {};
for (const { ticker, companyName } of KNOWN_EGX_TICKERS) {
  CANONICAL_NAMES[ticker] = titleCase(companyName);
}

export function canonicalNameForTicker(ticker: string): string {
  return CANONICAL_NAMES[ticker] ?? ticker;
}

// OCR sometimes garbles a letter or two inside an otherwise-recognizable
// company name (seen in practice: "INTERNATIONAL" -> "INTEMATIONAL",
// "ORIENTAL" -> "ORLENTAL"). Compares the leading slice of key (company
// names appear at the start of the description) against each known name,
// tolerant of a small number of character-level edits proportional to
// length, so a couple of misread letters don't spawn a separate fallback
// "ticker" for a company that's actually already mapped.
export function fuzzyMatchTicker(key: string): string | null {
  for (const [name, ticker] of Object.entries(COMPANY_TICKER_MAP)) {
    const candidate = key.slice(0, name.length);
    if (candidate.length < name.length * 0.7) continue;
    const threshold = Math.max(2, Math.floor(name.length * 0.15));
    if (levenshtein(candidate, name) <= threshold) return ticker;
  }
  return null;
}

// A normalized company name shorter than this carries no real
// distinguishing information — real company names (mapped or not) are
// always multi-character words, so anything this short is far more likely
// an OCR-garbled/truncated fragment (the observed real failure: a
// statement row's description misread down to just "TE") than an actual
// unmapped company. Rejected outright rather than turned into a fallback
// "ticker" group around noise.
const MIN_UNMAPPED_NAME_LENGTH = 3;

// Thndr sometimes appends a bracketed annotation right after a company's
// full name — a trading-symbol short-form ("Egyptian International
// Pharmaceuticals (EIPICO)") or a qualifier ("Commercial International Bank
// (Egypt)"). OCR renders the bracket glyph inconsistently ("(" vs "{"), and
// normalizeCompanyKey doesn't strip it, so the exact same company — read
// from two documents that happened to OCR the bracket differently — used to
// normalize to two different strings and, whenever the name itself wasn't
// in KNOWN_EGX_TICKERS, spawn two separate fallback "ticker" groups for one
// real stock. Stripping the annotation before matching/falling back means
// both variants collapse to the identical name, so they always resolve the
// same way regardless of which bracket character OCR produced. None of
// KNOWN_EGX_TICKERS's own company names end in a bracket, so this can only
// improve a match, never mask an intentional one.
const TRAILING_BRACKET_PATTERN = /\s*[({[][^(){}[\]]{1,20}[)}\]]\s*$/;

function stripTrailingBracket(key: string): string {
  return key.replace(TRAILING_BRACKET_PATTERN, "").trim();
}

/**
 * Resolves a Description-column company name to a ticker symbol: exact
 * normalized match ("high" confidence), then prefix match ("medium" — the
 * known map's company names and Thndr's own descriptions truncate/extend
 * differently), then fuzzy match ("medium" — tolerates a couple of
 * OCR-garbled letters, but is still a guess). Falls back to the normalized
 * company name itself when nothing matches ("low" confidence) — a
 * consistent unmapped label beats a guessed, possibly wrong, ticker — unless
 * that name is implausibly short, in which case this returns null so the
 * caller drops the row instead of fabricating a group around noise.
 */
function resolveTicker(description: string): { ticker: string; confidence: ParseConfidence } | null {
  const rawKey = normalizeCompanyKey(description);
  if (COMPANY_TICKER_MAP[rawKey]) return { ticker: COMPANY_TICKER_MAP[rawKey], confidence: "high" };
  if (rawKey.length < MIN_UNMAPPED_NAME_LENGTH) return null;

  const stripped = stripTrailingBracket(rawKey);
  const key = stripped.length >= MIN_UNMAPPED_NAME_LENGTH ? stripped : rawKey;
  if (key !== rawKey && COMPANY_TICKER_MAP[key]) return { ticker: COMPANY_TICKER_MAP[key], confidence: "high" };

  // name.startsWith(key) is only a meaningful "OCR truncated this" signal
  // once key itself is long enough to identify a specific company — a short
  // key (already rejected above) would otherwise spuriously "prefix-match"
  // any company name that happens to start with the same couple of letters.
  for (const [name, ticker] of Object.entries(COMPANY_TICKER_MAP)) {
    if (key.startsWith(name) || name.startsWith(key)) return { ticker, confidence: "medium" };
  }
  const fuzzy = fuzzyMatchTicker(key);
  if (fuzzy) return { ticker: fuzzy, confidence: "medium" };
  return { ticker: key, confidence: "low" };
}

// Thndr "Customer Account Statement" rows look like:
//   2/2/2026   Buy Eastern Co. (50@39.3800)   -1,974.47   8,333.15
//   19/2/2026  Sell EFG HOLDING (45@27.7000)   1,241.95   7,584.92
// Bounded to 80 chars so a malformed row without a real qty@price group
// can't run on and swallow the next row's data. Both "(" and "{" (and "["
// and "]") are accepted on either side of the qty@price group: OCR sometimes
// misreads "(" as "{", and the strict ")" requirement then fails to close
// the *real* group, letting the match run on across the row boundary and
// steal the next row's values while its own transaction silently never gets
// recorded. The company name itself can contain its own parenthetical (e.g.
// "Commercial International Bank (Egypt)"), so the description group allows
// and skips past parens instead of excluding them, continuing to look until
// it finds the one that's actually "<qty>@<price>". An optional "EGP" is
// allowed right before the close bracket, and the trailing group captures
// the row's "Value" column (see the price-from-value note below).
const statementRowPattern =
  /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(Buy|Sell|شراء|بيع)\s+(.{1,80}?)\s*[({[]\s*([\d,]+(?:\.\d+)?)\s*@\s*([\d,]+(?:\.\d+)?)\s*(?:EGP\s*)?[)}\]](?:\s*(-?[\d,]+(?:\.\d+)?))?/gi;

function parseStatementTextImpl(text: string): ParsedTradeCandidate[] {
  const candidates: ParsedTradeCandidate[] = [];
  // Match across the whole document rather than line-by-line: text extracted
  // from a PDF or via OCR doesn't reliably put one transaction per line.
  const normalized = text.replace(/\s+/g, " ");

  for (const m of normalized.matchAll(statementRowPattern)) {
    const [, dateStr, typeStr, description, qtyStr, priceStr, valueStr] = m;

    if (NON_STOCK_INSTRUMENTS.has(normalizeCompanyKey(description))) continue;

    const shares = parseFloat(qtyStr.replace(/,/g, ""));
    let price = parseFloat(priceStr.replace(/,/g, ""));
    if (!shares || !price) continue;

    // The printed per-share price doesn't include brokerage commission, but
    // the actual amount debited/credited (the Value column) does — e.g. a
    // statement row "Buy Arabian Cement (42@47.4700) -1,999.23" actually
    // costs 1,999.23, not 42 * 47.47 = 1,993.74. Deriving an effective
    // per-share price from Value keeps shares * price (used everywhere
    // downstream) equal to what was actually paid/received.
    if (valueStr) {
      const value = Math.abs(parseFloat(valueStr.replace(/,/g, "")));
      if (value > 0) price = value / shares;
    }

    const date = parseStatementDate(dateStr);
    if (!date) continue;

    const isBuy = /buy|شراء/i.test(typeStr);
    const resolved = resolveTicker(description.trim());
    if (!resolved) continue;
    const { ticker, confidence } = resolved;
    if (NON_STOCK_INSTRUMENTS.has(ticker.toUpperCase())) continue;

    candidates.push({
      ticker: normalizeTicker(ticker),
      companyName: canonicalNameForTicker(normalizeTicker(ticker)),
      side: isBuy ? "BUY" : "SELL",
      confidence,
      shares,
      price,
      date,
    });
  }

  return candidates;
}

// ─── Format 1b: Thndr per-trade "Invoice" (PDF email receipt) ──────────────
// A completely different document from the statement/orders screens above:
// a one-transaction-per-document PDF receipt with explicit field labels
// ("Security Name", "Quantity", "Total Cost", "Total Fees", ...) rather than
// an inline "Buy X (qty@price)" sentence. The invoice's own footer states
// "the text in this invoice is standardized", so — unlike the OCR'd
// screenshots this file otherwise parses — every field here is anchored to
// a fixed label instead of being positionally guessed at, which is why this
// path can trust "Average Price"/"Total Cost"/"Total Fees" directly rather
// than deriving price from a Value column the way parseStatementTextImpl
// has to.
const looksLikeInvoicePattern = /invoice/i;

function looksLikeInvoiceImpl(text: string): boolean {
  return looksLikeInvoicePattern.test(text) && /security name/i.test(text) && /thndr/i.test(text);
}

function parseInvoiceTextImpl(text: string): ParsedTradeCandidate[] {
  const normalized = text.replace(/\s+/g, " ");

  const dateMatch = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!dateMatch) return [];
  const date = toIsoDate(parseInt(dateMatch[3], 10), parseInt(dateMatch[2], 10), parseInt(dateMatch[1], 10));
  if (!date) return [];

  // "Security Name / Symbol Code / Transaction Type / Average Cost" header
  // immediately followed by that row's values, in the same left-to-right
  // reading order — the invoice's fixed table layout, not a guess.
  const headerMatch = normalized.match(
    /Security Name\s+Symbol Code\s+Transaction Type\s+Average Cost\s+(.+?)\s+([A-Z]{2}[A-Z0-9]{6,})\s+(Buy|Sell)\s+[\d,]+(?:\.\d+)?\s*EGP/i,
  );
  if (!headerMatch) return [];
  const [, securityName, , sideRaw] = headerMatch;

  const totalsMatch = normalized.match(
    /Total Quantity\s+Average Price\s+Total Cost\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s*EGP\s+([\d,]+(?:\.\d+)?)\s*EGP/i,
  );
  if (!totalsMatch) return [];
  const shares = parseFloat(totalsMatch[1].replace(/,/g, ""));
  const price = parseFloat(totalsMatch[2].replace(/,/g, ""));
  if (!shares || !price) return [];

  const feesMatch = normalized.match(/Total Fees\s+([\d,]+(?:\.\d+)?)\s*EGP/i);
  const fees = feesMatch ? parseFloat(feesMatch[1].replace(/,/g, "")) : 0;

  const resolved = resolveTicker(securityName.trim());
  if (!resolved) return [];
  const { ticker, confidence } = resolved;
  if (NON_STOCK_INSTRUMENTS.has(ticker.toUpperCase())) return [];

  return [
    {
      ticker: normalizeTicker(ticker),
      companyName: canonicalNameForTicker(normalizeTicker(ticker)),
      side: /buy/i.test(sideRaw) ? "BUY" : "SELL",
      confidence,
      shares,
      price,
      fees,
      date,
    },
  ];
}

// ─── Format 2: Thndr app "Orders" screen (screenshot) ──────────────────────
const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// OCR at this font/resolution confuses a few characters when they appear in
// numbers: "O" for "0", and "T"/"I"/lowercase-"l" for "1" (most visibly when
// "11" renders as "Tl"). Safe to blanket-replace within a digit run already
// known to be numeric from context.
export function normalizeDigits(s: string): string {
  return s.replace(/[Oo]/g, "0").replace(/[TIl]/g, "1");
}

// Thndr always renders prices with exactly 3 decimals (e.g. "76.500"), but
// OCR sometimes reads the decimal point as a comma. Whichever separator
// precedes the final 3 digits is the decimal point; an earlier comma (rare
// for share prices) is a thousands separator.
export function parsePrice(raw: string): number {
  const m = /^([\d,]*\d)[.,](\d{3})$/.exec(raw.trim());
  if (m) return parseFloat(`${m[1].replace(/,/g, "")}.${m[2]}`);
  return parseFloat(raw.replace(/,/g, ""));
}

// "11 Feb 26" / "20 Aug 24" -> { date: "2026-02-11", ... }
function parseShortDate(str: string): string | null {
  const m = /^([\dOoTIl]{1,3})\s+([A-Za-z]{3,9})\s+([\dOo]{2,4})$/.exec(str.trim());
  if (!m) return null;
  const day = parseInt(normalizeDigits(m[1]), 10);
  const month = MONTH_MAP[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  let year = parseInt(normalizeDigits(m[3]), 10);
  if (year < 100) year += 2000;
  return toIsoDate(year, month, day);
}

function normalizeTime(raw: string): string {
  return normalizeDigits(raw).replace(/\s+/g, "").toUpperCase();
}

const NON_TICKER_WORDS = new Set(["EGP", "PLC", "LTD", "SAE", "ALL", "USD", "GBP", "EUR"]);

// The header shows the ticker code and, below it, the full company name.
// Prefer matching the company name against the known map (more OCR-robust
// than a short ticker code rendered in small text); fall back to the first
// plausible all-caps ticker-looking token.
//
// EGX equity tickers are consistently exactly 4 letters (every entry in
// KNOWN_EGX_TICKERS is 4 chars) — the fallback used to accept anywhere from
// 2 to 6, which meant an unrelated 2-3 letter OCR fragment near the header
// (a mis-read label, an icon's alt text, anything) was happily accepted as
// a "ticker" every time, silently spawning a bogus ticker group in Import.
// Requiring exactly 4 rejects that whole class of noise outright — if
// nothing 4-letter turns up, this correctly reports "couldn't resolve" and
// the caller surfaces that as a warning instead of fabricating a guess.
const HEADER_TICKER_LENGTH = 4;

function resolveHeaderTickerImpl(text: string): { ticker: string; confidence: ParseConfidence } | null {
  const head = text.slice(0, 400);
  const key = normalizeCompanyKey(head);
  for (const [name, ticker] of Object.entries(COMPANY_TICKER_MAP)) {
    if (key.includes(name)) return { ticker, confidence: "high" };
    // The app's own header truncates long company names with "…", so the
    // OCR'd text may only contain a prefix of the full name — match on that
    // prefix too rather than requiring the whole name.
    const prefixLen = Math.min(name.length, 15);
    if (prefixLen >= 8 && key.includes(name.slice(0, prefixLen))) return { ticker, confidence: "medium" };
  }
  const candidates = head.match(new RegExp(`\\b[A-Z]{${HEADER_TICKER_LENGTH}}\\b`, "g")) ?? [];
  for (const c of candidates) {
    if (!NON_TICKER_WORDS.has(c)) return { ticker: c, confidence: "low" };
  }
  return null;
}

const ALL_ORDERS_MARKER = /all\s*orders/i;

// OCR isn't reliable about symbols/separators (the "@" before a price, the
// dash between a date and a time). Once past the "All orders" heading, the
// only "EGP <number>" occurrences left are per-row prices — nothing else on
// that part of the screen mentions EGP — so it's safe to match "EGP
// <number>" without requiring "@" too. Before that heading (header fields
// like "Last trade price EGP 730.00") that guarantee doesn't hold, so stay
// strict there.
function ordersSection(text: string): { section: string; strict: boolean } {
  const idx = text.search(ALL_ORDERS_MARKER);
  if (idx >= 0) return { section: text.slice(idx), strict: false };
  return { section: text, strict: true };
}

// Bullet between "Buy/Sell" and the quantity OCRs inconsistently (bullet
// glyph, asterisk, guillemet, or dropped entirely) — accept up to two
// non-digit, non-space characters instead of a fixed set of glyphs. Digits
// are explicitly excluded from that gap so they can never be swallowed by it.
const orderActionPattern = /(Buy|Sell|شراء|بيع)\s*[^\s\d]{0,2}\s*([\d,TIl]+(?:\.\d+)?)\s*shares?/gi;
const orderPriceStrictPattern = /@\s*EGP\s*([\d,]+(?:[.,]\d+)?)/gi;
const orderPriceLenientPattern = /@?\s*EGP\s*([\d,]+(?:[.,]\d+)?)/gi;
// Allow up to a few stray characters between date and time instead of
// requiring a specific dash glyph, since OCR renders "–" inconsistently.
const orderDateTimePattern =
  /([\dOoTIl]{1,3}\s+[A-Za-z]{3,9}\s+[\dOo]{2,4})[^0-9A-Za-z]{0,4}([\dOoTIl]{1,2}:\d{2}\s*[AP]M)/gi;
const orderStatusPattern = /\b(Fulf\w*|Pending|Cancel\w*|Rejected|Expired)\b/gi;

function parseOrdersScreenTextImpl(text: string): OrdersScreenParseResult {
  const candidates: ParsedTradeCandidate[] = [];
  let incompleteRowCount = 0;
  const normalized = text.replace(/\s+/g, " ");
  const { section, strict } = ordersSection(normalized);

  const actions = [...section.matchAll(orderActionPattern)];
  if (actions.length === 0) {
    return { candidates, incompleteRowCount, fulfilledStatusCount: 0, statusCountMismatch: false };
  }

  const header = resolveHeaderTickerImpl(text);
  if (!header || NON_STOCK_INSTRUMENTS.has(header.ticker.toUpperCase())) {
    return { candidates, incompleteRowCount, fulfilledStatusCount: 0, statusCountMismatch: false };
  }
  const { ticker } = header;
  // Positional (non-row-isolated) field pairing has a documented failure
  // mode — capping at "medium" here even for an exact header-ticker match
  // reflects that risk, independent of how well the ticker itself resolved.
  const confidence = downgrade(header.confidence, "medium");

  const prices = [...section.matchAll(strict ? orderPriceStrictPattern : orderPriceLenientPattern)];
  const dates = [...section.matchAll(orderDateTimePattern)];
  const statuses = [...section.matchAll(orderStatusPattern)];
  const fulfilledStatusCount = statuses.filter((s) => /^fulf/i.test(s[1])).length;
  const statusCountMismatch = statuses.length !== actions.length;

  // Pair each action with the nearest price/date/status that falls between
  // it and the next action, instead of a strict positional zip — an OCR miss
  // on a single row's field then only drops that one incomplete row instead
  // of misaligning every row after it.
  for (let i = 0; i < actions.length; i++) {
    const start = actions[i].index ?? 0;
    const end = i + 1 < actions.length ? actions[i + 1].index ?? Infinity : Infinity;
    const priceMatch = prices.find((p) => (p.index ?? -1) >= start && (p.index ?? -1) < end);
    const dateMatch = dates.find((d) => (d.index ?? -1) >= start && (d.index ?? -1) < end);
    const statusMatch = statuses.find((s) => (s.index ?? -1) >= start && (s.index ?? -1) < end);
    if (!priceMatch || !dateMatch || !statusMatch) {
      incompleteRowCount += 1;
      continue;
    }
    if (!/^fulf/i.test(statusMatch[1])) continue; // skip pending/cancelled orders

    const shares = parseFloat(normalizeDigits(actions[i][2]).replace(/,/g, ""));
    const price = parsePrice(priceMatch[1]);
    if (!shares || !price) continue;

    const date = parseShortDate(dateMatch[1]);
    if (!date) continue;

    candidates.push({
      ticker: normalizeTicker(ticker),
      companyName: canonicalNameForTicker(normalizeTicker(ticker)),
      side: /buy|شراء/i.test(actions[i][1]) ? "BUY" : "SELL",
      confidence,
      shares,
      price,
      date,
      time: normalizeTime(dateMatch[2]),
    });
  }

  return { candidates, incompleteRowCount, fulfilledStatusCount, statusCountMismatch };
}

// ─── Row-isolated Orders-screen parsing ─────────────────────────────────────
// Counterpart to segmentOrderRows in imagePreprocess.ts. Because every slice
// contains exactly one row, the flat parser's positional action<->status
// pairing (and its observed failure mode: a Cancelled order silently counted
// as Fulfilled when Tesseract shuffled reading order) simply doesn't exist
// here — a row's fields can only ever come from that row.
const rowActionPattern = /(Buy|Sell|شراء|بيع)\s*[^\s\d]{0,2}\s*([\d,TIl]+(?:\.\d+)?)\s*shares?/i;
// Within a single row slice the only "EGP <number>" is the execution price,
// so the lenient (no-@) form is always safe — the header stat lines that
// forced the flat parser's strict/lenient split never appear in a slice.
const rowPricePattern = /@?\s*EGP\s*([\d,]+(?:[.,]\d+)?)/i;
const rowDateTimePattern = /([\dOoTIl]{1,3}\s+[A-Za-z]{3,9}\s+[\dOo]{2,4})[^0-9A-Za-z]{0,4}([\dOoTIl]{1,2}:\d{2}\s*[AP]M)/i;
const rowStatusPattern = /\b(Fulf\w*|Pending|Cancel\w*|Rejected|Expired)\b/i;

function parseOrderRowsTextImpl(rows: OrderRowText[], ticker: string): OrderRowsParseResult {
  const candidates: ParsedTradeCandidate[] = [];
  let incompleteRowCount = 0;
  let fulfilledStatusCount = 0;
  let resolvedRowCount = 0;

  if (NON_STOCK_INSTRUMENTS.has(ticker.toUpperCase())) {
    return { candidates, incompleteRowCount: 0, fulfilledStatusCount: 0, statusCountMismatch: false, resolvedRowCount: 0 };
  }

  for (const row of rows) {
    const normalized = row.text.replace(/\s+/g, " ");
    const action = rowActionPattern.exec(normalized);
    if (!action) continue; // not an order row (title, buttons, a stat line)

    // Pixel color is the primary status source; the OCR'd word is only
    // consulted when no status color was found — precisely because a
    // misread status *word* is the failure this path exists to eliminate.
    // That fallback is also strictly less reliable, so it caps this row's
    // confidence at "medium" even though row-isolation itself is otherwise
    // the most trustworthy parse path.
    let status: string | null = row.colorStatus;
    let confidence: ParseConfidence = "high";
    if (!status) {
      const statusWord = rowStatusPattern.exec(normalized);
      if (statusWord) status = statusWord[1].toLowerCase();
      confidence = "medium";
    }

    if (!status) {
      // Status couldn't be established either way — don't guess it into (or
      // out of) the position; surface it instead.
      incompleteRowCount += 1;
      continue;
    }
    resolvedRowCount += 1;
    if (!/^fulf/i.test(status)) continue; // cancelled/pending/rejected: not a trade
    fulfilledStatusCount += 1;

    const priceMatch = rowPricePattern.exec(normalized);
    const dateMatch = rowDateTimePattern.exec(normalized);
    if (!priceMatch || !dateMatch) {
      incompleteRowCount += 1;
      continue;
    }

    const shares = parseFloat(normalizeDigits(action[2]).replace(/,/g, ""));
    const price = parsePrice(priceMatch[1]);
    if (!shares || !price) {
      incompleteRowCount += 1;
      continue;
    }
    const date = parseShortDate(dateMatch[1]);
    if (!date) {
      incompleteRowCount += 1;
      continue;
    }

    candidates.push({
      ticker: normalizeTicker(ticker),
      companyName: canonicalNameForTicker(normalizeTicker(ticker)),
      side: /buy|شراء/i.test(action[1]) ? "BUY" : "SELL",
      confidence,
      shares,
      price,
      date,
      time: normalizeTime(dateMatch[2]),
    });
  }

  // statusCountMismatch is structurally impossible here (each row carries
  // its own status), hence always false on this path.
  return { candidates, incompleteRowCount, fulfilledStatusCount, statusCountMismatch: false, resolvedRowCount };
}

// ─── Format 3: Thndr app "My position" screen (ground-truth verification) ──
function numbersAfter(section: string, label: RegExp): string[] {
  const m = label.exec(section);
  if (!m) return [];
  const rest = section.slice(m.index + m[0].length);
  // Must start with a real digit (0-9) — unlike the date/price parsing
  // above, this scans through ordinary prose (other labels' text) looking
  // for numbers, and the O/T/I/l digit-noise substitutes are common letters
  // that would otherwise match *inside real words* (e.g. the "o" in "cost")
  // before ever reaching an actual value.
  const numPattern = /\d[\d,OoTIl]*(?:[.,]\d+)?/g;
  return [...rest.matchAll(numPattern)].map((mm) => mm[0]);
}

function parsePositionVerificationTextImpl(text: string): Omit<PositionVerification, "id" | "portfolioId"> | null {
  const normalized = text.replace(/\s+/g, " ");
  const header = resolveHeaderTickerImpl(text);
  if (!header) return null;
  const { ticker } = header;

  // Scope to the position card itself, stopping before "Earned Cash
  // Dividends" (which has its own EGP-prefixed numbers that must never be
  // mistaken for Units/Average cost/etc.) when that section is present.
  const startIdx = normalized.search(/my\s+current\s+position/i);
  const section = startIdx >= 0 ? normalized.slice(startIdx) : normalized;
  const endIdx = section.search(/earned\s+cash\s+dividends/i);
  const scoped = endIdx >= 0 ? section.slice(0, endIdx) : section;

  // The four stat cards (Units, Average cost, Purchase Value, Market value)
  // render as a 2-column grid in that fixed order, but Tesseract doesn't
  // reliably preserve a consistent scan order across a grid like this — it
  // may read a card's label directly followed by its own value, or all four
  // labels first and then all four values. Either way the four *values*
  // still surface in the same left-to-right, top-to-bottom order as their
  // cells, so every number after "Units" is pulled in document order and
  // assigned positionally (1st = Units, 2nd = Average cost, ...) rather than
  // searched for near each individual label, which can latch onto a
  // neighboring cell's number when two labels sit adjacent.
  const numbers = numbersAfter(scoped, /units/i);
  if (numbers.length === 0) return null;
  const units = parseFloat(normalizeDigits(numbers[0]).replace(/,/g, ""));
  if (!units) return null;

  const avgCost = numbers[1] != null ? parseFloat(normalizeDigits(numbers[1]).replace(/,/g, "")) : undefined;

  return {
    ticker: normalizeTicker(ticker),
    companyName: canonicalNameForTicker(normalizeTicker(ticker)),
    units,
    avgCost,
    capturedAt: new Date().toISOString(),
    source: "screenshot",
  };
}

// The "My position" screen's own dividend history, e.g.:
//   Total                    EGP 209.38
//   28 June 2026             EGP 64.98
//   25 May 2026              EGP 144.40
// Only the dated rows are dividend candidates — the "Total" line has no
// date, so it never matches this pattern and needs no special-casing to skip.
const dividendSectionMarker = /earned\s+cash\s+dividends/i;
const dividendRowPattern = /(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*EGP\s*([\d,]+(?:[.,]\d+)?)/gi;

function parseDividendsTextImpl(text: string, ticker: string): ParsedDividendCandidate[] {
  const normalized = text.replace(/\s+/g, " ");
  const idx = normalized.search(dividendSectionMarker);
  if (idx < 0) return [];
  const section = normalized.slice(idx);

  const dividends: ParsedDividendCandidate[] = [];
  for (const m of section.matchAll(dividendRowPattern)) {
    const date = parseShortDate(m[1].trim());
    if (!date) continue;
    const amount = parsePrice(m[2]);
    if (!amount) continue;
    dividends.push({
      ticker: normalizeTicker(ticker),
      companyName: canonicalNameForTicker(normalizeTicker(ticker)),
      date,
      amount,
    });
  }
  return dividends;
}

const looksLikeOwnDocumentPattern = /customer account statement|thndr/i;
const looksLikePositionVerificationPattern = /my\s+current\s+position/i;

/**
 * Thndr brokerage OCR/text parser — first (and currently only) implementation
 * of the pluggable BrokerParser extension point.
 */
export class ThndrParser implements BrokerParser {
  readonly id = "thndr";
  private readonly trackedSince: string;

  constructor(trackedSince: string = defaultTrackedSince()) {
    this.trackedSince = trackedSince;
  }

  /** True for dates on/after the configured cutoff and not more than one day in the future. */
  isWithinTrackedRange(dateIso: string): boolean {
    return isWithinTrackedRange(dateIso, this.trackedSince);
  }

  looksLikeOwnDocument(text: string): boolean {
    return looksLikeOwnDocumentPattern.test(text);
  }

  looksLikePositionVerification(text: string): boolean {
    return (
      looksLikePositionVerificationPattern.test(text) && /units/i.test(text) && /average\s*cost/i.test(text)
    );
  }

  parseStatementText(text: string): ParsedTradeCandidate[] {
    const raw = looksLikeInvoiceImpl(text) ? parseInvoiceTextImpl(text) : parseStatementTextImpl(text);
    const { inRange } = partitionByRange(raw, (d) => this.isWithinTrackedRange(d));
    return inRange;
  }

  parseOrdersScreenText(text: string): OrdersScreenParseResult {
    const result = parseOrdersScreenTextImpl(text);
    const { inRange, outOfRangeCount } = partitionByRange(result.candidates, (d) => this.isWithinTrackedRange(d));
    return { ...result, candidates: inRange, outOfRangeCount };
  }

  parsePositionVerification(text: string): Omit<PositionVerification, "id" | "portfolioId">[] {
    const result = parsePositionVerificationTextImpl(text);
    return result ? [result] : [];
  }

  parseDividends(text: string): ParsedDividendCandidate[] {
    const header = resolveHeaderTickerImpl(text);
    if (!header) return [];
    return parseDividendsTextImpl(text, header.ticker);
  }

  resolveHeaderTicker(text: string): string | null {
    return resolveHeaderTickerImpl(text)?.ticker ?? null;
  }

  parseOrderRowsText(rows: OrderRowText[], ticker: string): OrderRowsParseResult {
    const result = parseOrderRowsTextImpl(rows, ticker);
    const { inRange, outOfRangeCount } = partitionByRange(result.candidates, (d) => this.isWithinTrackedRange(d));
    return { ...result, candidates: inRange, outOfRangeCount };
  }
}

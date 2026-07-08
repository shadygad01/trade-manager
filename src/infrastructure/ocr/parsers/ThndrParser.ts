import type { ParsedDividendCandidate, ParsedOrderEvidence, ParsedTradeCandidate, ParseConfidence } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { COMPANY_NAME_ALIASES, KNOWN_EGX_TICKERS, NON_STOCK_INSTRUMENTS } from "@domain/value-objects/knownTickers";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { BrokerParser, OrderRowText, OrderRowsParseResult, OrdersScreenParseResult, OrdersTimelineParseResult } from "./BrokerParser";
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
  // "/", "-" and "." are all seen as date separators depending on the
  // statement's export locale and how OCR renders the glyph.
  const clean = str.replace(/[/.]/g, "-");
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
// The qty/price/value groups additionally accept "O"/"o" (misread "0") and
// "l"/"I" (misread "1") — but only inside those numeric groups, where context
// already guarantees the characters are digits; repairStatementNumber() maps
// them back before parsing. The date keeps strict digits ("." joins "/" and
// "-" as an accepted separator), and the company-name group is untouched.
const statementRowPattern =
  /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\s+(Buy|Sell|شراء|بيع)\s+(.{1,80}?)\s*[({[]\s*([\dOoIl,]+(?:\.[\dOoIl]+)?)\s*@\s*([\dOoIl,]+(?:\.[\dOoIl]+)?)\s*(?:EGP\s*)?[)}\]](?:\s*(-?[\dOoIl,]+(?:\.[\dOoIl]+)?))?/gi;

// Numeric-group-only OCR repair for statement rows: O/o → 0, l/I → 1, then
// strip thousands separators. Never applied to free text — only to regex
// groups whose position (inside "qty@price" / the Value column) proves they
// are numbers. A token made purely of repairable letters (e.g. "OI") is
// rejected outright — a real OCR'd number always retains at least one true
// digit, so requiring one keeps letter-only noise from becoming a value.
function repairStatementNumber(raw: string | undefined): number {
  if (!raw || !/\d/.test(raw)) return NaN;
  return parseFloat(raw.replace(/[Oo]/g, "0").replace(/[Il]/g, "1").replace(/,/g, ""));
}

function parseStatementTextImpl(text: string): ParsedTradeCandidate[] {
  const candidates: ParsedTradeCandidate[] = [];
  // Match across the whole document rather than line-by-line: text extracted
  // from a PDF or via OCR doesn't reliably put one transaction per line.
  const normalized = text.replace(/\s+/g, " ");

  for (const m of normalized.matchAll(statementRowPattern)) {
    const [, dateStr, typeStr, rawDescription, qtyStr, priceStr, valueStr] = m;

    // "Sell T+1 Ibn sina farma" / "Buy Same Day TMG Holding": T+1 and
    // Same Day are settlement qualifiers printed between the side and the
    // company name, not part of the name — left in, they fabricate bogus
    // ticker groups like "T+1 EGYPT GAS" or "SAME DAY TMG HOLDING".
    const description = rawDescription.replace(/^(?:T\s*\+\s*1|Same\s*Day)\s+/i, "");

    if (NON_STOCK_INSTRUMENTS.has(normalizeCompanyKey(description))) continue;

    const shares = repairStatementNumber(qtyStr);
    let price = repairStatementNumber(priceStr);
    if (!shares || !price || Number.isNaN(shares) || Number.isNaN(price)) continue;

    // The printed per-share price doesn't include brokerage commission, but
    // the actual amount debited/credited (the Value column) does — e.g. a
    // statement row "Buy Arabian Cement (42@47.4700) -1,999.23" actually
    // costs 1,999.23, not 42 * 47.47 = 1,993.74. Deriving an effective
    // per-share price from Value keeps shares * price (used everywhere
    // downstream) equal to what was actually paid/received.
    //
    // Cross-validation guard: commission is small (well under 1%), so the
    // Value-derived price must land close to the printed qty@price. If it
    // deviates by more than 25%, the Value column itself was misread (lost
    // digit, swallowed neighbouring text) — keep the printed price rather
    // than let one bad OCR field corrupt an otherwise-good row.
    if (valueStr) {
      const value = Math.abs(repairStatementNumber(valueStr));
      if (value > 0) {
        const derived = value / shares;
        if (Math.abs(derived - price) / price <= 0.25) price = derived;
      }
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
      source: "statement",
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

  // "/", "-" and "." all appear as invoice date separators across export
  // locales and PDF text-layer variations.
  const dateMatch = normalized.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
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
  let price = parseFloat(totalsMatch[2].replace(/,/g, ""));
  const totalCost = parseFloat(totalsMatch[3].replace(/,/g, ""));
  if (!shares) return [];

  const feesMatch = normalized.match(/Total Fees\s+([\d,]+(?:\.\d+)?)\s*EGP/i);
  const fees = feesMatch ? parseFloat(feesMatch[1].replace(/,/g, "")) : 0;

  // Context recovery: if the Average Price cell was misread (zero/garbage)
  // but Total Quantity and Total Cost survived, the price is fully
  // determined by them — recompute instead of dropping the transaction.
  // On these invoices Total Cost = shares × average price (fees are listed
  // separately and only join in "Grand Total"), so no fee adjustment here.
  if (!price && totalCost > 0) {
    const derived = totalCost / shares;
    if (derived > 0) price = derived;
  }
  if (!price) return [];

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
      source: "invoice",
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
      source: "orders-screen",
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
      source: "orders-screen",
    });
  }

  // statusCountMismatch is structurally impossible here (each row carries
  // its own status), hence always false on this path.
  return { candidates, incompleteRowCount, fulfilledStatusCount, statusCountMismatch: false, resolvedRowCount };
}

// ─── Format 2c: account-wide "Orders" timeline screen (screenshot) ─────────
// The broker's full-account order history (title "Orders", tabs
// All/Pending/Completed/Cancelled — also the per-stock "Completed Orders"
// tab, which renders identical rows). Every row carries the REAL ticker code
// (not a company name), "Buy/Sell Limit/Market @<price>", the order's total
// value, and a Fulfilled/Cancelled status — but no execution date and no
// printed share count. Undated rows can never become trade candidates
// (nothing downstream can place them on the timeline); they're parsed as
// ParsedOrderEvidence instead: broker-authored corroboration for
// transactions extracted from dated documents, and a way to spot a
// transaction misfiled under a wrong ticker guess (the row's real code is
// printed right on it). Shares are derived from totalValue / price — a real
// row always lands on a whole number of shares, which doubles as the
// self-check that the total picked out of the OCR text actually belongs to
// this row and not a neighboring number.
const timelineAnchorPattern = /\b(Buy|Sell)\s+(Limit|Market)\s*@?\s*([\d,]+(?:\.\d+)?)/gi;
const timelineStatusPattern = /\b(Fulf\w*|Cancel\w*|Pending|Rejected|Expired)\b/i;
const timelineTickerPattern = /\b[A-Z]{4}\b/g;

const KNOWN_TICKER_SET = new Set(KNOWN_EGX_TICKERS.map((t) => t.ticker));

// The screen's own header ("Total Value (EGP) 44,462 +5,796.31 (14.99%)")
// is full of numbers that must never be mistaken for a row's total: signed
// deltas, percentages, and comma-grouped integers without decimals. A row
// total is always rendered with exactly 2 decimals and no sign/percent.
function timelineMoneyTokens(segment: string): number[] {
  const tokens: number[] = [];
  for (const m of segment.matchAll(/([+\-]?)([\d,]+\.\d{2})(%?)/g)) {
    if (m[1] || m[3]) continue;
    tokens.push(parseFloat(m[2].replace(/,/g, "")));
  }
  return tokens;
}

/** totalValue / price only counts as this row's share count when it lands on a whole number — the self-check against picking a neighboring number as the total. */
function deriveWholeShares(total: number, price: number): number | null {
  if (!total || !price) return null;
  const shares = total / price;
  const rounded = Math.round(shares);
  if (rounded < 1 || Math.abs(shares - rounded) > 0.03) return null;
  return rounded;
}

function looksLikeOrdersTimelineImpl(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ");
  const anchors = [...normalized.matchAll(timelineAnchorPattern)];
  if (anchors.length >= 2) return true;
  return anchors.length === 1 && /\borders\b/i.test(normalized);
}

function parseOrdersTimelineTextImpl(text: string): OrdersTimelineParseResult {
  const evidences: ParsedOrderEvidence[] = [];
  let unreadRowCount = 0;
  const normalized = text.replace(/\s+/g, " ");
  const anchors = [...normalized.matchAll(timelineAnchorPattern)];

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const anchorStart = anchor.index ?? 0;
    const anchorEnd = anchorStart + anchor[0].length;
    const prevEnd = i > 0 ? (anchors[i - 1].index ?? 0) + anchors[i - 1][0].length : 0;
    const nextStart = i + 1 < anchors.length ? anchors[i + 1].index ?? normalized.length : normalized.length;

    // Everything between the previous row's "@price" and this row's
    // "Buy/Sell" belongs to the boundary between the two rows: the previous
    // row's status, then this row's ticker and (usually) its total.
    const preWindow = normalized.slice(prevEnd, anchorStart);
    const postWindow = normalized.slice(anchorEnd, nextStart);

    const statusMatch = timelineStatusPattern.exec(postWindow);
    const statusWord = statusMatch?.[1] ?? null;
    if (!statusWord) {
      unreadRowCount += 1;
      continue;
    }
    if (!/^(fulf|cancel)/i.test(statusWord)) continue; // pending/rejected/expired: not evidence of anything
    const status: ParsedOrderEvidence["status"] = /^fulf/i.test(statusWord) ? "fulfilled" : "cancelled";

    const tickerTokens = (preWindow.match(timelineTickerPattern) ?? []).filter((t) => !NON_TICKER_WORDS.has(t));
    const ticker = tickerTokens.length > 0 ? tickerTokens[tickerTokens.length - 1] : null;
    if (!ticker || NON_STOCK_INSTRUMENTS.has(ticker)) {
      unreadRowCount += 1;
      continue;
    }

    const price = parsePrice(anchor[3]);
    // The total usually precedes the anchor (OCR reads the row's right
    // column together with its left), but some scans emit it after the
    // action line instead — accept either, cut off at this row's status so
    // the next row's total can never be picked up, and let the whole-share
    // self-check pick which candidate number is genuinely this row's total.
    const preStatusIdx = preWindow.search(timelineStatusPattern);
    const totalCandidates = [
      ...timelineMoneyTokens(preStatusIdx >= 0 ? preWindow.slice(preStatusIdx) : preWindow),
      ...timelineMoneyTokens(postWindow.slice(0, statusMatch?.index ?? 0)),
    ];
    let shares: number | null = null;
    let totalValue = 0;
    for (const candidate of totalCandidates) {
      const derived = deriveWholeShares(candidate, price);
      if (derived !== null) {
        shares = derived;
        totalValue = candidate;
        break;
      }
    }
    if (shares === null) {
      unreadRowCount += 1;
      continue;
    }

    evidences.push({
      ticker: normalizeTicker(ticker),
      companyName: canonicalNameForTicker(normalizeTicker(ticker)),
      side: /buy/i.test(anchor[1]) ? "BUY" : "SELL",
      orderType: /limit/i.test(anchor[2]) ? "limit" : "market",
      shares,
      price,
      totalValue,
      status,
      confidence: KNOWN_TICKER_SET.has(normalizeTicker(ticker)) ? "high" : "low",
    });
  }

  return { evidences, unreadRowCount };
}

// ─── Format 2d: account-wide "Transactions" screen (screenshot) ───────────
// A second, distinct account-wide history screen (title "Transactions",
// tabs Completed/Pending/Cancelled). Unlike Format 2c's "Orders" timeline,
// every row here DOES carry a real execution date + time — but, unlike the
// per-stock "Orders" screen (Format 2), it never prints a share count or a
// per-share price, only the real ticker code and the order's signed net
// total (negative for a Buy debit, positive for a Sell credit). Parsed as
// ParsedOrderEvidence with `date` set (see that interface's doc comment) so
// it corroborates a pending candidate on ticker/side/date/total-value match
// instead of ticker/side/shares/price — there is no way to recover a share
// count or price from a total alone. The screen doesn't print a per-row
// status word either (status is conveyed by which tab is selected, which
// plain OCR text can't distinguish) — every row this parses is treated as
// "fulfilled", matching the Completed tab this format is meant to be
// uploaded from.
const transactionsAnchorPattern = /\b(Buy|Sell)\s+([A-Z]{4})\b/g;
const transactionsAmountPattern = /([+-]?[\d,]+\.\d{2})/g;

function parseTransactionsScreenImpl(text: string): OrdersTimelineParseResult {
  const evidences: ParsedOrderEvidence[] = [];
  let unreadRowCount = 0;
  const normalized = text.replace(/\s+/g, " ");
  const anchors = [...normalized.matchAll(transactionsAnchorPattern)].filter(
    (m) => !NON_TICKER_WORDS.has(m[2]) && !NON_STOCK_INSTRUMENTS.has(m[2]),
  );

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const anchorEnd = (anchor.index ?? 0) + anchor[0].length;
    const nextStart = i + 1 < anchors.length ? (anchors[i + 1].index ?? normalized.length) : normalized.length;
    const window = normalized.slice(anchorEnd, nextStart);

    const dateMatch = [...window.matchAll(orderDateTimePattern)][0];
    const date = dateMatch ? parseShortDate(dateMatch[1]) : null;
    if (!date) {
      unreadRowCount += 1;
      continue;
    }

    // The total sits after the date/time in a genuine row; searching only
    // past the date match means a stray number earlier in the window (e.g.
    // the previous row's trailing digits) can never be mistaken for it.
    const afterDate = window.slice((dateMatch.index ?? 0) + dateMatch[0].length);
    const amountMatch = [...afterDate.matchAll(transactionsAmountPattern)][0];
    const totalValue = amountMatch ? Math.abs(parseFloat(amountMatch[1].replace(/,/g, ""))) : 0;
    if (!totalValue) {
      unreadRowCount += 1;
      continue;
    }

    const ticker = normalizeTicker(anchor[2]);
    evidences.push({
      ticker,
      companyName: canonicalNameForTicker(ticker),
      side: /buy/i.test(anchor[1]) ? "BUY" : "SELL",
      date,
      time: normalizeTime(dateMatch[2]),
      totalValue,
      status: "fulfilled",
      confidence: KNOWN_TICKER_SET.has(ticker) ? "high" : "low",
    });
  }

  return { evidences, unreadRowCount };
}

// Actually parses the candidate rows (rather than just testing for anchors)
// so detection can't misfire on an unrelated document that happens to
// contain a stray "Buy/Sell <4 letters>" — the statement/invoice/Orders-
// screen formats never pair that shape with a day-month-year + AM/PM
// timestamp immediately after it, so a real parsed row is a much safer
// signal than the anchor alone.
function looksLikeTransactionsScreenImpl(text: string): boolean {
  const { evidences } = parseTransactionsScreenImpl(text);
  if (evidences.length === 0) return false;
  if (evidences.length >= 2) return true;
  return /\btransactions\b/i.test(text);
}

// ─── Format 2e: single "Order Details" screen (screenshot) ────────────────
// Tapping a row in the Orders/Transactions history opens a per-order detail
// page: a label/value list ("Order State: Fulfilled", "Date and Time",
// "Order Type: Market Buy", "Price EGP 36.83", "Estimated Quantity: 5
// Shares", "Expiry type") with the company header at the top. It documents
// exactly one order, with shares AND price — richer than a Transactions row
// — but its timestamp omits the year ("Sun 14 Jul 11:53 AM"), so it can't
// become a dated trade candidate. Parsed as a single undated
// ParsedOrderEvidence, corroborating a pending candidate on
// ticker/side/shares/price like the Orders-timeline shape does.
const orderDetailsStatePattern = /order\s*state\W*\s*(Fulf\w*|Cancel\w*|Pending|Rejected|Expired)/i;
const orderDetailsTypePattern = /order\s*type\W*\s*(Market|Limit)\s*(Buy|Sell)/i;
const orderDetailsPricePattern = /\bprice\b\W*\s*(?:EGP|EGX|E£)?\s*([\d,OoTIl]+(?:[.,]\d+)?)/i;
const orderDetailsQtyPattern = /quantity\W*\s*([\d,OoTIl]+(?:\.\d+)?)\s*shares?/i;

function looksLikeOrderDetailsImpl(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ");
  return (
    orderDetailsStatePattern.test(normalized) &&
    orderDetailsTypePattern.test(normalized) &&
    (orderDetailsQtyPattern.test(normalized) || /expiry\s*type/i.test(normalized))
  );
}

function parseOrderDetailsImpl(text: string): OrdersTimelineParseResult {
  const normalized = text.replace(/\s+/g, " ");

  const stateMatch = orderDetailsStatePattern.exec(normalized);
  const statusWord = stateMatch?.[1] ?? null;
  // Pending/rejected/expired detail pages document an order that never
  // executed — they are not evidence of anything, same as timeline rows.
  if (!statusWord || !/^(fulf|cancel)/i.test(statusWord)) return { evidences: [], unreadRowCount: 0 };
  const status: ParsedOrderEvidence["status"] = /^fulf/i.test(statusWord) ? "fulfilled" : "cancelled";

  const typeMatch = orderDetailsTypePattern.exec(normalized);
  const header = resolveHeaderTickerImpl(text);
  if (!typeMatch || !header || NON_STOCK_INSTRUMENTS.has(header.ticker.toUpperCase())) {
    return { evidences: [], unreadRowCount: 1 };
  }

  // Field order on the page is fixed (State → Date → Market → Order Type →
  // Price → Quantity → Expiry), so anchoring the price/quantity search to
  // the text AFTER "Order Type" guarantees the page's own "Price" label is
  // read — never an unrelated one like a header's "Last trade price".
  const afterType = normalized.slice(typeMatch.index + typeMatch[0].length);
  const priceMatch = orderDetailsPricePattern.exec(afterType);
  const qtyMatch = orderDetailsQtyPattern.exec(afterType);
  if (!priceMatch || !qtyMatch) return { evidences: [], unreadRowCount: 1 };

  const price = parsePrice(priceMatch[1]);
  // Quantity is a whole-share count, not a price: strip OCR digit noise and
  // grouping commas, then parse directly — parsePrice would misread "1,000"
  // shares as 1.000. Reject fractions and zero.
  const qtyRaw = parseFloat(normalizeDigits(qtyMatch[1]).replace(/,/g, ""));
  const shares = Number.isFinite(qtyRaw) && qtyRaw >= 1 && Math.abs(qtyRaw - Math.round(qtyRaw)) < 1e-9 ? Math.round(qtyRaw) : null;
  if (!price || shares === null) return { evidences: [], unreadRowCount: 1 };

  const ticker = normalizeTicker(header.ticker);
  return {
    evidences: [
      {
        ticker,
        companyName: canonicalNameForTicker(ticker),
        side: /buy/i.test(typeMatch[2]) ? "BUY" : "SELL",
        orderType: /limit/i.test(typeMatch[1]) ? "limit" : "market",
        shares,
        price,
        totalValue: Math.round(shares * price * 100) / 100,
        status,
        confidence: KNOWN_TICKER_SET.has(ticker) ? "high" : "low",
      },
    ],
    unreadRowCount: 0,
  };
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
  // Left undefined by default so the cutoff is resolved fresh on every call
  // (via defaultTrackedSince()) rather than frozen at construction time —
  // the ImportOrchestrator's parser instances are memoized, and the tracking
  // start date can change later from the Import page's start-date picker.
  private readonly trackedSinceOverride?: string;

  constructor(trackedSince?: string) {
    this.trackedSinceOverride = trackedSince;
  }

  /** True for dates on/after the configured cutoff and not more than one day in the future. */
  isWithinTrackedRange(dateIso: string): boolean {
    return isWithinTrackedRange(dateIso, this.trackedSinceOverride ?? defaultTrackedSince());
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

  looksLikeOrdersTimeline(text: string): boolean {
    return looksLikeOrdersTimelineImpl(text) || looksLikeTransactionsScreenImpl(text) || looksLikeOrderDetailsImpl(text);
  }

  // No tracked-date-range filter here: the undated "Orders" timeline shape
  // carries no date at all, which is exactly why it's evidence rather than
  // trade candidates; the dated "Transactions" list shape does have real
  // dates, but an out-of-range evidence row simply never matches any pending
  // candidate (which already went through the filter on its own parse path),
  // so filtering it here would only be redundant, not protective.
  parseOrdersTimeline(text: string): OrdersTimelineParseResult {
    // Order-details is checked first: its label/value layout ("Order Type
    // Market Buy … Price EGP …") can superficially satisfy the timeline
    // anchor regex, but a timeline parse of it would misread the fields.
    if (looksLikeOrderDetailsImpl(text)) return parseOrderDetailsImpl(text);
    return looksLikeOrdersTimelineImpl(text) ? parseOrdersTimelineTextImpl(text) : parseTransactionsScreenImpl(text);
  }

  parsePositionVerification(text: string): Omit<PositionVerification, "id" | "portfolioId">[] {
    const result = parsePositionVerificationTextImpl(text);
    return result ? [result] : [];
  }

  parseDividends(text: string): ParsedDividendCandidate[] {
    const header = resolveHeaderTickerImpl(text);
    if (!header) return [];
    const raw = parseDividendsTextImpl(text, header.ticker);
    const { inRange } = partitionByRange(raw, (d) => this.isWithinTrackedRange(d));
    return inRange;
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

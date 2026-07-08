import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";

export type DuplicateMatchType = "exact" | "possible";

export interface DuplicateMatch {
  matchType: DuplicateMatchType;
  matchedId: string;
  /** The already-recorded price this candidate matched against — lets callers judge how far apart a "possible" match's prices really are (see pricesWithinOcrNoise). */
  matchedPrice: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Two reads of the same real execution rarely carry bit-identical prices:
 * one document derives price from total value (commission-inclusive), the
 * other prints the raw execution price, or OCR drops a trailing decimal.
 * Both reads still land within a hair of each other — while two genuinely
 * different same-day trades of the same share count would normally differ
 * more. 1% relative tolerance is the discriminator the wrong-ticker check
 * already trusts at 10%; kept much tighter here because this one gates
 * silent auto-skips, not just a badge.
 */
export function pricesWithinOcrNoise(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * 0.01;
}

/**
 * When both sides carry a broker-assigned transaction number (currently only
 * Thndr's Invoice format prints one — see ParsedTradeCandidate.transactionNumber),
 * it settles "same real execution?" decisively, without relying on
 * date/shares/price ever having been read consistently: an exact string
 * match is certainly the same order, and a defined mismatch is certainly a
 * DIFFERENT one — even if every other field happens to coincide (e.g. two
 * genuinely separate same-day, same-share-count buys of the same stock at a
 * similar price, which the heuristic-only checks below can't tell apart).
 * Returns undefined — "inconclusive, fall back to the heuristic" — whenever
 * either side lacks one.
 */
export function sameExecution(a?: string, b?: string): boolean | undefined {
  if (!a || !b) return undefined;
  return a === b;
}

/**
 * A parsed candidate can look like a duplicate of a trade already on the
 * ledger in two ways: an "exact" match (same ticker/date/shares/price — the
 * same file or an overlapping statement re-imported), or a "possible" match
 * (same ticker/date/shares but a different price — the same real trade
 * parsed from two different document formats, one commission-inclusive, one
 * not; see ThndrParser's price-from-value derivation). Never auto-skip
 * either case — this only flags it for the user to decide.
 *
 * A candidate/existing-row transaction-number match short-circuits straight
 * to "exact" regardless of date/shares/price (see sameExecution); a
 * transaction-number MISMATCH removes that row from consideration entirely,
 * even when its date/shares/price would otherwise look like a match.
 */
function findMatch(
  candidate: { ticker: string; date: string; shares: number; transactionNumber?: string },
  candidatePrice: number,
  existing: { id: string; ticker: string; date: string; shares: number; price: number; transactionNumber?: string }[]
): DuplicateMatch | undefined {
  const ticker = normalizeTicker(candidate.ticker);
  const sameTicker = existing.filter((e) => normalizeTicker(e.ticker) === ticker);

  if (candidate.transactionNumber) {
    const byId = sameTicker.find((e) => sameExecution(e.transactionNumber, candidate.transactionNumber));
    if (byId) return { matchType: "exact", matchedId: byId.id, matchedPrice: byId.price };
  }

  const looseMatches = sameTicker.filter((e) => e.date === candidate.date && e.shares === candidate.shares);
  const eligible = candidate.transactionNumber
    ? looseMatches.filter((e) => sameExecution(e.transactionNumber, candidate.transactionNumber) !== false)
    : looseMatches;
  if (eligible.length === 0) return undefined;

  const exact = eligible.find((e) => round4(e.price) === round4(candidatePrice));
  if (exact) return { matchType: "exact", matchedId: exact.id, matchedPrice: exact.price };

  // Report the closest-priced loose match, not whichever row happens to come
  // first — callers judge "same real trade?" by how far the prices sit apart
  // (pricesWithinOcrNoise), so the decision must be deterministic and made
  // against the best candidate, independent of DB row order.
  const closest = [...eligible].sort(
    (a, b) => Math.abs(a.price - candidatePrice) - Math.abs(b.price - candidatePrice)
  )[0];
  return { matchType: "possible", matchedId: closest.id, matchedPrice: closest.price };
}

export function findDuplicateBuyMatch(candidate: ParsedTradeCandidate, existingTrades: Trade[]): DuplicateMatch | undefined {
  return findMatch(
    { ticker: candidate.ticker, date: candidate.date, shares: candidate.shares, transactionNumber: candidate.transactionNumber },
    candidate.price,
    existingTrades.map((t) => ({
      id: t.id,
      ticker: t.ticker,
      date: t.executionDate,
      shares: t.shares,
      price: t.entryPrice,
      transactionNumber: t.transactionNumber,
    }))
  );
}

/**
 * One real sell order allocated across several buy lots is stored as several
 * TradeAllocation rows (e.g. a 45-share sell closed against a 30-lot and a
 * 15-lot) that share one `sellGroupId`. Matching the candidate against
 * individual rows would never find a 45-share allocation — so the same sell
 * re-imported keeps looking "new" forever. Aggregate rows by their sell
 * order's identity (sellGroupId, guarded by ticker+date) and match the
 * candidate against each order's total shares; two distinct sell orders that
 * happen to share date and price are never merged into a false duplicate.
 */
export function findDuplicateSellMatch(
  candidate: ParsedTradeCandidate,
  existingAllocations: TradeAllocation[]
): DuplicateMatch | undefined {
  const ticker = normalizeTicker(candidate.ticker);
  // Grouped by ticker only (not date) — the transaction-number identity
  // check below must be able to find a match even if one side's date was
  // misread; the date requirement is applied afterward, only on the path
  // that falls back to the date/shares heuristic.
  const groups = new Map<string, { id: string; price: number; totalShares: number; date: string; transactionNumber?: string }>();
  for (const a of existingAllocations) {
    if (normalizeTicker(a.ticker) !== ticker) continue;
    // sellGroupId identifies one real sell order regardless of how many lots
    // it was allocated across. Legacy rows recorded before sellGroupId existed
    // must be re-unified by date+exact price, or a 39-share sell split 24+15
    // across two lots would never sum back to 39 and the re-imported candidate
    // would sit pending forever against a fully-consumed position.
    const key = a.sellGroupId || `legacy:${a.executionDate}|${round4(a.exitPrice)}`;
    const g = groups.get(key);
    if (g) {
      g.totalShares += a.sharesClosed;
    } else {
      groups.set(key, { id: a.id, price: a.exitPrice, totalShares: a.sharesClosed, date: a.executionDate, transactionNumber: a.transactionNumber });
    }
  }

  if (candidate.transactionNumber) {
    const byId = [...groups.values()].find((g) => sameExecution(g.transactionNumber, candidate.transactionNumber));
    if (byId) return { matchType: "exact", matchedId: byId.id, matchedPrice: byId.price };
  }

  const looseMatches = [...groups.values()].filter((g) => g.date === candidate.date && g.totalShares === candidate.shares);
  const matching = candidate.transactionNumber
    ? looseMatches.filter((g) => sameExecution(g.transactionNumber, candidate.transactionNumber) !== false)
    : looseMatches;
  if (matching.length === 0) return undefined;

  const exact = matching.find((g) => round4(g.price) === round4(candidate.price));
  if (exact) return { matchType: "exact", matchedId: exact.id, matchedPrice: exact.price };

  // Closest-priced sell order, for the same reason as findMatch above.
  const closest = [...matching].sort(
    (a, b) => Math.abs(a.price - candidate.price) - Math.abs(b.price - candidate.price)
  )[0];
  return { matchType: "possible", matchedId: closest.id, matchedPrice: closest.price };
}

/**
 * A dividend candidate has no in-app identity of its own to dedupe against
 * (unlike a Buy/Sell, whose ticker+date+shares+price already distinguishes
 * one execution from another) — the same broker statement re-uploaded
 * weeks later, with its dividend history overlapping what's already
 * recorded, would otherwise silently double-count real cash every time.
 * Global across portfolios, like findDuplicateBuyMatch — a real dividend
 * payment happened once regardless of which portfolio it's filed under.
 */
export function dividendContentKey(d: { ticker: string; date: string; amount: number }): string {
  return `${normalizeTicker(d.ticker)}|${d.date}|${d.amount}`;
}

export function buildExistingDividendKeys(events: TimelineEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type !== "Dividend" || !e.ticker || e.amount === undefined) continue;
    keys.add(dividendContentKey({ ticker: e.ticker, date: e.timestamp.slice(0, 10), amount: e.amount }));
  }
  return keys;
}

export function isDividendAlreadyRecorded(
  dividend: { ticker: string; date: string; amount: number },
  existingDividendKeys: Set<string>
): boolean {
  return existingDividendKeys.has(dividendContentKey(dividend));
}

/**
 * Within one Import batch, nothing dedupes a Buy/Sell candidate against its
 * own siblings the way processFiles already dedupes verifications and
 * dividends by content key — findDuplicateBuyMatch/findDuplicateSellMatch
 * only ever compare against trades already committed to the ledger. So the
 * same real transaction read more than once in one batch (an overlapping
 * multi-file drop, or a PDF page repeated) piles up as separate pending
 * rows, inflating the ticker's extracted share total past what the broker
 * screenshot shows — a mismatch with no candidate flagged as the cause and
 * no way to remove one before committing.
 *
 * Groups same-side candidates by ticker+date+shares (their scan of "how many
 * shares moved this day", independent of a possibly re-OCR'd price) and,
 * within each group of more than one, suggests keeping exactly one and
 * deleting the rest — applying the same price-priority rule the app already
 * uses for reconciling duplicate committed trades (suggestDuplicateTradeIds):
 * a Buy's higher-priced read is the more plausible one (commission-inclusive
 * OCR beats a rounded/partial read), so lower-priced Buy duplicates are
 * suggested for deletion; a Sell's lower-priced read is the more plausible
 * one, so higher-priced Sell duplicates are suggested instead.
 */
/** Same real transaction, independent of a possibly re-OCR'd price: same ticker+side+date+share count. Shared by the sibling-duplicate grouping below and the cross-source verification check in ImportPage. */
export function pendingCandidateSignature(candidate: { ticker: string; side: "BUY" | "SELL"; date: string; shares: number }): string {
  return `${normalizeTicker(candidate.ticker)}|${candidate.side}|${candidate.date}|${candidate.shares}`;
}

/**
 * Two reads of the SAME real execution land within a couple of percent of
 * each other (commission-inclusive vs raw execution price, or minor OCR
 * noise) — while two genuinely different same-day trades of the same share
 * count normally sit further apart. Slightly wider than pricesWithinOcrNoise
 * because cross-format reads legitimately differ by the commission itself.
 */
const SIBLING_DUPLICATE_PRICE_TOLERANCE = 0.02;

function siblingPricesClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * SIBLING_DUPLICATE_PRICE_TOLERANCE;
}

/**
 * The candidate-level counterpart to sameExecution: prefers a decisive
 * transaction-number verdict when both sides carry one, falling back to
 * price proximity only when that's inconclusive. This is what keeps two
 * genuinely DIFFERENT invoice-sourced trades that happen to share a
 * signature (same ticker+side+date+shares) and a similar price — a real,
 * if rare, scenario (two separate same-day orders) — from being silently
 * merged into one by the sibling/cross-document checks below.
 */
function sameCandidateExecution(a: ParsedTradeCandidate, b: ParsedTradeCandidate): boolean {
  const decisive = sameExecution(a.transactionNumber, b.transactionNumber);
  return decisive !== undefined ? decisive : siblingPricesClose(a.price, b.price);
}

/** Invoices are labeled, standardized PDFs — the most trustworthy read of a transaction when one exists in a duplicate group. */
function isInvoiceSourced(c: ParsedTradeCandidate): boolean {
  return c.source === "invoice";
}

export function suggestDuplicatePendingCandidateKeysToDelete(
  entries: { key: string; candidate: ParsedTradeCandidate }[]
): string[] {
  const bySignature = new Map<string, { key: string; candidate: ParsedTradeCandidate }[]>();
  for (const e of entries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = bySignature.get(sig) ?? [];
    list.push(e);
    bySignature.set(sig, list);
  }

  const keysToDelete: string[] = [];
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    const side = group[0].candidate.side;
    const sorted = [...group].sort((a, b) => {
      // An invoice-sourced read wins the survivor slot outright: its price
      // and fees come from labeled fields on a standardized PDF, not from
      // positional OCR guessing — only between two non-invoice reads does
      // the price-plausibility heuristic decide.
      const invoiceRank = Number(isInvoiceSourced(b.candidate)) - Number(isInvoiceSourced(a.candidate));
      if (invoiceRank !== 0) return invoiceRank;
      return side === "BUY" ? b.candidate.price - a.candidate.price : a.candidate.price - b.candidate.price;
    });
    const survivor = sorted[0];
    for (const e of sorted.slice(1)) {
      // Uncertain-match guard: a same-signature sibling whose price sits
      // clearly apart from the survivor's may be a genuinely different
      // trade (two distinct same-day orders of the same share count), not
      // a re-read. A false merge silently loses a real transaction; an
      // extra pending row just waits for the user — so when in doubt,
      // leave it pending instead of suggesting deletion.
      if (!sameCandidateExecution(e.candidate, survivor.candidate)) continue;
      keysToDelete.push(e.key);
    }
  }
  return keysToDelete;
}

/**
 * Cross-document field completion: when the same real transaction (same
 * signature, price within sibling tolerance) was read from more than one
 * document and one read carries a field the other misses — fees/taxes from
 * an invoice, execution time from an orders screenshot — copy the missing
 * field onto the read that lacks it instead of leaving the eventual
 * committed trade with a default. Strictly additive: an already-present
 * value is NEVER overwritten, and nothing is merged across reads whose
 * prices disagree (they may be different real trades). Returns only the
 * keys that gain at least one field.
 *
 * Also backfills transactionNumber: a statement row never prints one, but
 * when the same execution is also read from an invoice in the same batch,
 * the resulting committed Trade should still carry the invoice's ID —
 * otherwise a LATER re-import of just the statement (without the invoice
 * alongside it again) has nothing to match against but the price/date/shares
 * heuristic, throwing away the stronger signal this batch already had.
 */
export function completeCandidateFieldsFromSiblings(
  entries: { key: string; candidate: ParsedTradeCandidate }[]
): Map<string, Partial<Pick<ParsedTradeCandidate, "fees" | "taxes" | "time" | "transactionNumber">>> {
  const bySignature = new Map<string, { key: string; candidate: ParsedTradeCandidate }[]>();
  for (const e of entries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = bySignature.get(sig) ?? [];
    list.push(e);
    bySignature.set(sig, list);
  }

  const completions = new Map<string, Partial<Pick<ParsedTradeCandidate, "fees" | "taxes" | "time" | "transactionNumber">>>();
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    for (const target of group) {
      // A legacy untyped candidate (pre-source session) could be from any
      // document type — the same reason findCrossSourceVerifiedKeys never
      // pairs it with a typed non-invoice read. Don't auto-enrich it either.
      if (target.candidate.source === undefined) continue;
      const patch: Partial<Pick<ParsedTradeCandidate, "fees" | "taxes" | "time" | "transactionNumber">> = {};
      // Invoice-sourced donors first — labeled fields beat OCR-positional ones.
      const donors = group
        .filter(
          (d) =>
            d.key !== target.key &&
            d.candidate.source !== undefined &&
            d.candidate.source !== target.candidate.source &&
            sameCandidateExecution(d.candidate, target.candidate),
        )
        .sort((a, b) => Number(isInvoiceSourced(b.candidate)) - Number(isInvoiceSourced(a.candidate)));
      for (const donor of donors) {
        if (target.candidate.fees === undefined && donor.candidate.fees !== undefined && patch.fees === undefined)
          patch.fees = donor.candidate.fees;
        if (target.candidate.taxes === undefined && donor.candidate.taxes !== undefined && patch.taxes === undefined)
          patch.taxes = donor.candidate.taxes;
        if (target.candidate.time === undefined && donor.candidate.time !== undefined && patch.time === undefined)
          patch.time = donor.candidate.time;
        if (
          target.candidate.transactionNumber === undefined &&
          donor.candidate.transactionNumber !== undefined &&
          patch.transactionNumber === undefined
        )
          patch.transactionNumber = donor.candidate.transactionNumber;
      }
      if (Object.keys(patch).length > 0) completions.set(target.key, patch);
    }
  }
  return completions;
}

/**
 * The dual-source verification rule: the same real transaction (same
 * ticker+side+date+share count, ignoring price the same way the
 * sibling-duplicate check above does) read from TWO DIFFERENT document
 * types — statement + invoice, statement + orders screenshot, invoice +
 * orders screenshot, CSV export + anything, and so on — is independently
 * corroborated, and every candidate in such a group is flagged verified.
 * Which pair of types doesn't matter; that they're two independent
 * documents does. Two reads from the SAME type never pair (two overlapping
 * statements, two re-takes of one orders screen — that's a re-upload of
 * the same information, not independent confirmation), which is also why
 * this can't be fooled by the duplicate-file case. Resolves exactly what a
 * broker "My Position" total can't: a ticker whose extracted total won't
 * reconcile no matter how the individual rows are read, because the
 * mismatch is hiding inside rows that never got a second, independent
 * document to confirm them.
 *
 * A candidate extracted before ParsedTradeCandidate.source existed
 * (undefined source, still sitting in an old session) could be from any
 * screenshot type, so undefined never pairs with another undefined or with
 * a typed non-invoice source — only the original invoice+anything rule
 * still applies to it, exactly the behavior it had when it was extracted.
 *
 * This never decides which of the pair to keep for commit — that's still
 * suggestDuplicatePendingCandidateKeysToDelete's job (same signature, same
 * price-priority rule). It only flags that the transaction itself is
 * corroborated, for checkTickerMatch to treat as self-verified without a
 * broker screenshot.
 */
export function findCrossSourceVerifiedKeys(entries: { key: string; candidate: ParsedTradeCandidate }[]): Set<string> {
  const bySignature = new Map<string, { key: string; candidate: ParsedTradeCandidate }[]>();
  for (const e of entries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = bySignature.get(sig) ?? [];
    list.push(e);
    bySignature.set(sig, list);
  }

  const verifiedKeys = new Set<string>();
  for (const group of bySignature.values()) {
    const definedSources = new Set(group.map((e) => e.candidate.source).filter((s): s is NonNullable<typeof s> => s !== undefined));
    const hasLegacyUntyped = group.some((e) => e.candidate.source === undefined);
    const dualSourced = definedSources.size >= 2 || (definedSources.has("invoice") && hasLegacyUntyped);
    if (!dualSourced) continue;
    // Uncertain-match guard: sharing a signature is not enough — the two
    // documents must also agree on price (within the same tolerance the
    // sibling-duplicate check trusts). Two genuinely different same-day
    // trades of the same share count would otherwise "verify" each other,
    // and a false verification badge is worse than a row that waits for a
    // real corroborating document.
    for (const e of group) {
      const corroborated = group.some(
        (o) =>
          o.key !== e.key &&
          o.candidate.source !== e.candidate.source &&
          sameCandidateExecution(o.candidate, e.candidate),
      );
      if (corroborated) verifiedKeys.add(e.key);
    }
  }
  return verifiedKeys;
}

/**
 * The same physical execution read under two different guessed tickers keeps
 * its side, date, share count and (roughly) its price — only the ticker
 * differs. This is the one duplicate shape none of the checks above can see:
 * they all group within a ticker, so a low-confidence OCR read filed under
 * the wrong ticker (an unmapped company-name fallback, a fuzzy guess) shows
 * up as a phantom row inflating the wrong ticker's total while the real
 * transaction sits, committed or pending, under another name.
 *
 * The price-proximity requirement is the discriminator against coincidence:
 * two genuinely different stocks trading the same share count on the same
 * day would carry unrelated prices, while two OCR reads of the same
 * execution land within OCR noise of each other. A pending row is flagged
 * when a close-priced copy exists under a different ticker and that copy
 * outranks it — already committed to the ledger (and the pending read isn't
 * a high-confidence anchored match), or still pending but with strictly
 * higher OCR confidence. Returns pending key -> the ticker the row most
 * likely belongs to. Only ever a hint driving a badge + the existing manual
 * remove button — nothing is discarded without the user's click.
 */
const WRONG_TICKER_PRICE_TOLERANCE = 0.1;

function wrongTickerConfidenceRank(c?: ParsedTradeCandidate["confidence"]): number {
  if (c === "low") return 0;
  if (c === "medium") return 1;
  return 2;
}

export function findWrongTickerCandidateKeys(
  pendingEntries: { key: string; candidate: ParsedTradeCandidate }[],
  committedTrades: { ticker: string; executionDate: string; shares: number; entryPrice: number }[],
  committedAllocations: { ticker: string; executionDate: string; sharesClosed: number; exitPrice: number }[],
): Map<string, string> {
  const hints = new Map<string, string>();
  const pricesClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * WRONG_TICKER_PRICE_TOLERANCE;

  for (const e of pendingEntries) {
    const ticker = normalizeTicker(e.candidate.ticker);
    const c = e.candidate;

    if (wrongTickerConfidenceRank(c.confidence) < 2) {
      const committed =
        c.side === "BUY"
          ? committedTrades.find(
              (t) =>
                normalizeTicker(t.ticker) !== ticker &&
                t.executionDate === c.date &&
                t.shares === c.shares &&
                pricesClose(t.entryPrice, c.price),
            )
          : committedAllocations.find(
              (a) =>
                normalizeTicker(a.ticker) !== ticker &&
                a.executionDate === c.date &&
                a.sharesClosed === c.shares &&
                pricesClose(a.exitPrice, c.price),
            );
      if (committed) {
        hints.set(e.key, normalizeTicker(committed.ticker));
        continue;
      }
    }

    const betterPendingCopy = pendingEntries.find(
      (o) =>
        o.key !== e.key &&
        normalizeTicker(o.candidate.ticker) !== ticker &&
        o.candidate.side === c.side &&
        o.candidate.date === c.date &&
        o.candidate.shares === c.shares &&
        pricesClose(o.candidate.price, c.price) &&
        wrongTickerConfidenceRank(o.candidate.confidence) > wrongTickerConfidenceRank(c.confidence),
    );
    if (betterPendingCopy) hints.set(e.key, normalizeTicker(betterPendingCopy.candidate.ticker));
  }
  return hints;
}

/**
 * Finds Dividend events already sitting on the ledger that duplicate each
 * other — the cross-session import dedup (isDividendAlreadyRecorded) only
 * stops *new* duplicates; this is for the ones recorded before that guard
 * existed, or from a manual double-entry. Unlike a duplicate buy/sell (where
 * a price difference between the two reads makes one the more plausible
 * real transaction), two dividend events with the same ticker/date/amount
 * are, for all practical purposes, the same real payment recorded twice —
 * so it's safe to suggest deleting every one but the first in each group.
 */
export function suggestDuplicateDividendIdsToDelete(events: TimelineEvent[]): string[] {
  const byKey = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    if (e.type !== "Dividend" || !e.ticker || e.amount === undefined) continue;
    const key = dividendContentKey({ ticker: e.ticker, date: e.timestamp.slice(0, 10), amount: e.amount });
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }

  const idsToDelete: string[] = [];
  for (const list of byKey.values()) {
    for (const e of list.slice(1)) idsToDelete.push(e.id);
  }
  return idsToDelete;
}

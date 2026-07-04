import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";

export type DuplicateMatchType = "exact" | "possible";

export interface DuplicateMatch {
  matchType: DuplicateMatchType;
  matchedId: string;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * A parsed candidate can look like a duplicate of a trade already on the
 * ledger in two ways: an "exact" match (same ticker/date/shares/price — the
 * same file or an overlapping statement re-imported), or a "possible" match
 * (same ticker/date/shares but a different price — the same real trade
 * parsed from two different document formats, one commission-inclusive, one
 * not; see ThndrParser's price-from-value derivation). Never auto-skip
 * either case — this only flags it for the user to decide.
 */
function findMatch(
  candidate: { ticker: string; date: string; shares: number },
  candidatePrice: number,
  existing: { id: string; ticker: string; date: string; shares: number; price: number }[]
): DuplicateMatch | undefined {
  const ticker = normalizeTicker(candidate.ticker);
  const looseMatches = existing.filter(
    (e) => normalizeTicker(e.ticker) === ticker && e.date === candidate.date && e.shares === candidate.shares
  );
  if (looseMatches.length === 0) return undefined;

  const exact = looseMatches.find((e) => round4(e.price) === round4(candidatePrice));
  if (exact) return { matchType: "exact", matchedId: exact.id };

  return { matchType: "possible", matchedId: looseMatches[0].id };
}

export function findDuplicateBuyMatch(candidate: ParsedTradeCandidate, existingTrades: Trade[]): DuplicateMatch | undefined {
  return findMatch(
    { ticker: candidate.ticker, date: candidate.date, shares: candidate.shares },
    candidate.price,
    existingTrades.map((t) => ({ id: t.id, ticker: t.ticker, date: t.executionDate, shares: t.shares, price: t.entryPrice }))
  );
}

export function findDuplicateSellMatch(
  candidate: ParsedTradeCandidate,
  existingAllocations: TradeAllocation[]
): DuplicateMatch | undefined {
  return findMatch(
    { ticker: candidate.ticker, date: candidate.date, shares: candidate.shares },
    candidate.price,
    existingAllocations.map((a) => ({ id: a.id, ticker: a.ticker, date: a.executionDate, shares: a.sharesClosed, price: a.exitPrice }))
  );
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
    const sorted = [...group].sort((a, b) =>
      side === "BUY" ? b.candidate.price - a.candidate.price : a.candidate.price - b.candidate.price
    );
    for (const e of sorted.slice(1)) keysToDelete.push(e.key);
  }
  return keysToDelete;
}

/**
 * Finds every still-pending candidate cross-verified by an independent
 * second document: the same real transaction (same ticker+side+date+share
 * count, ignoring price the same way the sibling-duplicate check above
 * does) read once from a standardized Invoice and once from an OCR'd
 * screenshot/statement. Two independently-sourced documents agreeing on a
 * transaction is at least as trustworthy as an invoice alone (already
 * sufficient on its own — see ThndrParser's Invoice format), and resolves
 * exactly the case a broker "My Position" total can't: an OCR-only ticker
 * whose extracted total won't reconcile no matter how the individual rows
 * are read, because the mismatch is hiding inside rows that never got a
 * second, independent document to confirm them.
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
    const hasInvoice = group.some((e) => e.candidate.source === "invoice");
    const hasNonInvoice = group.some((e) => e.candidate.source !== "invoice");
    if (hasInvoice && hasNonInvoice) {
      for (const e of group) verifiedKeys.add(e.key);
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

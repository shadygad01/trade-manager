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

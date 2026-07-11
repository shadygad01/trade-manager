/**
 * A Trade is one Buy execution. It is immutable: ticker, shares, entryPrice,
 * fees, and execution date/time are recorded once and never edited or merged
 * with another trade. `remainingShares` is a derived snapshot (original shares
 * minus everything closed against it via TradeAllocation records) kept on the
 * entity for cheap reads, but the only legitimate writer of it is
 * TradeService — never edit it directly to "fix" a trade.
 */
export interface Trade {
  id: string;
  portfolioId: string;
  ticker: string;
  companyName?: string;
  /** Market sector/industry (e.g. "Banking", "Real Estate") — undefined when the ticker isn't in the known-sector map and no manual value was given; never fabricated to fill a chart (see sectorAllocation calculator). */
  sector?: string;
  shares: number;
  entryPrice: number;
  fees: number;
  /** Broker/exchange tax withheld on the buy, separate from `fees` for reporting — economically it adds to cost basis exactly like fees do. */
  taxes: number;
  executionDate: string;
  executionTime: string;
  remainingShares: number;
  notes?: string;
  strategyTags: string[];
  createdAt: string;
  /** Broker-assigned unique execution ID (e.g. Thndr's Invoice "Transaction No.") when the import that created this trade carried one — the most reliable signal for matching a later re-import against this exact trade (see duplicateDetection.ts's sameExecution). Undefined for manually-entered trades and for every import format that doesn't print one. */
  transactionNumber?: string;
  /**
   * @deprecated Unused by any current code path. An earlier design flagged a
   * partial-fill Trade "pending" here while it was already live on the
   * ledger — a real bug (it already affected Holdings/cost basis/cash and
   * was already allocatable before any invoice existed). Fixed by
   * `PendingExecution` (see its own doc comment): a partial-fill execution
   * is no longer a Trade at all until its invoice is confirmed, so this
   * field is never read or written by new code. Left in place, not removed,
   * only so a Trade written during the brief window the old code was live
   * still deserializes without error — it is never acted on.
   */
  confirmationStatus?: "pending" | "verified";
}

export function createTrade(input: {
  id: string;
  portfolioId: string;
  ticker: string;
  companyName?: string;
  sector?: string;
  shares: number;
  entryPrice: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime: string;
  notes?: string;
  strategyTags?: string[];
  transactionNumber?: string;
}): Trade {
  if (input.shares <= 0) {
    throw new Error("Trade.shares must be positive");
  }
  if (input.entryPrice <= 0) {
    throw new Error("Trade.entryPrice must be positive");
  }
  return {
    id: input.id,
    portfolioId: input.portfolioId,
    ticker: input.ticker,
    companyName: input.companyName,
    sector: input.sector,
    shares: input.shares,
    entryPrice: input.entryPrice,
    fees: input.fees ?? 0,
    taxes: input.taxes ?? 0,
    executionDate: input.executionDate,
    executionTime: input.executionTime,
    remainingShares: input.shares,
    notes: input.notes,
    strategyTags: input.strategyTags ?? [],
    createdAt: new Date().toISOString(),
    transactionNumber: input.transactionNumber,
  };
}

export function isOpen(trade: Trade): boolean {
  return trade.remainingShares > 0;
}

export type TradeStatus = "open" | "partial" | "closed";

/** "open" = untouched since the buy, "partial" = some shares closed but not all, "closed" = fully exited. */
export function getTradeStatus(trade: Trade): TradeStatus {
  if (trade.remainingShares <= 0) return "closed";
  if (trade.remainingShares < trade.shares) return "partial";
  return "open";
}

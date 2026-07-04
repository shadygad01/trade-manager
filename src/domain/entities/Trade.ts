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
}

export function createTrade(input: {
  id: string;
  portfolioId: string;
  ticker: string;
  companyName?: string;
  shares: number;
  entryPrice: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime: string;
  notes?: string;
  strategyTags?: string[];
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

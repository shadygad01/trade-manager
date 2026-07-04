export interface TradeAttachment {
  id: string;
  /** data URL or blob-store reference key; storage mechanism is an infrastructure concern. */
  ref: string;
  fileName: string;
  contentType: string;
  createdAt: string;
}

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
  shares: number;
  entryPrice: number;
  fees: number;
  executionDate: string;
  executionTime: string;
  remainingShares: number;
  notes?: string;
  screenshots: TradeAttachment[];
  attachments: TradeAttachment[];
  strategyTags: string[];
  createdAt: string;
}

export function createTrade(input: {
  id: string;
  portfolioId: string;
  ticker: string;
  shares: number;
  entryPrice: number;
  fees?: number;
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
    shares: input.shares,
    entryPrice: input.entryPrice,
    fees: input.fees ?? 0,
    executionDate: input.executionDate,
    executionTime: input.executionTime,
    remainingShares: input.shares,
    notes: input.notes,
    screenshots: [],
    attachments: [],
    strategyTags: input.strategyTags ?? [],
    createdAt: new Date().toISOString(),
  };
}

export function isOpen(trade: Trade): boolean {
  return trade.remainingShares > 0;
}

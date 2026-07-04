import type { Trade } from "./Trade";

/**
 * A TradeAllocation records closing part (or all) of one specific Trade lot.
 * Selling never assumes FIFO or average cost: the user explicitly picks which
 * open trade(s) a sell closes, and each trade gets its own allocation row.
 * A single sell action that spans multiple trades shares one `sellGroupId`
 * so the UI/timeline can present it as one event while P/L stays attributable
 * per-lot. Allocations, like trades, are never edited after creation —
 * reversing one is done by recording an offsetting correction, not mutation.
 */
export interface TradeAllocation {
  id: string;
  sellGroupId: string;
  portfolioId: string;
  tradeId: string;
  ticker: string;
  sharesClosed: number;
  exitPrice: number;
  fees: number;
  /** Broker/exchange tax withheld on the sell, separate from `fees` for reporting — economically it reduces net proceeds exactly like fees do. */
  taxes: number;
  executionDate: string;
  executionTime: string;
  notes?: string;
  exitReason?: string;
  createdAt: string;
}

export function createTradeAllocation(input: {
  id: string;
  sellGroupId: string;
  portfolioId: string;
  tradeId: string;
  ticker: string;
  sharesClosed: number;
  exitPrice: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime: string;
  notes?: string;
  exitReason?: string;
}): TradeAllocation {
  if (input.sharesClosed <= 0) {
    throw new Error("TradeAllocation.sharesClosed must be positive");
  }
  if (input.exitPrice <= 0) {
    throw new Error("TradeAllocation.exitPrice must be positive");
  }
  return {
    id: input.id,
    sellGroupId: input.sellGroupId,
    portfolioId: input.portfolioId,
    tradeId: input.tradeId,
    ticker: input.ticker,
    sharesClosed: input.sharesClosed,
    exitPrice: input.exitPrice,
    fees: input.fees ?? 0,
    taxes: input.taxes ?? 0,
    executionDate: input.executionDate,
    executionTime: input.executionTime,
    notes: input.notes,
    exitReason: input.exitReason,
    createdAt: new Date().toISOString(),
  };
}

/** Realized P/L for one allocation: proceeds net of fees+taxes, minus the closed lot's cost basis (entry price + pro-rated entry fee+taxes). */
export function realizedPnlMicros(
  allocation: TradeAllocation,
  trade: Pick<Trade, "shares" | "entryPrice" | "fees" | "taxes">
): number {
  const entryChargesPerShare = (trade.fees + trade.taxes) / trade.shares;
  const costBasisPerShare = trade.entryPrice + entryChargesPerShare;
  const proceedsPerShare = allocation.exitPrice - (allocation.fees + allocation.taxes) / allocation.sharesClosed;
  return Math.round((proceedsPerShare - costBasisPerShare) * allocation.sharesClosed * 1_000_000);
}

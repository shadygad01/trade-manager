import { isOpen, type Trade } from "@domain/entities/Trade";
import { realizedPnlMicros, type TradeAllocation } from "@domain/entities/TradeAllocation";
import { Money } from "@domain/value-objects/Money";
import { normalizeTicker } from "@domain/value-objects/Ticker";

export function realizedPnlMicrosForAllocations(allocations: TradeAllocation[], trades: Trade[]): number[] {
  const tradesById = new Map(trades.map((t) => [t.id, t]));
  return allocations.map((allocation) => {
    const trade = tradesById.get(allocation.tradeId);
    if (!trade) {
      throw new Error(`Trade not found for allocation ${allocation.id}: ${allocation.tradeId}`);
    }
    return realizedPnlMicros(allocation, trade);
  });
}

/** Pro-rated cost basis (in micros) of the specific shares one allocation closed — the denominator behind realizedReturnPctForAllocations, exposed separately for callers that need to weight several allocations together (e.g. a total return % across a whole strategy tag). */
export function costBasisMicrosForAllocations(allocations: TradeAllocation[], trades: Trade[]): number[] {
  const tradesById = new Map(trades.map((t) => [t.id, t]));
  return allocations.map((allocation) => {
    const trade = tradesById.get(allocation.tradeId);
    if (!trade) {
      throw new Error(`Trade not found for allocation ${allocation.id}: ${allocation.tradeId}`);
    }
    const costBasisPerShare = trade.entryPrice + (trade.fees + trade.taxes) / trade.shares;
    return Math.round(costBasisPerShare * allocation.sharesClosed * 1_000_000);
  });
}

/** Per-allocation realized return, as % of that lot's own cost basis (entry price + pro-rated entry fees/taxes) — the same win/loss sign as realizedPnlMicros, just normalized by position size instead of expressed in money. */
export function realizedReturnPctForAllocations(allocations: TradeAllocation[], trades: Trade[]): number[] {
  const tradesById = new Map(trades.map((t) => [t.id, t]));
  return allocations.map((allocation) => {
    const trade = tradesById.get(allocation.tradeId);
    if (!trade) {
      throw new Error(`Trade not found for allocation ${allocation.id}: ${allocation.tradeId}`);
    }
    const costBasisPerShare = trade.entryPrice + (trade.fees + trade.taxes) / trade.shares;
    const proceedsPerShare = allocation.exitPrice - (allocation.fees + allocation.taxes) / allocation.sharesClosed;
    return ((proceedsPerShare - costBasisPerShare) / costBasisPerShare) * 100;
  });
}

export interface OpenPositionsSummary {
  costBasis: number;
  marketValue: number;
}

/** Tickers absent from `priceMap` are excluded from `marketValue` rather than priced at zero, so a stale/missing feed understates rather than corrupts the total — see PriceRepository's documented limitation. */
export function summarizeOpenPositions(trades: Trade[], priceMap: Record<string, number>): OpenPositionsSummary {
  let costBasis = Money.zero();
  let marketValue = Money.zero();
  for (const trade of trades.filter(isOpen)) {
    const tradeCostBasis = Money.from(trade.entryPrice * trade.shares + trade.fees + trade.taxes).multiply(
      trade.remainingShares / trade.shares
    );
    costBasis = costBasis.add(tradeCostBasis);
    const price = priceMap[normalizeTicker(trade.ticker)];
    if (price !== undefined) {
      marketValue = marketValue.add(Money.from(trade.remainingShares * price));
    }
  }
  return { costBasis: costBasis.toNumber(), marketValue: marketValue.toNumber() };
}

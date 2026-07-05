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

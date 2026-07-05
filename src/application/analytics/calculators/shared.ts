import { isOpen, type Trade } from "@domain/entities/Trade";
import { realizedPnlMicros, type TradeAllocation } from "@domain/entities/TradeAllocation";
import { Money } from "@domain/value-objects/Money";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { EquityPoint } from "./equityCurve";

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

export interface PeriodReturn {
  period: string;
  startEquity: number;
  endEquity: number;
  returnPct: number;
}

/**
 * Buckets an equity curve by a date-string prefix ("2026-03" for months,
 * "2026" for years) and reports the % change from each bucket's first to
 * last point — excluding any net Deposit/Withdrawal that landed during the
 * bucket from the gain itself (see EquityPoint.contributed), so depositing
 * new cash never reads as a fake "return" just because equity jumped. A
 * point built without `contributed` (an older hand-built fixture) defaults
 * to 0 flow, leaving its bucket's math identical to the pre-flow-adjustment
 * behavior.
 */
export function bucketReturns(equityCurve: EquityPoint[], periodKeyLength: number): PeriodReturn[] {
  const buckets = new Map<string, EquityPoint[]>();
  for (const point of [...equityCurve].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = point.date.slice(0, periodKeyLength);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(point);
    } else {
      buckets.set(key, [point]);
    }
  }

  const results: PeriodReturn[] = [];
  for (const [period, points] of buckets) {
    const startEquity = points[0].equity;
    const endEquity = points[points.length - 1].equity;
    const netFlow = (points[points.length - 1].contributed ?? 0) - (points[0].contributed ?? 0);
    const gain = endEquity - startEquity - netFlow;
    const returnPct = startEquity !== 0 ? (gain / Math.abs(startEquity)) * 100 : 0;
    results.push({ period, startEquity, endEquity, returnPct });
  }
  return results;
}

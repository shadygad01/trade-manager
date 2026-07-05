import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import { realizedPnlMicros } from "@domain/entities/TradeAllocation";

export interface PerformancePoint {
  date: string;
  /** Cumulative realized P/L so far, as % of net contributed capital (deposits − withdrawals) at that point. */
  realizedReturnPct: number;
  /** Cumulative dividends received so far, as % of net contributed capital at that point. */
  dividendReturnPct: number;
}

export interface PerformancePeriod {
  period: string;
  realizedReturnPct: number;
  dividendReturnPct: number;
}

interface DatedDelta {
  date: string;
  realizedPnl?: number;
  dividend?: number;
  contribution?: number;
}

/**
 * Every dated, fully-known event this module cares about — deliberately
 * nothing from raw cash flow (Buy/Sell amounts, the portfolio's running cash
 * balance). A Buy converting cash into stock isn't a gain or loss and a Sell's
 * cash-in isn't purely a gain either (it also returns the original cost) —
 * `realizedPnlMicros` already isolates the one number that actually is a
 * gain/loss for a closed lot. Nothing here ever needs a historical price feed
 * (unlike mark-to-market), so there's no "we suddenly know the real value"
 * jump the way a cash+market-value equity curve has at its last point.
 */
function datedDeltas(trades: Trade[], allocations: TradeAllocation[], timelineEvents: TimelineEvent[]): DatedDelta[] {
  const tradesById = new Map(trades.map((t) => [t.id, t]));
  const deltas: DatedDelta[] = [];

  for (const allocation of allocations) {
    const trade = tradesById.get(allocation.tradeId);
    if (!trade) continue;
    deltas.push({
      date: `${allocation.executionDate}T${allocation.executionTime}`,
      realizedPnl: realizedPnlMicros(allocation, trade) / 1_000_000,
    });
  }

  for (const event of timelineEvents) {
    if (event.type === "Dividend") {
      deltas.push({ date: event.timestamp, dividend: event.amount ?? 0 });
    } else if (event.type === "Deposit" || event.type === "Withdrawal") {
      deltas.push({ date: event.timestamp, contribution: event.amount ?? 0 });
    }
  }

  return deltas.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A cumulative {date, realizedReturnPct, dividendReturnPct} series — the
 * equity-curve replacement. Both percentages are relative to net contributed
 * capital (same denominator `portfolioReturn` already uses), so a deposit
 * landing partway through never reads as a gain: it only ever changes the
 * denominator, never the numerator. Extends to `today` with the
 * last-known cumulative values (never invents a new value for today — there's
 * nothing dated "today" to add unless a real event happened today).
 */
export function performanceCurve(
  trades: Trade[],
  allocations: TradeAllocation[],
  timelineEvents: TimelineEvent[],
  today: string = new Date().toISOString().slice(0, 10)
): PerformancePoint[] {
  const deltas = datedDeltas(trades, allocations, timelineEvents);

  let cumulativeRealized = 0;
  let cumulativeDividend = 0;
  let contributed = 0;
  const points: PerformancePoint[] = [];

  for (const delta of deltas) {
    if (delta.realizedPnl !== undefined) cumulativeRealized += delta.realizedPnl;
    if (delta.dividend !== undefined) cumulativeDividend += delta.dividend;
    if (delta.contribution !== undefined) contributed += delta.contribution;

    const basis = Math.abs(contributed);
    points.push({
      date: delta.date.slice(0, 10),
      realizedReturnPct: basis > 0 ? (cumulativeRealized / basis) * 100 : 0,
      dividendReturnPct: basis > 0 ? (cumulativeDividend / basis) * 100 : 0,
    });
  }

  if (points.length === 0 || points[points.length - 1].date !== today) {
    const basis = Math.abs(contributed);
    points.push({
      date: today,
      realizedReturnPct: basis > 0 ? (cumulativeRealized / basis) * 100 : 0,
      dividendReturnPct: basis > 0 ? (cumulativeDividend / basis) * 100 : 0,
    });
  }
  return points;
}

/**
 * Buckets by a date-string prefix ("2026-03" for months, "2026" for years):
 * each period's OWN realized P/L and dividends (not cumulative), as % of
 * whatever capital was already contributed *before* that period started —
 * the same "don't let new capital masquerade as a gain" rule as the
 * cumulative curve, applied per period instead of since-inception.
 */
export function bucketPerformance(
  trades: Trade[],
  allocations: TradeAllocation[],
  timelineEvents: TimelineEvent[],
  periodKeyLength: number
): PerformancePeriod[] {
  const deltas = datedDeltas(trades, allocations, timelineEvents);

  const buckets = new Map<string, { realizedPnl: number; dividends: number; contributedAtStart: number }>();
  let contributed = 0;
  for (const delta of deltas) {
    const period = delta.date.slice(0, periodKeyLength);
    if (!buckets.has(period)) {
      buckets.set(period, { realizedPnl: 0, dividends: 0, contributedAtStart: contributed });
    }
    const bucket = buckets.get(period)!;
    if (delta.realizedPnl !== undefined) bucket.realizedPnl += delta.realizedPnl;
    if (delta.dividend !== undefined) bucket.dividends += delta.dividend;
    if (delta.contribution !== undefined) contributed += delta.contribution;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, b]) => {
      const basis = Math.abs(b.contributedAtStart);
      return {
        period,
        realizedReturnPct: basis > 0 ? (b.realizedPnl / basis) * 100 : 0,
        dividendReturnPct: basis > 0 ? (b.dividends / basis) * 100 : 0,
      };
    });
}

/**
 * Max peak-to-trough decline (in percentage points) of cumulative realized +
 * dividend return, starting from a 0% baseline. Unlike the old equity-based
 * drawdown, this can never blow out to thousands of percent from a cash-flow
 * artifact (a withdrawal, a big buy) — every input here is a fully-realized,
 * dated gain/loss, never a cash movement that isn't actually a gain or loss.
 */
export function performanceDrawdown(curve: PerformancePoint[]): number {
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of curve) {
    const total = point.realizedReturnPct + point.dividendReturnPct;
    peak = Math.max(peak, total);
    maxDrawdown = Math.max(maxDrawdown, peak - total);
  }
  return maxDrawdown;
}

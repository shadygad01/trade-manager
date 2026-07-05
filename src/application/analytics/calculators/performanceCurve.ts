import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import { realizedPnlMicros } from "@domain/entities/TradeAllocation";

export interface PerformancePoint {
  date: string;
  /** Cumulative realized P/L so far, as % of cost basis invested so far (see datedDeltas). */
  realizedReturnPct: number;
  /** Cumulative dividends received so far, as % of cost basis invested so far. */
  dividendReturnPct: number;
}

export interface PerformancePeriod {
  period: string;
  realizedReturnPct: number;
  dividendReturnPct: number;
  /** Change in mark-to-market on still-open positions *during this period*, as % of cost basis invested before the period — a delta, not a snapshot, so summing every period's unrealizedReturnPct since a position was opened equals its current total unrealized P/L (no double-counting once it's eventually sold, at which point its gain shifts into realizedReturnPct instead). 0 when no historical price is available for that period, never fabricated. */
  unrealizedReturnPct: number;
}

interface DatedDelta {
  date: string;
  realizedPnl?: number;
  dividend?: number;
  investment?: number;
}

/**
 * Every dated, fully-known event this module cares about. `investment` grows
 * from each Trade's own cost basis at the moment it's bought (never a
 * Deposit/Withdrawal — there is deliberately no concept of "money put into
 * the portfolio" here, only "money spent buying something," by direct user
 * request: money that's sold and reinvested elsewhere counts again on the
 * next buy, so a return % here is against cumulative buying activity, not a
 * capital account — the user explicitly accepted this over the alternative
 * of tracking external deposits). `realizedPnl` isolates the one number
 * that's actually a gain/loss for a closed lot (never a Sell's raw cash-in,
 * which also returns the original cost).
 */
function datedDeltas(trades: Trade[], allocations: TradeAllocation[], timelineEvents: TimelineEvent[]): DatedDelta[] {
  const tradesById = new Map(trades.map((t) => [t.id, t]));
  const deltas: DatedDelta[] = [];

  for (const trade of trades) {
    deltas.push({
      date: `${trade.executionDate}T${trade.executionTime}`,
      investment: trade.shares * trade.entryPrice + trade.fees + trade.taxes,
    });
  }

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
    }
  }

  return deltas.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A cumulative {date, realizedReturnPct, dividendReturnPct} series — the
 * equity-curve replacement. Both percentages are relative to cumulative cost
 * basis invested so far (see datedDeltas), so a sell's cash-in never reads as
 * a gain and a buy is never itself a loss. Extends to `today` with the
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
  let invested = 0;
  const points: PerformancePoint[] = [];

  for (const delta of deltas) {
    if (delta.realizedPnl !== undefined) cumulativeRealized += delta.realizedPnl;
    if (delta.dividend !== undefined) cumulativeDividend += delta.dividend;
    if (delta.investment !== undefined) invested += delta.investment;

    points.push({
      date: delta.date.slice(0, 10),
      realizedReturnPct: invested > 0 ? (cumulativeRealized / invested) * 100 : 0,
      dividendReturnPct: invested > 0 ? (cumulativeDividend / invested) * 100 : 0,
    });
  }

  if (points.length === 0 || points[points.length - 1].date !== today) {
    points.push({
      date: today,
      realizedReturnPct: invested > 0 ? (cumulativeRealized / invested) * 100 : 0,
      dividendReturnPct: invested > 0 ? (cumulativeDividend / invested) * 100 : 0,
    });
  }
  return points;
}

/** The next consecutive period key ("2026-12" → "2027-01", "2026" → "2027"). */
function nextPeriod(period: string): string {
  if (period.length === 4) return String(Number(period) + 1);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** The last calendar day of a "2026-03"/"2026" period key, capped at `today` so an in-progress period never looks past the present. */
function periodCalendarEnd(period: string, today: string): string {
  let end: string;
  if (period.length === 4) {
    end = `${period}-12-31`;
  } else {
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    end = `${period}-${String(lastDay).padStart(2, "0")}`;
  }
  return end < today ? end : today;
}

/** Most recent price on or before `date` for one ticker's history map — never the nearest *future* price, and never fabricated when nothing qualifies. */
function priceAsOf(history: Record<string, number> | undefined, date: string): number | undefined {
  if (!history) return undefined;
  let best: string | undefined;
  for (const d of Object.keys(history)) {
    if (d <= date && (best === undefined || d > best)) best = d;
  }
  return best !== undefined ? history[best] : undefined;
}

/**
 * Mark-to-market on every position still open as of `date`, reconstructed
 * from each Trade/TradeAllocation's own dates rather than today's
 * `remainingShares` snapshot — a share only counts as "open as of `date`" if
 * its trade executed on or before `date` and it wasn't closed by an
 * allocation dated on or before `date` either. A ticker with no historical
 * price recorded for `date` (or earlier) is skipped entirely rather than
 * guessed at, so missing history under-reports rather than fabricates.
 */
function unrealizedPnlAsOf(
  trades: Trade[],
  allocations: TradeAllocation[],
  priceHistory: Record<string, Record<string, number>>,
  date: string
): number {
  let total = 0;
  for (const trade of trades) {
    if (trade.executionDate > date) continue;
    const sharesClosedByDate = allocations
      .filter((a) => a.tradeId === trade.id && a.executionDate <= date)
      .reduce((sum, a) => sum + a.sharesClosed, 0);
    const sharesOpen = trade.shares - sharesClosedByDate;
    if (sharesOpen <= 0) continue;
    const price = priceAsOf(priceHistory[trade.ticker], date);
    if (price === undefined) continue;
    const costBasisPerShare = trade.entryPrice + (trade.fees + trade.taxes) / trade.shares;
    total += (price - costBasisPerShare) * sharesOpen;
  }
  return total;
}

/**
 * Buckets by a date-string prefix ("2026-03" for months, "2026" for years),
 * covering every period from the first trade/event to `today` — not just
 * periods that happen to contain a realized sale or dividend — since a
 * position can sit open for months with real unrealized swings and nothing
 * else happening. Each period reports its OWN realized P/L and dividends
 * (not cumulative), as % of whatever cost basis was already invested
 * *before* that period started (evaluated at the period's calendar start —
 * a trade bought earlier the same period already counts, since the money
 * was spent the instant it was bought, not before).
 *
 * `unrealizedReturnPct` (optional `priceHistory`, from `PriceRepository.
 * getPriceHistory`) is the same "don't let new capital masquerade as a gain"
 * idea applied to still-open positions: rather than blending today's
 * mark-to-market into whichever period happens to contain "today" (the
 * original spike bug this whole model replaced), each period gets the
 * *change* in mark-to-market that occurred during it, computed from that
 * period's own historical closing prices — so summing every period's value
 * since a position opened equals its current total unrealized P/L, and once
 * it's sold, its gain shifts into realizedReturnPct instead (no double
 * count). Omitting `priceHistory` (or missing a specific ticker/date)
 * reports 0 for that slice rather than guessing.
 */
export function bucketPerformance(
  trades: Trade[],
  allocations: TradeAllocation[],
  timelineEvents: TimelineEvent[],
  periodKeyLength: number,
  priceHistory: Record<string, Record<string, number>> = {},
  today: string = new Date().toISOString().slice(0, 10)
): PerformancePeriod[] {
  const deltas = datedDeltas(trades, allocations, timelineEvents);

  const candidateDates = [...deltas.map((d) => d.date.slice(0, 10)), ...trades.map((t) => t.executionDate)];
  if (candidateDates.length === 0) return [];
  const startDate = candidateDates.reduce((min, d) => (d < min ? d : min));
  if (startDate > today) return [];

  const periods: string[] = [];
  for (let cursor = startDate.slice(0, periodKeyLength); cursor <= today.slice(0, periodKeyLength); cursor = nextPeriod(cursor)) {
    periods.push(cursor);
  }

  const investments = deltas
    .filter((d) => d.investment !== undefined)
    .map((d) => ({ date: d.date.slice(0, 10), amount: d.investment! }))
    .sort((a, b) => a.date.localeCompare(b.date));

  /** Cumulative cost basis of everything bought on or before `date` — a trade bought mid-period already counts toward *that same period's* basis, since the money was spent the instant it was bought. */
  function investedThrough(date: string): number {
    let sum = 0;
    for (const inv of investments) {
      if (inv.date > date) break;
      sum += inv.amount;
    }
    return sum;
  }

  const realizedByPeriod = new Map<string, number>();
  const dividendByPeriod = new Map<string, number>();
  for (const delta of deltas) {
    const period = delta.date.slice(0, periodKeyLength);
    if (delta.realizedPnl !== undefined) realizedByPeriod.set(period, (realizedByPeriod.get(period) ?? 0) + delta.realizedPnl);
    if (delta.dividend !== undefined) dividendByPeriod.set(period, (dividendByPeriod.get(period) ?? 0) + delta.dividend);
  }

  let previousUnrealized = 0;
  return periods.map((period) => {
    const periodEnd = periodCalendarEnd(period, today);
    const basis = investedThrough(periodEnd);
    const unrealizedAtEnd = unrealizedPnlAsOf(trades, allocations, priceHistory, periodEnd);
    const unrealizedDelta = unrealizedAtEnd - previousUnrealized;
    previousUnrealized = unrealizedAtEnd;
    return {
      period,
      realizedReturnPct: basis > 0 ? ((realizedByPeriod.get(period) ?? 0) / basis) * 100 : 0,
      dividendReturnPct: basis > 0 ? ((dividendByPeriod.get(period) ?? 0) / basis) * 100 : 0,
      unrealizedReturnPct: basis > 0 ? (unrealizedDelta / basis) * 100 : 0,
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

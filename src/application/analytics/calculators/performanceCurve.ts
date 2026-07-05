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
  /** Change in mark-to-market on still-open positions *during this period*, as % of capital contributed before the period — a delta, not a snapshot, so summing every period's unrealizedReturnPct since a position was opened equals its current total unrealized P/L (no double-counting once it's eventually sold, at which point its gain shifts into realizedReturnPct instead). 0 when no historical price is available for that period, never fabricated. */
  unrealizedReturnPct: number;
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

/** The first calendar day of a "2026-03"/"2026" period key. */
function periodCalendarStart(period: string): string {
  return period.length === 4 ? `${period}-01-01` : `${period}-01`;
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
 * periods that happen to contain a realized sale, dividend, or deposit —
 * since a position can sit open for months with real unrealized swings and
 * nothing else happening. Each period reports its OWN realized P/L and
 * dividends (not cumulative), as % of whatever capital was already
 * contributed *before* that period started (evaluated at the period's
 * calendar start, not "before this period's own first event" — the two
 * agree whenever a period's first-ever event is itself a deposit, but the
 * calendar-start version stays well-defined for a period with no events in
 * it at all).
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

  const contributions = deltas
    .filter((d) => d.contribution !== undefined)
    .map((d) => ({ date: d.date.slice(0, 10), amount: d.contribution! }))
    .sort((a, b) => a.date.localeCompare(b.date));

  function contributedBefore(date: string): number {
    let sum = 0;
    for (const c of contributions) {
      if (c.date >= date) break;
      sum += c.amount;
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
    const basis = Math.abs(contributedBefore(periodCalendarStart(period)));
    const unrealizedAtEnd = unrealizedPnlAsOf(trades, allocations, priceHistory, periodCalendarEnd(period, today));
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

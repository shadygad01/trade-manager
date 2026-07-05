import type { TimelineEvent } from "@domain/entities/TimelineEvent";

export interface EquityPoint {
  date: string;
  equity: number;
  /**
   * Cumulative net Deposit − Withdrawal as of this point (same definition
   * `portfolioReturn` uses for its denominator) — the money actually
   * contributed and still at risk, excluding any trading gain/loss. Lets a
   * period-return calculation (see shared.ts's bucketReturns) exclude new
   * capital from being counted as if it were a gain: without this, a large
   * deposit landing mid-period reads as a huge fake "return" purely because
   * `equity` jumped, when nothing was actually earned. Optional so a
   * hand-built EquityPoint fixture (existing tests predating this field)
   * still type-checks and behaves as "no flow this point" — only real
   * callers going through `equityCurve` below get it populated.
   */
  contributed?: number;
}

function isContributionEvent(event: TimelineEvent): boolean {
  return event.type === "Deposit" || event.type === "Withdrawal";
}

/** Shared cash-flow scan behind both curves below — every point before "today" is cash-flow only in either case, only how the final point is capped differs. */
function cashFlowPoints(timelineEvents: TimelineEvent[], currentCash: number): { points: EquityPoint[]; contributed: number } {
  const sorted = [...timelineEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const totalEventAmount = sorted.reduce((sum, event) => sum + (event.amount ?? 0), 0);

  let cash = currentCash - totalEventAmount;
  let contributed = 0;
  const points: EquityPoint[] = [];
  for (const event of sorted) {
    cash += event.amount ?? 0;
    if (isContributionEvent(event)) contributed += event.amount ?? 0;
    points.push({ date: event.timestamp.slice(0, 10), equity: cash, contributed });
  }
  return { points, contributed };
}

/**
 * Builds a {date, equity, contributed} series from cumulative cash flow
 * (deposits, withdrawals, dividends, cash adjustments, and the net cash
 * effect of every buy/sell — anything with a signed `amount` on its
 * TimelineEvent) plus one final point marking today's still-open positions to
 * `todayMarketValue`.
 *
 * Historical mark-to-market is NOT available: without a historical price feed,
 * every point before today reflects cash flow only, not what open positions
 * were actually worth on that date — the same documented limitation as any
 * point-in-time price feed (see PriceRepository). `currentCash` anchors the
 * series so it reconciles exactly with the portfolio's real cash balance
 * regardless of whether the starting balance came from an explicit Deposit
 * event or the portfolio's initial cash at creation.
 *
 * Meant for a headline "what is this portfolio worth right now" chart (the
 * Dashboard's combined equity curve) — NOT for period-return bucketing (see
 * `cashFlowCurve` below), since blending a cash-only history with one
 * mark-to-market point makes the period containing "today" look like it
 * gained or lost the entire unrealized P&L of every open position in one
 * step, when nothing actually happened that period.
 */
export function equityCurve(
  timelineEvents: TimelineEvent[],
  currentCash: number,
  todayMarketValue: number,
  today: string = new Date().toISOString().slice(0, 10)
): EquityPoint[] {
  const { points, contributed } = cashFlowPoints(timelineEvents, currentCash);

  const todaysEquity = currentCash + todayMarketValue;
  if (points.length > 0 && points[points.length - 1].date === today) {
    points[points.length - 1] = { date: today, equity: todaysEquity, contributed };
  } else {
    points.push({ date: today, equity: todaysEquity, contributed });
  }
  return points;
}

/**
 * Same series as `equityCurve`, but every point — including the last —
 * stays cash-flow only; `todayMarketValue` is never blended in. Feeds
 * `monthlyReturn`/`annualReturn` (see `bucketReturns`): those need every
 * point measured in the same units so a period's delta reflects what
 * actually happened during it, not a one-time "we finally know the real
 * value of everything you already own" correction dumped into whichever
 * period happens to contain today. The Dashboard's own headline equity/
 * unrealized-P&L stats already show today's true mark-to-market separately
 * — this curve is deliberately not that number.
 */
export function cashFlowCurve(
  timelineEvents: TimelineEvent[],
  currentCash: number,
  today: string = new Date().toISOString().slice(0, 10)
): EquityPoint[] {
  const { points, contributed } = cashFlowPoints(timelineEvents, currentCash);

  if (points.length > 0 && points[points.length - 1].date === today) {
    return points;
  }
  return [...points, { date: today, equity: currentCash, contributed }];
}

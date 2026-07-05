import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { JournalEntry } from "@domain/entities/JournalEntry";
import { winRate } from "./calculators/winRate";
import { profitFactor } from "./calculators/profitFactor";
import { avgWinner } from "./calculators/avgWinner";
import { avgLoser } from "./calculators/avgLoser";
import { holdingTime } from "./calculators/holdingTime";
import { exposure } from "./calculators/exposure";
import { cashRatio } from "./calculators/cashRatio";
import {
  performanceCurve,
  bucketPerformance,
  performanceDrawdown,
  type PerformancePoint,
  type PerformancePeriod,
} from "./calculators/performanceCurve";
import { capitalDeployment } from "./calculators/capitalDeployment";
import { portfolioReturn } from "./calculators/portfolioReturn";
import { portfolioHealth, type PortfolioHealth } from "./calculators/portfolioHealth";
import { strategyAttribution, type StrategyAttribution } from "./calculators/strategyAttribution";
import { summarizeOpenPositions } from "./calculators/shared";

/**
 * Every calculator is a pure function over plain data (trades, allocations,
 * timeline events, a priceMap, and/or a performance-curve array) — no
 * repository access. This map exists purely for discoverability/introspection
 * (e.g. listing available metric names); computeAnalytics below wires each
 * calculator to the specific slice of input it needs, since signatures
 * intentionally vary by metric shape (a scalar vs. a curve vs. a bucketed
 * series). Adding a new metric is exactly: one new calculator file, one line
 * in `calculators` here, and one line in `computeAnalytics` to call it.
 */
export const calculators = {
  winRate,
  profitFactor,
  avgWinner,
  avgLoser,
  holdingTime,
  exposure,
  cashRatio,
  performanceDrawdown,
  performanceCurve,
  capitalDeployment,
  bucketPerformance,
  portfolioReturn,
  portfolioHealth,
  strategyAttribution,
};

export interface AnalyticsInput {
  trades: Trade[];
  allocations: TradeAllocation[];
  timelineEvents: TimelineEvent[];
  priceMap: Record<string, number>;
  cash: number;
  today?: string;
  /** Feeds strategyAttribution's tag union (Trade.strategyTags ∪ JournalEntry.strategyTags) — optional since not every caller has journal data on hand. */
  journalEntries?: JournalEntry[];
  /** Per-ticker day-by-day closes (from `PriceRepository.getPriceHistory`), feeding monthly/annual unrealized %. Omitted entirely — not just per-ticker missing — degrades to 0% unrealized per period rather than guessing. */
  priceHistory?: Record<string, Record<string, number>>;
}

export interface AnalyticsResult {
  winRate: number;
  profitFactor: number;
  avgWinner: number;
  avgLoser: number;
  holdingTime: number;
  exposure: number;
  cashRatio: number;
  /** Max peak-to-trough decline (percentage points) of cumulative realized + dividend return — never a raw cash-flow ratio (see performanceDrawdown). */
  drawdown: number;
  capitalDeployment: number;
  /** Cumulative {date, realizedReturnPct, dividendReturnPct} series — the equity-curve replacement. No historical price feed is needed or used. */
  performanceCurve: PerformancePoint[];
  /** Each period (real calendar month, not just months with activity) also carries unrealizedReturnPct — that period's own change in mark-to-market on still-open positions, from `priceHistory` — see performanceCurve.ts's bucketPerformance doc. */
  monthlyPerformance: PerformancePeriod[];
  annualPerformance: PerformancePeriod[];
  /** Since inception, net of deposits/withdrawals — unchanged, was never equity-curve-based. */
  portfolioReturn: number;
  /** Cumulative realized return %, as of `today` (the performance curve's last point). */
  realizedReturnPct: number;
  /** Cumulative dividend return %, as of `today`. */
  dividendReturnPct: number;
  /** Unrealized P/L on still-open positions as % of their cost basis, against today's price only — a snapshot, deliberately not the same figure as monthlyPerformance/annualPerformance's per-period unrealizedReturnPct (a different denominator: cost basis here vs. contributed capital there). */
  unrealizedReturnPct: number;
  portfolioHealth: PortfolioHealth;
  strategyAttribution: StrategyAttribution[];
}

export function computeAnalytics(input: AnalyticsInput): AnalyticsResult {
  const { trades, allocations, timelineEvents, priceMap, cash, today, priceHistory } = input;
  const asOf = today ?? new Date().toISOString().slice(0, 10);

  const { costBasis, marketValue } = summarizeOpenPositions(trades, priceMap);
  const totalEquity = cash + marketValue;
  const unrealizedPnl = marketValue - costBasis;

  const curve = performanceCurve(trades, allocations, timelineEvents, asOf);
  const lastPoint = curve[curve.length - 1];

  const deposits = timelineEvents
    .filter((e) => e.type === "Deposit")
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
  const withdrawals = timelineEvents
    .filter((e) => e.type === "Withdrawal")
    .reduce((sum, e) => sum + Math.abs(e.amount ?? 0), 0);

  return {
    winRate: winRate(allocations, trades),
    profitFactor: profitFactor(allocations, trades),
    avgWinner: avgWinner(allocations, trades),
    avgLoser: avgLoser(allocations, trades),
    holdingTime: holdingTime(allocations, trades),
    exposure: exposure(marketValue, totalEquity),
    cashRatio: cashRatio(cash, totalEquity),
    drawdown: performanceDrawdown(curve),
    capitalDeployment: capitalDeployment(costBasis, totalEquity),
    performanceCurve: curve,
    monthlyPerformance: bucketPerformance(trades, allocations, timelineEvents, 7, priceHistory ?? {}, asOf),
    annualPerformance: bucketPerformance(trades, allocations, timelineEvents, 4, priceHistory ?? {}, asOf),
    portfolioReturn: portfolioReturn(totalEquity, deposits, withdrawals),
    realizedReturnPct: lastPoint?.realizedReturnPct ?? 0,
    dividendReturnPct: lastPoint?.dividendReturnPct ?? 0,
    unrealizedReturnPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
    portfolioHealth: portfolioHealth(trades, allocations, priceMap, cash),
    strategyAttribution: strategyAttribution(trades, allocations, input.journalEntries ?? []),
  };
}

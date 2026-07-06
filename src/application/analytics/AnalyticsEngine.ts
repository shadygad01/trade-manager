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
import { portfolioHealth, type PortfolioHealth } from "./calculators/portfolioHealth";
import { strategyAttribution, type StrategyAttribution } from "./calculators/strategyAttribution";
import { openPositionStats, type OpenPositionStats } from "./calculators/openPositionStats";
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
  portfolioHealth,
  strategyAttribution,
  openPositionStats,
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
  /** Cumulative {date, realizedReturnPct, dividendReturnPct} series — both against cumulative cost basis invested so far (see performanceCurve.ts). No historical price feed is needed for this curve. */
  performanceCurve: PerformancePoint[];
  /** Each period (real calendar month, not just months with activity) also carries unrealizedReturnPct — that period's own change in mark-to-market on still-open positions, from `priceHistory` — see performanceCurve.ts's bucketPerformance doc. */
  monthlyPerformance: PerformancePeriod[];
  annualPerformance: PerformancePeriod[];
  /** Since inception: cumulative realizedReturnPct + dividendReturnPct (the performance curve's last point) — a quick combined figure, e.g. for ranking portfolios. Deliberately excludes unrealizedReturnPct below, which uses a different denominator (cost basis of currently-open positions only, not all invested cost basis). */
  portfolioReturn: number;
  /** Cumulative realized return %, as of `today` (the performance curve's last point), against cost basis invested so far. */
  realizedReturnPct: number;
  /** Cumulative dividend return %, as of `today`, against cost basis invested so far. */
  dividendReturnPct: number;
  /** Unrealized P/L on still-open positions as % of their cost basis, against today's price only — a snapshot, deliberately not the same figure as monthlyPerformance/annualPerformance's per-period unrealizedReturnPct (a different denominator: cost basis of open positions only here, vs. total cost basis ever invested there). */
  unrealizedReturnPct: number;
  portfolioHealth: PortfolioHealth;
  strategyAttribution: StrategyAttribution[];
  /** Number of sell allocations recorded so far — winRate/profitFactor/avgWinner/avgLoser/holdingTime and largestWinner/largestLoser are all 0 by construction until this is > 0 (nothing has been sold yet, not underperformance). */
  closedTradeCount: number;
  /** Mark-to-market win/loss breakdown of still-open Trade lots — the fallback the UI shows (labeled "unrealized") for winRate/profitFactor/avgWinner/avgLoser/avgHoldingTime/largestWinner/largestLoser when closedTradeCount is 0, so a buy-only portfolio isn't stuck reading "0" everywhere. */
  openPositionStats: OpenPositionStats;
}

export function computeAnalytics(input: AnalyticsInput): AnalyticsResult {
  const { trades, allocations, timelineEvents, priceMap, cash, today, priceHistory } = input;
  const asOf = today ?? new Date().toISOString().slice(0, 10);

  const { costBasis, marketValue } = summarizeOpenPositions(trades, priceMap);
  const totalEquity = cash + marketValue;
  const unrealizedPnl = marketValue - costBasis;

  const curve = performanceCurve(trades, allocations, timelineEvents, asOf);
  const lastPoint = curve[curve.length - 1];

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
    portfolioReturn: (lastPoint?.realizedReturnPct ?? 0) + (lastPoint?.dividendReturnPct ?? 0),
    realizedReturnPct: lastPoint?.realizedReturnPct ?? 0,
    dividendReturnPct: lastPoint?.dividendReturnPct ?? 0,
    unrealizedReturnPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
    portfolioHealth: portfolioHealth(trades, allocations, priceMap, cash),
    strategyAttribution: strategyAttribution(trades, allocations, input.journalEntries ?? []),
    closedTradeCount: allocations.length,
    openPositionStats: openPositionStats(trades, priceMap, asOf),
  };
}

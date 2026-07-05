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
import { drawdown } from "./calculators/drawdown";
import { equityCurve, cashFlowCurve, type EquityPoint } from "./calculators/equityCurve";
import { capitalDeployment } from "./calculators/capitalDeployment";
import { monthlyReturn } from "./calculators/monthlyReturn";
import { annualReturn } from "./calculators/annualReturn";
import { portfolioReturn } from "./calculators/portfolioReturn";
import { portfolioHealth, type PortfolioHealth } from "./calculators/portfolioHealth";
import { strategyAttribution, type StrategyAttribution } from "./calculators/strategyAttribution";
import { summarizeOpenPositions, type PeriodReturn } from "./calculators/shared";

/**
 * Every calculator is a pure function over plain data (trades, allocations,
 * timeline events, a priceMap, and/or an equity-curve array) — no repository
 * access. This map exists purely for discoverability/introspection (e.g.
 * listing available metric names); computeAnalytics below wires each
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
  drawdown,
  equityCurve,
  capitalDeployment,
  monthlyReturn,
  annualReturn,
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
}

export interface AnalyticsResult {
  winRate: number;
  profitFactor: number;
  avgWinner: number;
  avgLoser: number;
  holdingTime: number;
  exposure: number;
  cashRatio: number;
  drawdown: number;
  capitalDeployment: number;
  monthlyReturn: PeriodReturn[];
  annualReturn: PeriodReturn[];
  portfolioReturn: number;
  equityCurve: EquityPoint[];
  portfolioHealth: PortfolioHealth;
  strategyAttribution: StrategyAttribution[];
}

export function computeAnalytics(input: AnalyticsInput): AnalyticsResult {
  const { trades, allocations, timelineEvents, priceMap, cash, today } = input;

  const { costBasis, marketValue } = summarizeOpenPositions(trades, priceMap);
  const totalEquity = cash + marketValue;
  const curve = equityCurve(timelineEvents, cash, marketValue, today);
  const flowCurve = cashFlowCurve(timelineEvents, cash, today);

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
    drawdown: drawdown(curve),
    capitalDeployment: capitalDeployment(costBasis, totalEquity),
    monthlyReturn: monthlyReturn(flowCurve),
    annualReturn: annualReturn(flowCurve),
    portfolioReturn: portfolioReturn(totalEquity, deposits, withdrawals),
    equityCurve: curve,
    portfolioHealth: portfolioHealth(trades, allocations, priceMap, cash),
    strategyAttribution: strategyAttribution(trades, allocations, input.journalEntries ?? []),
  };
}

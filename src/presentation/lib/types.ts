/**
 * Re-exports of the application-layer types the presentation layer consumes,
 * gathered in one place so pages import from a single spot. These now mirror
 * the actual finalized application-layer shapes (application/services,
 * application/analytics) rather than the presentation team's earlier guesses.
 */
export type {
  PositionAggregate as Position,
  RecordBuyInput,
  RecordBuyResult,
  RecordSellInput,
  RecordSellAllocationInput,
  RecordSellResult,
} from "@application/services/TradeService";

export type { AnalyticsInput, AnalyticsResult } from "@application/analytics/AnalyticsEngine";
export type { PeriodReturn } from "@application/analytics/calculators/shared";
export type { EquityPoint } from "@application/analytics/calculators/equityCurve";
export type { CreatePortfolioInput } from "@application/services/PortfolioService";

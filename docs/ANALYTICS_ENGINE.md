# Analytics Engine

`src/application/analytics/AnalyticsEngine.ts` computes every portfolio metric from plain data — trades, allocations, timeline events, a current price map, and the portfolio's cash balance. It has no dependency on IndexedDB or any repository; `computeAnalytics()` is a pure function, which is what makes every calculator trivially unit-testable in isolation (see the co-located `*.test.ts` next to each calculator).

## Metrics

| Metric | Calculator | Notes |
|---|---|---|
| Win rate | `calculators/winRate.ts` | Share of closed allocations with positive realized P/L |
| Profit factor | `calculators/profitFactor.ts` | Gross realized gains ÷ gross realized losses |
| Average winner / loser | `calculators/avgWinner.ts` / `avgLoser.ts` | Mean realized P/L across winning / losing allocations |
| Holding time | `calculators/holdingTime.ts` | Average days between a trade's execution and the allocation(s) that closed it, weighted by shares closed |
| Exposure | `calculators/exposure.ts` | Open market value ÷ total equity |
| Cash ratio | `calculators/cashRatio.ts` | Cash ÷ total equity |
| Drawdown | `calculators/drawdown.ts` | Max peak-to-trough % decline over the equity curve |
| Equity curve | `calculators/equityCurve.ts` | `{date, equity}[]` built from cash-flow timeline events, marked to today's market value |
| Capital deployment | `calculators/capitalDeployment.ts` | Invested cost basis ÷ total equity |
| Monthly / annual return | `calculators/monthlyReturn.ts` / `annualReturn.ts` | Equity curve bucketed by period, % change per bucket |
| Portfolio return | `calculators/portfolioReturn.ts` | (Total equity − net contributions) ÷ net contributions |

## Known limitation: equity curve is marked to *today's* price

There is no historical price feed (only the current snapshot — see [ARCHITECTURE.md ADR-003](ARCHITECTURE.md#adr-003-independent-price-snapshot-not-a-live-per-request-api-call)), so historical points on the equity curve mark open positions at **today's** price, not the price on that historical date. Only the cash-flow (deposits/withdrawals/dividends) component of the curve is truly historical. This is a deliberate, documented approximation, not a bug — see `equityCurve.ts`.

## Adding a new metric

1. Add a pure function under `src/application/analytics/calculators/your-metric.ts` taking whatever slice of `{trades, allocations, timelineEvents, priceMap, cash}` it needs.
2. Register it in the `calculators` map and call it from `computeAnalytics()` in `AnalyticsEngine.ts`.
3. Add its return type to `AnalyticsResult`.
4. Write a `*.test.ts` next to it covering at least an empty-data case and a typical case.

No other architectural change is required — this is the extensibility contract the engine was built around.

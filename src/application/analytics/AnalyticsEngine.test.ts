import { describe, it, expect } from "vitest";
import { computeAnalytics, calculators } from "./AnalyticsEngine";
import { makeTrade, makeAllocation } from "./calculators/testFixtures";

describe("computeAnalytics", () => {
  it("returns a fully-defined, zeroed result for an empty portfolio", () => {
    const result = computeAnalytics({
      trades: [],
      allocations: [],
      timelineEvents: [],
      priceMap: {},
      cash: 0,
      today: "2026-01-01",
    });

    expect(result.winRate).toBe(0);
    expect(result.profitFactor).toBe(0);
    expect(result.exposure).toBe(0);
    expect(result.cashRatio).toBe(0);
    expect(result.drawdown).toBe(0);
    expect(result.realizedReturnPct).toBe(0);
    expect(result.dividendReturnPct).toBe(0);
    expect(result.unrealizedReturnPct).toBe(0);
    expect(result.portfolioReturn).toBe(0);
    expect(result.performanceCurve).toEqual([{ date: "2026-01-01", realizedReturnPct: 0, dividendReturnPct: 0 }]);
    expect(result.closedTradeCount).toBe(0);
  });

  it("composes open-position and realized-P/L data into one flat result, measured against cost basis invested — never a deposit/withdrawal", () => {
    const openTrade = makeTrade({ id: "open1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-01" }); // 1000 cost basis
    const closedTrade = makeTrade({ id: "closed1", ticker: "HRHO", shares: 50, entryPrice: 20, executionDate: "2026-01-01" }); // 1000 cost basis
    const closedTradeAfterSell = { ...closedTrade, remainingShares: 0 };
    const allocation = makeAllocation({
      id: "a1",
      tradeId: "closed1",
      ticker: "HRHO",
      sharesClosed: 50,
      exitPrice: 25,
      executionDate: "2026-02-01",
    });

    const result = computeAnalytics({
      trades: [openTrade, closedTradeAfterSell],
      allocations: [allocation],
      timelineEvents: [],
      priceMap: { COMI: 15 },
      cash: -1000 - 1000 + 1250,
      today: "2026-03-01",
    });

    expect(result.winRate).toBe(100);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exposure).toBeGreaterThan(0);
    expect(result.realizedReturnPct).toBe(12.5); // (25-20)*50 = 250 profit over 2000 invested (both trades' cost basis)
    expect(result.portfolioReturn).toBe(12.5); // realizedReturnPct + dividendReturnPct (0 here)
    expect(result.performanceCurve[result.performanceCurve.length - 1].date).toBe("2026-03-01");
  });

  it("does not let a large unrealized gain on open positions spike monthlyPerformance's realized/dividend figures — unrealized P/L never enters those at all", () => {
    const openTrade = makeTrade({ id: "open1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-01" });

    const result = computeAnalytics({
      trades: [openTrade],
      allocations: [],
      timelineEvents: [],
      priceMap: { COMI: 500 }, // a huge unrealized gain purely from a big price snapshot
      cash: -1000,
      today: "2026-07-05",
    });

    const july = result.monthlyPerformance.find((r) => r.period === "2026-07");
    expect((july?.realizedReturnPct ?? 0) + (july?.dividendReturnPct ?? 0)).toBe(0);
    // The unrealized gain is still visible — just as today's snapshot stat, never blended into a time series.
    expect(result.unrealizedReturnPct).toBeGreaterThan(0);
  });

  it("feeds monthlyPerformance/annualPerformance's unrealizedReturnPct from priceHistory, using each period's own historical price rather than today's", () => {
    const openTrade = makeTrade({ id: "open1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-01" }); // 1000 cost basis

    const result = computeAnalytics({
      trades: [openTrade],
      allocations: [],
      timelineEvents: [],
      priceMap: { COMI: 20 }, // today's price — should NOT be what Feb's bucket uses
      cash: -1000,
      today: "2026-02-28",
      priceHistory: { COMI: { "2026-02-28": 15 } }, // Feb's own historical close
    });

    const feb = result.monthlyPerformance.find((r) => r.period === "2026-02");
    // (15-10)*100 = 500 unrealized gain as of Feb's own close, over 1000 invested = 50% — not
    // (20-10)*100=1000/1000=100% (today's price, which would be the old spike-bug shape).
    expect(feb?.unrealizedReturnPct).toBe(50);
    expect(feb?.realizedReturnPct).toBe(0);
  });

  it("exposes every metric name in the calculators registry for introspection", () => {
    expect(Object.keys(calculators).sort()).toEqual(
      [
        "winRate",
        "profitFactor",
        "avgWinner",
        "avgLoser",
        "holdingTime",
        "exposure",
        "cashRatio",
        "performanceDrawdown",
        "performanceCurve",
        "capitalDeployment",
        "bucketPerformance",
        "portfolioHealth",
        "strategyAttribution",
      ].sort()
    );
  });
});

import { describe, it, expect } from "vitest";
import { computeAnalytics, calculators } from "./AnalyticsEngine";
import { makeTrade, makeAllocation } from "./calculators/testFixtures";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";

function depositEvent(timestamp: string, amount: number): TimelineEvent {
  return {
    id: `dep-${timestamp}`,
    portfolioId: "p1",
    type: "Deposit",
    timestamp,
    amount,
    attachments: [],
    createdAt: timestamp,
  };
}

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
    expect(result.equityCurve).toEqual([{ date: "2026-01-01", equity: 0 }]);
  });

  it("composes open-position and realized-P/L data into one flat result", () => {
    const openTrade = makeTrade({ id: "open1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-01" });
    const closedTrade = makeTrade({ id: "closed1", ticker: "HRHO", shares: 50, entryPrice: 20, executionDate: "2026-01-01" });
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
      timelineEvents: [depositEvent("2026-01-01T09:00", 5000)],
      priceMap: { COMI: 15 },
      cash: 5000 - 1000 - 1000 + 1250,
      today: "2026-03-01",
    });

    expect(result.winRate).toBe(100);
    expect(result.exposure).toBeGreaterThan(0);
    expect(result.equityCurve[result.equityCurve.length - 1].date).toBe("2026-03-01");
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
        "drawdown",
        "equityCurve",
        "capitalDeployment",
        "monthlyReturn",
        "annualReturn",
        "portfolioReturn",
        "portfolioHealth",
        "strategyAttribution",
      ].sort()
    );
  });
});

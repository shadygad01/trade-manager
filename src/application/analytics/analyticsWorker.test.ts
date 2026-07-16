import { describe, expect, it } from "vitest";
import { computeAnalytics } from "./AnalyticsEngine";
import { computeAnalyticsBatch } from "./analyticsWorker";
import { makeAllocation, makeTrade } from "./calculators/testFixtures";

describe("computeAnalyticsBatch", () => {
  it("returns the exact same results as the existing analytics engine", async () => {
    const trade = makeTrade({ ticker: "COMI", shares: 100, entryPrice: 50, executionDate: "2025-01-02" });
    const input = {
      trades: [trade],
      allocations: [makeAllocation({ tradeId: trade.id, ticker: "COMI", sharesClosed: 25, exitPrice: 65, executionDate: "2025-01-20" })],
      timelineEvents: [],
      priceMap: { COMI: 80, SWDY: 60 },
      cash: 25_000,
      today: "2025-01-31",
    };

    await expect(computeAnalyticsBatch([input, input])).resolves.toEqual([
      computeAnalytics(input),
      computeAnalytics(input),
    ]);
  });
});

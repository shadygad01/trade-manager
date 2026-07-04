import { describe, it, expect } from "vitest";
import { portfolioHealth } from "./portfolioHealth";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("portfolioHealth", () => {
  it("reports zero concentration and full cash ratio with no open trades", () => {
    const health = portfolioHealth([], [], {}, 10_000);
    expect(health.openTradeCount).toBe(0);
    expect(health.concentrationScore).toBe(0);
    expect(health.largestPositionTicker).toBeUndefined();
  });

  it("flags full concentration when all capital sits in one ticker", () => {
    const trade = { ...makeTrade({ ticker: "COMI", shares: 100, entryPrice: 10 }), remainingShares: 100 };
    const health = portfolioHealth([trade], [], { COMI: 10 }, 0);
    expect(health.concentrationScore).toBeCloseTo(1);
    expect(health.largestPositionTicker).toBe("COMI");
    expect(health.largestPositionPct).toBeCloseTo(100);
    expect(health.diversificationScore).toBeCloseTo(0);
  });

  it("shows lower concentration when capital is split evenly across two tickers", () => {
    const comi = { ...makeTrade({ id: "t1", ticker: "COMI", shares: 100, entryPrice: 10 }), remainingShares: 100 };
    const hrho = { ...makeTrade({ id: "t2", ticker: "HRHO", shares: 100, entryPrice: 10 }), remainingShares: 100 };
    const health = portfolioHealth([comi, hrho], [], { COMI: 10, HRHO: 10 }, 0);
    expect(health.concentrationScore).toBeCloseTo(0.5);
    expect(health.largestPositionPct).toBeCloseTo(50);
  });

  it("falls back to entry price when a ticker is missing from the price map", () => {
    const trade = { ...makeTrade({ ticker: "PHAR", shares: 10, entryPrice: 25 }), remainingShares: 10 };
    const health = portfolioHealth([trade], [], {}, 0);
    expect(health.largestPositionTicker).toBe("PHAR");
    expect(health.largestPositionPct).toBeCloseTo(100);
  });

  it("reports the largest realized winner and loser", () => {
    const trade = makeTrade({ id: "t1", shares: 100, entryPrice: 10 });
    const allocations = [
      makeAllocation({ tradeId: "t1", sharesClosed: 50, exitPrice: 20 }),
      makeAllocation({ tradeId: "t1", sharesClosed: 50, exitPrice: 5 }),
    ];
    const health = portfolioHealth([trade], allocations, {}, 10_000);
    expect(health.largestWinner).toBeCloseTo(50 * (20 - 10));
    expect(health.largestLoser).toBeCloseTo(50 * (5 - 10));
  });

  it("keeps healthScore within 0-100", () => {
    const trade = { ...makeTrade({ ticker: "COMI", shares: 100, entryPrice: 10 }), remainingShares: 100 };
    const health = portfolioHealth([trade], [], { COMI: 10 }, 5_000);
    expect(health.healthScore).toBeGreaterThanOrEqual(0);
    expect(health.healthScore).toBeLessThanOrEqual(100);
  });
});

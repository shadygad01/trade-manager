import { describe, it, expect } from "vitest";
import { openPositionStats } from "./openPositionStats";
import { makeTrade } from "./testFixtures";

describe("openPositionStats", () => {
  it("reports all-zero stats with no open trades", () => {
    const stats = openPositionStats([], {}, "2026-01-10");
    expect(stats.positionCount).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.avgWinner).toBe(0);
    expect(stats.avgLoser).toBe(0);
    expect(stats.largestWinner).toBe(0);
    expect(stats.largestLoser).toBe(0);
    expect(stats.avgHoldingDays).toBe(0);
  });

  it("marks a single open lot as a winner when today's price is above cost basis", () => {
    const trade = makeTrade({ ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-01" });
    const stats = openPositionStats([trade], { COMI: 15 }, "2026-01-11");
    expect(stats.positionCount).toBe(1);
    expect(stats.winRate).toBe(100);
    expect(stats.profitFactor).toBe(Infinity);
    expect(stats.avgWinner).toBeCloseTo(50); // (15-10)/10 * 100
    expect(stats.avgLoser).toBe(0);
    expect(stats.largestWinner).toBeCloseTo(50);
    expect(stats.avgHoldingDays).toBeCloseTo(10);
  });

  it("computes a mixed win/loss profit factor (money-weighted) and largest %  across several open lots", () => {
    const winner = makeTrade({ id: "w1", ticker: "COMI", shares: 100, entryPrice: 10 });
    const loser = makeTrade({ id: "l1", ticker: "HRHO", shares: 100, entryPrice: 10 });
    const stats = openPositionStats([winner, loser], { COMI: 15, HRHO: 8 }, "2026-01-05");
    expect(stats.positionCount).toBe(2);
    expect(stats.winRate).toBe(50);
    expect(stats.profitFactor).toBeCloseTo(500 / 200); // gross profit E£500 / gross loss E£200, still money-weighted
    expect(stats.largestWinner).toBeCloseTo(50); // (15-10)/10 * 100
    expect(stats.largestLoser).toBeCloseTo(-20); // (8-10)/10 * 100
  });

  it("skips a ticker missing from priceMap rather than fabricating a price", () => {
    const trade = makeTrade({ ticker: "PHAR", shares: 10, entryPrice: 25 });
    const stats = openPositionStats([trade], {}, "2026-01-05");
    expect(stats.positionCount).toBe(0);
  });

  it("excludes fully-closed trades from the calculation", () => {
    const closed = { ...makeTrade({ ticker: "COMI", shares: 100, entryPrice: 10 }), remainingShares: 0 };
    const stats = openPositionStats([closed], { COMI: 50 }, "2026-01-05");
    expect(stats.positionCount).toBe(0);
  });
});

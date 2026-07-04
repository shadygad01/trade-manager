import { describe, it, expect } from "vitest";
import { avgWinner } from "./avgWinner";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("avgWinner", () => {
  it("returns 0 with no data", () => {
    expect(avgWinner([], [])).toBe(0);
  });

  it("returns 0 when there are only losers", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 5 })];
    expect(avgWinner(allocations, [trade])).toBe(0);
  });

  it("averages only the winning allocations", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 150 });
    const allocations = [
      makeAllocation({ id: "a1", tradeId: "t1", sharesClosed: 50, exitPrice: 20 }),
      makeAllocation({ id: "a2", tradeId: "t1", sharesClosed: 50, exitPrice: 30 }),
      makeAllocation({ id: "a3", tradeId: "t1", sharesClosed: 50, exitPrice: 5 }),
    ];
    expect(avgWinner(allocations, [trade])).toBeCloseTo((500 + 1000) / 2);
  });
});

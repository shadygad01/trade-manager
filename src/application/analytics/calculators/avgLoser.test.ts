import { describe, it, expect } from "vitest";
import { avgLoser } from "./avgLoser";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("avgLoser", () => {
  it("returns 0 with no data", () => {
    expect(avgLoser([], [])).toBe(0);
  });

  it("returns 0 when there are only winners", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 20 })];
    expect(avgLoser(allocations, [trade])).toBe(0);
  });

  it("averages only the losing allocations (negative)", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 150 });
    const allocations = [
      makeAllocation({ id: "a1", tradeId: "t1", sharesClosed: 50, exitPrice: 5 }),
      makeAllocation({ id: "a2", tradeId: "t1", sharesClosed: 50, exitPrice: 2 }),
      makeAllocation({ id: "a3", tradeId: "t1", sharesClosed: 50, exitPrice: 20 }),
    ];
    expect(avgLoser(allocations, [trade])).toBeCloseTo((-250 + -400) / 2);
  });
});

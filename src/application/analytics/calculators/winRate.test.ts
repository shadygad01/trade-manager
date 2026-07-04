import { describe, it, expect } from "vitest";
import { winRate } from "./winRate";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("winRate", () => {
  it("returns 0 for no closed allocations", () => {
    expect(winRate([], [])).toBe(0);
  });

  it("returns 100 when every allocation is a winner", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [
      makeAllocation({ tradeId: "t1", sharesClosed: 50, exitPrice: 15 }),
      makeAllocation({ tradeId: "t1", sharesClosed: 50, exitPrice: 20 }),
    ];
    expect(winRate(allocations, [trade])).toBe(100);
  });

  it("returns 0 when every allocation is a loser", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 5 })];
    expect(winRate(allocations, [trade])).toBe(0);
  });

  it("computes a mixed win rate", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [
      makeAllocation({ id: "a1", tradeId: "t1", sharesClosed: 25, exitPrice: 20 }),
      makeAllocation({ id: "a2", tradeId: "t1", sharesClosed: 25, exitPrice: 5 }),
      makeAllocation({ id: "a3", tradeId: "t1", sharesClosed: 25, exitPrice: 20 }),
      makeAllocation({ id: "a4", tradeId: "t1", sharesClosed: 25, exitPrice: 5 }),
    ];
    expect(winRate(allocations, [trade])).toBe(50);
  });
});

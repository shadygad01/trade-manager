import { describe, it, expect } from "vitest";
import { profitFactor } from "./profitFactor";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("profitFactor", () => {
  it("returns 0 for no data", () => {
    expect(profitFactor([], [])).toBe(0);
  });

  it("returns Infinity when there are only winners", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 20 })];
    expect(profitFactor(allocations, [trade])).toBe(Infinity);
  });

  it("returns 0 when there are only losers", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 5 })];
    expect(profitFactor(allocations, [trade])).toBe(0);
  });

  it("computes gross profit over gross loss for a mix", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocations = [
      makeAllocation({ id: "a1", tradeId: "t1", sharesClosed: 50, exitPrice: 20 }),
      makeAllocation({ id: "a2", tradeId: "t1", sharesClosed: 50, exitPrice: 5 }),
    ];
    expect(profitFactor(allocations, [trade])).toBeCloseTo(500 / 250);
  });
});

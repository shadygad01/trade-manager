import { describe, it, expect } from "vitest";
import { holdingTime } from "./holdingTime";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("holdingTime", () => {
  it("returns 0 for no allocations", () => {
    expect(holdingTime([], [])).toBe(0);
  });

  it("returns the exact day count for a single fully-closed trade", () => {
    const trade = makeTrade({ id: "t1", executionDate: "2026-01-01" });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, executionDate: "2026-01-11" })];
    expect(holdingTime(allocations, [trade])).toBe(10);
  });

  it("weights by shares closed across multiple partial exits", () => {
    const trade = makeTrade({ id: "t1", executionDate: "2026-01-01", shares: 100 });
    const allocations = [
      makeAllocation({ id: "a1", tradeId: "t1", sharesClosed: 25, executionDate: "2026-01-02" }),
      makeAllocation({ id: "a2", tradeId: "t1", sharesClosed: 75, executionDate: "2026-01-31" }),
    ];
    const expected = (1 * 25 + 30 * 75) / 100;
    expect(holdingTime(allocations, [trade])).toBeCloseTo(expected);
  });
});

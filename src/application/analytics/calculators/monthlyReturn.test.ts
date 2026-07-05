import { describe, it, expect } from "vitest";
import { monthlyReturn } from "./monthlyReturn";

describe("monthlyReturn", () => {
  it("returns an empty array for an empty curve", () => {
    expect(monthlyReturn([])).toEqual([]);
  });

  it("buckets a single month into one period with 0% return", () => {
    const curve = [
      { date: "2026-01-01", equity: 1000 },
      { date: "2026-01-15", equity: 1000 },
    ];
    const result = monthlyReturn(curve);
    expect(result).toEqual([{ period: "2026-01", startEquity: 1000, endEquity: 1000, returnPct: 0 }]);
  });

  it("splits across month boundaries and computes % change per bucket", () => {
    const curve = [
      { date: "2026-01-01", equity: 1000 },
      { date: "2026-01-31", equity: 1100 },
      { date: "2026-02-01", equity: 1100 },
      { date: "2026-02-28", equity: 990 },
    ];
    const result = monthlyReturn(curve);
    expect(result).toEqual([
      { period: "2026-01", startEquity: 1000, endEquity: 1100, returnPct: 10 },
      { period: "2026-02", startEquity: 1100, endEquity: 990, returnPct: -10 },
    ]);
  });

  it("does not divide by zero when a bucket starts at 0 equity", () => {
    const curve = [
      { date: "2026-01-01", equity: 0 },
      { date: "2026-01-15", equity: 500 },
    ];
    expect(monthlyReturn(curve)).toEqual([{ period: "2026-01", startEquity: 0, endEquity: 500, returnPct: 0 }]);
  });

  it("excludes a deposit landing mid-bucket from the return — a deposit is new capital, not a gain (the reported bug)", () => {
    const curve = [
      { date: "2026-01-01", equity: 33.58, contributed: 0 },
      { date: "2026-01-31", equity: 10033.58, contributed: 10000 },
    ];
    const result = monthlyReturn(curve);
    expect(result).toEqual([{ period: "2026-01", startEquity: 33.58, endEquity: 10033.58, returnPct: 0 }]);
  });

  it("still reports a real gain/loss that happens alongside a deposit in the same bucket", () => {
    const curve = [
      { date: "2026-01-01", equity: 1000, contributed: 1000 },
      { date: "2026-01-31", equity: 2100, contributed: 2000 },
    ];
    // Deposited 1000 more, and equity grew by 1100 total — 100 of that isn't
    // explained by the deposit, i.e. a real 10% gain on the 1000 already at risk.
    const result = monthlyReturn(curve);
    expect(result[0].returnPct).toBeCloseTo(10, 5);
  });
});

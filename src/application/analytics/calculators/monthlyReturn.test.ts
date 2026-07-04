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
});

import { describe, it, expect } from "vitest";
import { annualReturn } from "./annualReturn";

describe("annualReturn", () => {
  it("returns an empty array for an empty curve", () => {
    expect(annualReturn([])).toEqual([]);
  });

  it("buckets multiple months in the same year into one period", () => {
    const curve = [
      { date: "2026-01-01", equity: 1000 },
      { date: "2026-06-01", equity: 1200 },
      { date: "2026-12-31", equity: 1500 },
    ];
    expect(annualReturn(curve)).toEqual([{ period: "2026", startEquity: 1000, endEquity: 1500, returnPct: 50 }]);
  });

  it("splits across year boundaries", () => {
    const curve = [
      { date: "2025-12-01", equity: 1000 },
      { date: "2025-12-31", equity: 900 },
      { date: "2026-01-01", equity: 900 },
      { date: "2026-06-01", equity: 1080 },
    ];
    expect(annualReturn(curve)).toEqual([
      { period: "2025", startEquity: 1000, endEquity: 900, returnPct: -10 },
      { period: "2026", startEquity: 900, endEquity: 1080, returnPct: 20 },
    ]);
  });
});

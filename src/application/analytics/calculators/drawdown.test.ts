import { describe, it, expect } from "vitest";
import { drawdown } from "./drawdown";

describe("drawdown", () => {
  it("returns 0 for an empty curve", () => {
    expect(drawdown([])).toBe(0);
  });

  it("returns 0 for a monotonically increasing curve", () => {
    const curve = [
      { date: "2026-01-01", equity: 1000 },
      { date: "2026-01-02", equity: 1100 },
      { date: "2026-01-03", equity: 1300 },
    ];
    expect(drawdown(curve)).toBe(0);
  });

  it("finds the largest peak-to-trough decline, not just the last one", () => {
    const curve = [
      { date: "2026-01-01", equity: 1000 },
      { date: "2026-01-02", equity: 2000 },
      { date: "2026-01-03", equity: 1000 },
      { date: "2026-01-04", equity: 1600 },
      { date: "2026-01-05", equity: 1500 },
    ];
    expect(drawdown(curve)).toBeCloseTo(50);
  });
});

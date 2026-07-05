import { describe, it, expect } from "vitest";
import { rowGroupingGapThreshold } from "./imagePreprocess";

describe("rowGroupingGapThreshold", () => {
  it("returns Infinity for a single order row (all gaps are within-row spacing)", () => {
    expect(rowGroupingGapThreshold([36])).toBe(Infinity);
    expect(rowGroupingGapThreshold([36, 38])).toBe(Infinity);
    expect(rowGroupingGapThreshold([])).toBe(Infinity);
  });

  it("lands between the within-row and between-row gap clusters", () => {
    const threshold = rowGroupingGapThreshold([36, 120, 36, 120, 36]);
    expect(threshold).toBeGreaterThan(36);
    expect(threshold).toBeLessThan(120);
  });

  it("splits every row on the real capture that used to merge into one slice", () => {
    // Exact gaps measured from the reported CSAG screenshot (1179x2556):
    // "All orders" title gap, five two-line rows, then a 284px gap before
    // the Buy/Sell buttons. The old midpoint formula put the threshold at
    // ~143 (above the ~123px between-row gaps), and a global two-cluster
    // variance split puts it at ~204 (isolating the 284 outlier alone) —
    // both merge all five rows into a single slice.
    const gaps = [73, 36, 123, 36, 124, 36, 123, 36, 122, 36, 284];
    const threshold = rowGroupingGapThreshold(gaps);
    expect(threshold).toBeGreaterThan(36);
    expect(threshold).toBeLessThan(122);
    expect(gaps.filter((g) => g > threshold).length).toBe(6); // title | 5 rows | buttons
  });

  it("still separates rows when there are only two rows and no outlier", () => {
    const threshold = rowGroupingGapThreshold([36, 120, 36]);
    expect(threshold).toBeGreaterThan(36);
    expect(threshold).toBeLessThan(120);
  });
});

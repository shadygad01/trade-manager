import { describe, it, expect } from "vitest";
import { sectorAllocation } from "./sectorAllocation";
import { UNCLASSIFIED_SECTOR } from "@domain/value-objects/knownSectors";

describe("sectorAllocation", () => {
  it("returns an empty list when there are no positions", () => {
    expect(sectorAllocation([])).toEqual([]);
  });

  it("groups market value by sector and computes percentages", () => {
    const slices = sectorAllocation([
      { sector: "Banking", marketValue: 600, costBasis: 500 },
      { sector: "Banking", marketValue: 400, costBasis: 350 },
      { sector: "Real Estate", marketValue: 1000, costBasis: 900 },
    ]);
    expect(slices).toEqual([
      { sector: "Banking", marketValue: 1000, percentage: 50 },
      { sector: "Real Estate", marketValue: 1000, percentage: 50 },
    ]);
  });

  it("falls back to costBasis when marketValue is missing (no price snapshot yet)", () => {
    const slices = sectorAllocation([{ sector: "Telecommunications", costBasis: 200 }]);
    expect(slices).toEqual([{ sector: "Telecommunications", marketValue: 200, percentage: 100 }]);
  });

  it("folds positions with no sector into Unclassified and always sorts it last", () => {
    const slices = sectorAllocation([
      { sector: undefined, marketValue: 5000, costBasis: 4000 },
      { sector: "Banking", marketValue: 100, costBasis: 90 },
    ]);
    expect(slices.map((s) => s.sector)).toEqual(["Banking", UNCLASSIFIED_SECTOR]);
    expect(slices[1].marketValue).toBe(5000);
  });

  it("ignores positions with zero or negative value", () => {
    const slices = sectorAllocation([{ sector: "Banking", marketValue: 0, costBasis: 0 }]);
    expect(slices).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { KNOWN_SECTOR_TICKERS, sectorForTicker } from "./knownSectors";

describe("knownSectors", () => {
  it("classifies every ticker in the known-ticker universe", () => {
    for (const ticker of KNOWN_SECTOR_TICKERS) {
      expect(sectorForTicker(ticker), `${ticker} should have a sector`).toBeDefined();
    }
  });

  it("returns undefined for a ticker outside the known universe", () => {
    expect(sectorForTicker("ZZZZ")).toBeUndefined();
  });
});

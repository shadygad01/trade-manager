import { describe, it, expect } from "vitest";
import { historyDateKey, parseYahooHistory, isFrozenHistory, needsBackfill, estimateHistoryFromPerformance } from "./index";

describe("historyDateKey", () => {
  it("extracts the UTC calendar day from an ISO timestamp", () => {
    expect(historyDateKey("2026-07-05T12:30:00.000Z")).toBe("2026-07-05");
  });
});

describe("parseYahooHistory", () => {
  it("zips Yahoo's parallel timestamp/close arrays into a date->close map", () => {
    const data = {
      chart: {
        result: [
          {
            timestamp: [1782000000, 1782086400],
            indicators: { quote: [{ close: [74.2, 75.5] }] },
          },
        ],
      },
    };
    const history = parseYahooHistory(data);
    expect(Object.keys(history)).toHaveLength(2);
    expect(Object.values(history)).toEqual([74.2, 75.5]);
  });

  it("drops trading days with a null close instead of recording zero", () => {
    const data = {
      chart: {
        result: [
          {
            timestamp: [1782000000, 1782086400],
            indicators: { quote: [{ close: [74.2, null] }] },
          },
        ],
      },
    };
    expect(Object.values(parseYahooHistory(data))).toEqual([74.2]);
  });

  it("returns an empty map for a malformed or missing chart result", () => {
    expect(parseYahooHistory({})).toEqual({});
    expect(parseYahooHistory({ chart: { result: [] } })).toEqual({});
  });
});

describe("isFrozenHistory", () => {
  it("flags a two-year backfill that came back as a single repeated value", () => {
    const history = Object.fromEntries(Array.from({ length: 489 }, (_, i) => [`2024-07-${i}`, 71.05]));
    expect(isFrozenHistory(history)).toBe(true);
  });

  it("flags a stored history that's frozen except for one real recent day appended since", () => {
    const history = Object.fromEntries(Array.from({ length: 489 }, (_, i) => [`2024-07-${i}`, 71.05]));
    history["2026-07-05"] = 718.65;
    expect(isFrozenHistory(history)).toBe(true);
  });

  it("does not flag a genuinely illiquid stock that repeats its price on many no-trade days", () => {
    const history: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      history[`day-${i}`] = i % 3 === 0 ? 0.67 : 0.6 + (i % 7) * 0.01;
    }
    expect(isFrozenHistory(history)).toBe(false);
  });

  it("does not flag a short history even if every point happens to match", () => {
    expect(isFrozenHistory({ a: 5, b: 5, c: 5 })).toBe(false);
  });
});

describe("needsBackfill", () => {
  it("flags a ticker with no stored history at all", () => {
    expect(needsBackfill(undefined)).toBe(true);
    expect(needsBackfill({})).toBe(true);
  });

  it("flags frozen history even if it has plenty of entries", () => {
    const history = Object.fromEntries(Array.from({ length: 489 }, (_, i) => [`2024-07-${i}`, 71.05]));
    expect(needsBackfill(history)).toBe(true);
  });

  it("flags a real full 2y backfill as usable and skips re-fetching", () => {
    const history = Object.fromEntries(
      Array.from({ length: 489 }, (_, i) => [`2024-07-${i}`, 71.05 + (i % 5)]),
    );
    expect(needsBackfill(history)).toBe(false);
  });

  it("flags a ticker stuck on only a couple of real day-by-day entries after a past backfill failure", () => {
    // This is exactly ORAS's real observed state: the 2y backfill once came
    // back frozen (or errored) and got discarded, leaving only the quotes
    // appended on the last couple of runs — real prices, but nowhere near a
    // real backfill, so it must not be treated as "good enough" forever.
    expect(needsBackfill({ "2026-07-05": 700, "2026-07-06": 702 })).toBe(true);
  });
});

describe("estimateHistoryFromPerformance", () => {
  it("back-calculates a real anchor price from each performance percentage", () => {
    // close=110, up 10% over the past week => a week ago it was 100.
    const row = [110, 10, null, null, null, null, null];
    const history = estimateHistoryFromPerformance(row, "2026-07-06");
    expect(history["2026-06-29"]).toBeCloseTo(100, 2);
  });

  it("derives all five rolling anchors plus a year-start YTD anchor when every column is present", () => {
    const row = [200, 5, 10, 15, 20, 25, 8];
    const history = estimateHistoryFromPerformance(row, "2026-07-06");
    expect(Object.keys(history).sort()).toEqual(
      ["2025-07-06", "2026-01-01", "2026-01-05", "2026-04-06", "2026-06-06", "2026-06-29"].sort()
    );
  });

  it("skips an anchor whose performance value is missing rather than guessing", () => {
    const row = [150, null, 12, null, null, null, null];
    const history = estimateHistoryFromPerformance(row, "2026-07-06");
    expect(Object.keys(history)).toEqual(["2026-06-06"]);
  });

  it("returns no history at all when close itself is missing", () => {
    expect(estimateHistoryFromPerformance([null, 10, 10, 10, 10, 10, 10], "2026-07-06")).toEqual({});
  });
});

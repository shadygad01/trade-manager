import { describe, it, expect } from "vitest";
import { historyDateKey, parseYahooHistory } from "./index";

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

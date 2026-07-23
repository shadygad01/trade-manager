import { describe, it, expect } from "vitest";
import { findWrongTickerCandidateKeys, findDateMisreadDuplicateHints } from "./wrongTickerHints";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

function buyCandidate(overrides: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return { ticker: "COMI", side: "BUY", shares: 100, price: 50, date: "2026-06-01", ...overrides };
}

describe("findWrongTickerCandidateKeys", () => {
  const sugarTrade = createTrade({
    id: "t-sugr",
    portfolioId: "p1",
    ticker: "SUGR",
    shares: 8,
    entryPrice: 47.09,
    executionDate: "2026-01-06",
    executionTime: "10:00",
  });

  it("flags a low-confidence pending Buy matching another ticker's committed trade at a near-identical price (the HRHO/Delta Sugar case)", () => {
    const phantom = {
      key: "hrho-1",
      candidate: buyCandidate({ ticker: "HRHO", shares: 8, price: 46.66, date: "2026-01-06", confidence: "low" as const }),
    };
    const hints = findWrongTickerCandidateKeys([phantom], [sugarTrade], []);
    expect(hints.get("hrho-1")).toBe("SUGR");
  });

  it("does not flag when the prices are unrelated — same shares/date on different tickers is a coincidence without price proximity", () => {
    const coincidence = {
      key: "hrho-1",
      candidate: buyCandidate({ ticker: "HRHO", shares: 8, price: 24.9, date: "2026-01-06", confidence: "low" as const }),
    };
    expect(findWrongTickerCandidateKeys([coincidence], [sugarTrade], []).size).toBe(0);
  });

  it("does not flag a high-confidence pending read against a committed trade — an anchored ticker match is trusted", () => {
    const anchored = {
      key: "hrho-1",
      candidate: buyCandidate({ ticker: "HRHO", shares: 8, price: 46.66, date: "2026-01-06", confidence: "high" as const }),
    };
    expect(findWrongTickerCandidateKeys([anchored], [sugarTrade], []).size).toBe(0);
  });

  it("flags the strictly-lower-confidence copy of a pending pair under two different tickers, never the better one", () => {
    const real = {
      key: "sugr-1",
      candidate: buyCandidate({ ticker: "SUGR", shares: 6, price: 46.48, date: "2026-01-11", confidence: "high" as const }),
    };
    const phantom = {
      key: "hrho-2",
      candidate: buyCandidate({ ticker: "HRHO", shares: 6, price: 45.92, date: "2026-01-11", confidence: "low" as const }),
    };
    const hints = findWrongTickerCandidateKeys([real, phantom], [], []);
    expect(hints.get("hrho-2")).toBe("SUGR");
    expect(hints.has("sugr-1")).toBe(false);
  });

  it("flags neither of an equal-confidence pending pair — no basis to pick which ticker is the wrong guess", () => {
    const a = { key: "a", candidate: buyCandidate({ ticker: "SUGR", shares: 6, price: 46.48, date: "2026-01-11", confidence: "low" as const }) };
    const b = { key: "b", candidate: buyCandidate({ ticker: "HRHO", shares: 6, price: 45.92, date: "2026-01-11", confidence: "low" as const }) };
    expect(findWrongTickerCandidateKeys([a, b], [], []).size).toBe(0);
  });

  it("flags a pending Sell matching another ticker's committed allocation the same way", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      tradeId: "t-sugr",
      portfolioId: "p1",
      ticker: "SUGR",
      sharesClosed: 22,
      exitPrice: 50.42,
      executionDate: "2026-01-27",
      executionTime: "10:00",
    });
    const phantomSell = {
      key: "hrho-s1",
      candidate: buyCandidate({ ticker: "HRHO", side: "SELL" as const, shares: 22, price: 50.1, date: "2026-01-27", confidence: "low" as const }),
    };
    const hints = findWrongTickerCandidateKeys([phantomSell], [], [allocation]);
    expect(hints.get("hrho-s1")).toBe("SUGR");
  });
});

describe("findDateMisreadDuplicateHints", () => {
  it("flags a pending Buy whose day was likely misread by one digit against an already-committed trade (the real RMDA case: 11 Jan vs 01 Jan)", () => {
    const committed = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "RMDA",
      shares: 500,
      entryPrice: 2.79,
      executionDate: "2023-01-11",
      executionTime: "10:34",
    });
    const pending = { key: "p1", candidate: buyCandidate({ ticker: "RMDA", shares: 500, price: 2.79, date: "2023-01-01" }) };
    const hints = findDateMisreadDuplicateHints([pending], [committed], []);
    expect(hints.get("p1")).toBe("2023-01-11");
  });

  it("never applies an OCR date-misread warning to a native broker Excel row", () => {
    const committed = createTrade({
      id: "t1", portfolioId: "p1", ticker: "ADPC", shares: 500, entryPrice: 1.8,
      executionDate: "2022-11-27", executionTime: "14:29",
    });
    const pending = {
      key: "excel-24-nov",
      candidate: buyCandidate({ ticker: "ADPC", shares: 500, price: 1.79, date: "2022-11-24", time: "01:20PM", source: "official-broker-excel" }),
    };
    expect(findDateMisreadDuplicateHints([pending], [committed], []).size).toBe(0);
  });

  it("does not flag an exact date match — that's the normal exact-duplicate path's job, not this one", () => {
    const committed = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "RMDA",
      shares: 500,
      entryPrice: 2.79,
      executionDate: "2023-01-11",
      executionTime: "10:34",
    });
    const pending = { key: "p1", candidate: buyCandidate({ ticker: "RMDA", shares: 500, price: 2.79, date: "2023-01-11" }) };
    expect(findDateMisreadDuplicateHints([pending], [committed], []).size).toBe(0);
  });

  it("does not flag dates differing in more than one digit position — too far from a single OCR misread to be safe", () => {
    const committed = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "RMDA",
      shares: 500,
      entryPrice: 2.79,
      executionDate: "2023-01-11",
      executionTime: "10:34",
    });
    const pending = { key: "p1", candidate: buyCandidate({ ticker: "RMDA", shares: 500, price: 2.79, date: "2023-01-22" }) };
    expect(findDateMisreadDuplicateHints([pending], [committed], []).size).toBe(0);
  });

  it("does not flag a different month/year even if the day looks similar", () => {
    const committed = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "RMDA",
      shares: 500,
      entryPrice: 2.79,
      executionDate: "2023-01-11",
      executionTime: "10:34",
    });
    const pending = { key: "p1", candidate: buyCandidate({ ticker: "RMDA", shares: 500, price: 2.79, date: "2023-02-11" }) };
    expect(findDateMisreadDuplicateHints([pending], [committed], []).size).toBe(0);
  });

  it("does not flag when the price genuinely differs — not the same execution", () => {
    const committed = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "RMDA",
      shares: 500,
      entryPrice: 2.79,
      executionDate: "2023-01-11",
      executionTime: "10:34",
    });
    const pending = { key: "p1", candidate: buyCandidate({ ticker: "RMDA", shares: 500, price: 3.5, date: "2023-01-01" }) };
    expect(findDateMisreadDuplicateHints([pending], [committed], []).size).toBe(0);
  });

  it("flags a pending Sell against a committed allocation the same way", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      tradeId: "t1",
      portfolioId: "p1",
      ticker: "RMDA",
      sharesClosed: 500,
      exitPrice: 2.8,
      executionDate: "2023-01-17",
      executionTime: "13:26",
    });
    const pending = { key: "s1", candidate: buyCandidate({ ticker: "RMDA", side: "SELL" as const, shares: 500, price: 2.8, date: "2023-01-07" }) };
    const hints = findDateMisreadDuplicateHints([pending], [], [allocation]);
    expect(hints.get("s1")).toBe("2023-01-17");
  });
});

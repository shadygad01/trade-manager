import { describe, it, expect } from "vitest";
import { findDuplicateBuyMatch, findDuplicateSellMatch } from "./duplicateDetection";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

function buyCandidate(overrides: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return { ticker: "COMI", side: "BUY", shares: 100, price: 50, date: "2026-06-01", ...overrides };
}

describe("findDuplicateBuyMatch", () => {
  it("returns undefined when nothing matches", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "HRHO",
      shares: 10,
      entryPrice: 20,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });
    expect(findDuplicateBuyMatch(buyCandidate(), [trade])).toBeUndefined();
  });

  it("flags an exact match (same ticker/date/shares/price)", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "10:00",
    });
    const match = findDuplicateBuyMatch(buyCandidate(), [trade]);
    expect(match).toEqual({ matchType: "exact", matchedId: "t1" });
  });

  it("flags a possible match when price differs but ticker/date/shares match (commission-inclusive vs not)", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50.75,
      executionDate: "2026-06-01",
      executionTime: "10:00",
    });
    const match = findDuplicateBuyMatch(buyCandidate({ price: 50 }), [trade]);
    expect(match).toEqual({ matchType: "possible", matchedId: "t1" });
  });

  it("is not fooled by a different date or share count", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-02",
      executionTime: "10:00",
    });
    expect(findDuplicateBuyMatch(buyCandidate(), [trade])).toBeUndefined();
  });
});

describe("findDuplicateSellMatch", () => {
  it("flags an exact match against an existing allocation", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 40,
      exitPrice: 55,
      executionDate: "2026-06-10",
      executionTime: "11:00",
    });
    const candidate = buyCandidate({ side: "SELL", shares: 40, price: 55, date: "2026-06-10" });
    expect(findDuplicateSellMatch(candidate, [allocation])).toEqual({ matchType: "exact", matchedId: "a1" });
  });
});

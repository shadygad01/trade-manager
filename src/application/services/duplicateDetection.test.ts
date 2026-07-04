import { describe, it, expect } from "vitest";
import {
  findDuplicateBuyMatch,
  findDuplicateSellMatch,
  buildExistingDividendKeys,
  isDividendAlreadyRecorded,
  suggestDuplicateDividendIdsToDelete,
  suggestDuplicatePendingCandidateKeysToDelete,
} from "./duplicateDetection";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
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

describe("buildExistingDividendKeys / isDividendAlreadyRecorded", () => {
  it("flags a dividend matching an already-recorded Dividend event by ticker/date/amount", () => {
    const events = [
      createTimelineEvent({
        id: "e1",
        portfolioId: "p1",
        type: "Dividend",
        timestamp: "2026-04-15T00:00",
        ticker: "comi.ca",
        amount: 114,
      }),
    ];
    const keys = buildExistingDividendKeys(events);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-04-15", amount: 114 }, keys)).toBe(true);
  });

  it("ignores non-Dividend events and events with no ticker/amount", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Buy", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: -114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI" }),
    ];
    const keys = buildExistingDividendKeys(events);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-04-15", amount: 114 }, keys)).toBe(false);
  });

  it("does not flag a dividend with a different amount, date, or ticker", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
    ];
    const keys = buildExistingDividendKeys(events);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-04-15", amount: 50 }, keys)).toBe(false);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-05-15", amount: 114 }, keys)).toBe(false);
    expect(isDividendAlreadyRecorded({ ticker: "HRHO", date: "2026-04-15", amount: 114 }, keys)).toBe(false);
  });
});

describe("suggestDuplicateDividendIdsToDelete", () => {
  it("suggests every event but the first in a same-ticker/date/amount group", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
    ];
    expect(suggestDuplicateDividendIdsToDelete(events)).toEqual(["e2", "e3"]);
  });

  it("does not flag dividends that differ in ticker, date, or amount", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-05-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "HRHO", amount: 114 }),
      createTimelineEvent({ id: "e4", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 50 }),
    ];
    expect(suggestDuplicateDividendIdsToDelete(events)).toEqual([]);
  });

  it("ignores non-Dividend events and dividends with no ticker", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Buy", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Buy", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", amount: 114 }),
      createTimelineEvent({ id: "e4", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", amount: 114 }),
    ];
    expect(suggestDuplicateDividendIdsToDelete(events)).toEqual([]);
  });
});

describe("suggestDuplicatePendingCandidateKeysToDelete", () => {
  it("collapses a real PHAR-shaped batch: two same-shares/date/side groups, each read three times at different prices/confidence, down to the single best-priced read per group", () => {
    const entries = [
      { key: "b1", candidate: buyCandidate({ ticker: "PHAR", shares: 12, price: 86.72, date: "2026-04-15", confidence: "high" as const }) },
      { key: "b2", candidate: buyCandidate({ ticker: "PHAR", shares: 12, price: 86.36, date: "2026-04-15", confidence: "medium" as const }) },
      { key: "b3", candidate: buyCandidate({ ticker: "PHAR", shares: 19, price: 78.30, date: "2026-03-02", confidence: "medium" as const }) },
      { key: "b4", candidate: buyCandidate({ ticker: "PHAR", shares: 19, price: 78.56, date: "2026-03-02", confidence: "high" as const }) },
      { key: "b5", candidate: buyCandidate({ ticker: "PHAR", shares: 12, price: 86.36, date: "2026-04-15", confidence: "medium" as const }) },
      { key: "b6", candidate: buyCandidate({ ticker: "PHAR", shares: 19, price: 78.30, date: "2026-03-02", confidence: "medium" as const }) },
    ];
    // Keeps the highest-priced Buy in each group (b1 @86.72, b4 @78.56); everything else is a suggested duplicate.
    expect(new Set(suggestDuplicatePendingCandidateKeysToDelete(entries))).toEqual(new Set(["b2", "b3", "b5", "b6"]));
  });

  it("keeps the lower-priced read for duplicate Sells, mirroring the opposite priority the app uses for Buys", () => {
    const entries = [
      { key: "s1", candidate: buyCandidate({ side: "SELL", ticker: "COMI", shares: 50, price: 42.1, date: "2026-05-01" }) },
      { key: "s2", candidate: buyCandidate({ side: "SELL", ticker: "COMI", shares: 50, price: 42.5, date: "2026-05-01" }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual(["s2"]);
  });

  it("does not flag candidates that differ in ticker, side, date, or shares", () => {
    const entries = [
      { key: "a", candidate: buyCandidate({ ticker: "COMI", shares: 10, date: "2026-05-01" }) },
      { key: "b", candidate: buyCandidate({ ticker: "HRHO", shares: 10, date: "2026-05-01" }) },
      { key: "c", candidate: buyCandidate({ ticker: "COMI", shares: 10, date: "2026-05-02" }) },
      { key: "d", candidate: buyCandidate({ ticker: "COMI", shares: 20, date: "2026-05-01" }) },
      { key: "e", candidate: buyCandidate({ ticker: "COMI", side: "SELL", shares: 10, date: "2026-05-01" }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual([]);
  });

  it("returns nothing for a single candidate", () => {
    const entries = [{ key: "a", candidate: buyCandidate() }];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual([]);
  });
});

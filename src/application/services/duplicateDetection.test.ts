import { describe, it, expect } from "vitest";
import {
  findDuplicateBuyMatch,
  findDuplicateSellMatch,
  pricesWithinOcrNoise,
  buildExistingDividendKeys,
  isDividendAlreadyRecorded,
  suggestDuplicateDividendIdsToDelete,
  suggestDuplicatePendingCandidateKeysToDelete,
  completeCandidateFieldsFromSiblings,
  findCrossSourceVerifiedKeys,
  findAggregateStatementMatches,
  findWrongTickerCandidateKeys,
  findDateMisreadDuplicateHints,
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
    expect(match).toEqual({ matchType: "exact", matchedId: "t1", matchedPrice: 50 });
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
    expect(match).toEqual({ matchType: "possible", matchedId: "t1", matchedPrice: 50.75 });
  });

  it("reports the closest-priced loose match, independent of row order", () => {
    const mk = (id: string, entryPrice: number) =>
      createTrade({ id, portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice, executionDate: "2026-06-01", executionTime: "10:00" });
    const far = mk("far", 55);
    const near = mk("near", 50.2);
    expect(findDuplicateBuyMatch(buyCandidate({ price: 50 }), [far, near])).toEqual({
      matchType: "possible",
      matchedId: "near",
      matchedPrice: 50.2,
    });
    expect(findDuplicateBuyMatch(buyCandidate({ price: 50 }), [near, far])).toEqual({
      matchType: "possible",
      matchedId: "near",
      matchedPrice: 50.2,
    });
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

  it("flags an exact match by transaction number alone, even with a wildly different price/date (a misread field elsewhere)", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 999, // wouldn't match on price at all
      executionDate: "2020-01-01", // wouldn't match on date at all
      executionTime: "10:00",
      transactionNumber: "N000248458443",
    });
    const candidate = buyCandidate({ transactionNumber: "N000248458443" });
    expect(findDuplicateBuyMatch(candidate, [trade])).toEqual({ matchType: "exact", matchedId: "t1", matchedPrice: 999 });
  });

  it("never matches two rows carrying different transaction numbers, even when ticker/date/shares/price all coincide", () => {
    // Two genuinely separate real buys (same stock, same day, same share
    // count, near-identical price) — the exact false-positive a
    // price/date/shares-only heuristic can't tell apart from a re-import.
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "10:00",
      transactionNumber: "N000000000001",
    });
    const candidate = buyCandidate({ price: 50, transactionNumber: "N000000000002" });
    expect(findDuplicateBuyMatch(candidate, [trade])).toBeUndefined();
  });

  it("falls back to the price/date/shares heuristic when only one side carries a transaction number", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "10:00",
      // no transactionNumber recorded on this trade (manually entered, or imported before this field existed)
    });
    const candidate = buyCandidate({ transactionNumber: "N000248458443" });
    expect(findDuplicateBuyMatch(candidate, [trade])).toEqual({ matchType: "exact", matchedId: "t1", matchedPrice: 50 });
  });

  it("does not flag a genuinely new same-day buy as a duplicate of an already-committed trade when both carry a real, differing execution time", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "10:00",
    });
    const candidate = buyCandidate({ time: "14:30" });
    expect(findDuplicateBuyMatch(candidate, [trade])).toBeUndefined();
  });

  it("still flags a duplicate against an already-committed trade when only one side carries a time, or the committed row's time is the unset placeholder", () => {
    const tradeNoTime = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "00:00", // never OCR'd — the placeholder ImportPage falls back to, not a real midnight execution
    });
    expect(findDuplicateBuyMatch(buyCandidate({ time: "14:30" }), [tradeNoTime])).toEqual({
      matchType: "exact",
      matchedId: "t1",
      matchedPrice: 50,
    });

    const tradeWithTime = createTrade({
      id: "t2",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "10:00",
    });
    expect(findDuplicateBuyMatch(buyCandidate(), [tradeWithTime])).toEqual({
      matchType: "exact",
      matchedId: "t2",
      matchedPrice: 50,
    });
  });
});

describe("findDuplicateSellMatch — legacy allocations without sellGroupId", () => {
  it("re-unifies a sell split across lots by date+price so re-imports still match", () => {
    const base = {
      portfolioId: "p1",
      ticker: "HRHO",
      executionDate: "2026-06-28",
      executionTime: "10:00",
      exitPrice: 26.63,
      // Legacy rows recorded before sellGroupId existed carry an empty one.
      sellGroupId: "",
    };
    const a1 = createTradeAllocation({ ...base, id: "a1", tradeId: "t1", sharesClosed: 24 });
    const a2 = createTradeAllocation({ ...base, id: "a2", tradeId: "t2", sharesClosed: 15 });
    const match = findDuplicateSellMatch(
      buyCandidate({ ticker: "HRHO", side: "SELL", date: "2026-06-28", shares: 39, price: 26.63 }),
      [a1, a2],
    );
    expect(match?.matchType).toBe("exact");
    expect(match?.matchedPrice).toBe(26.63);
  });

  it("does not merge legacy rows with different prices", () => {
    const base = { portfolioId: "p1", ticker: "HRHO", executionDate: "2026-06-28", executionTime: "10:00", sellGroupId: "" };
    const a1 = createTradeAllocation({ ...base, id: "a1", tradeId: "t1", exitPrice: 26.63, sharesClosed: 24 });
    const a2 = createTradeAllocation({ ...base, id: "a2", tradeId: "t2", exitPrice: 27.1, sharesClosed: 15 });
    expect(
      findDuplicateSellMatch(buyCandidate({ ticker: "HRHO", side: "SELL", date: "2026-06-28", shares: 39, price: 26.63 }), [a1, a2]),
    ).toBeUndefined();
  });
});

describe("pricesWithinOcrNoise", () => {
  it("accepts price gaps at or under 1% (commission-inclusive vs raw execution price)", () => {
    expect(pricesWithinOcrNoise(50, 50.5)).toBe(true); // exactly 1% of 50.5-max
    expect(pricesWithinOcrNoise(24.9, 24.9)).toBe(true);
    expect(pricesWithinOcrNoise(27.6, 27.85)).toBe(true); // ~0.9%
  });

  it("rejects price gaps over 1% (plausibly a different real trade)", () => {
    expect(pricesWithinOcrNoise(50, 50.75)).toBe(false); // 1.48%
    expect(pricesWithinOcrNoise(27.6, 28.2)).toBe(false); // ~2.1%
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
    expect(findDuplicateSellMatch(candidate, [allocation])).toEqual({ matchType: "exact", matchedId: "a1", matchedPrice: 55 });
  });

  it("does not flag a genuinely new same-day sell as a duplicate when both sides carry a real, differing execution time", () => {
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
    const candidate = buyCandidate({ side: "SELL", shares: 40, price: 55, date: "2026-06-10", time: "15:45" });
    expect(findDuplicateSellMatch(candidate, [allocation])).toBeUndefined();
  });

  it("matches one sell order split across multiple buy lots (shared sellGroupId) by its total shares", () => {
    const base = {
      sellGroupId: "sg1",
      portfolioId: "p1",
      ticker: "HRHO",
      exitPrice: 27.6,
      executionDate: "2026-02-02",
      executionTime: "11:00",
    };
    const allocations = [
      createTradeAllocation({ ...base, id: "a1", tradeId: "t1", sharesClosed: 30 }),
      createTradeAllocation({ ...base, id: "a2", tradeId: "t2", sharesClosed: 15 }),
    ];
    const candidate = buyCandidate({ ticker: "HRHO", side: "SELL", shares: 45, price: 27.6, date: "2026-02-02" });
    expect(findDuplicateSellMatch(candidate, allocations)).toEqual({ matchType: "exact", matchedId: "a1", matchedPrice: 27.6 });
  });

  it("never merges two distinct sell orders (different sellGroupIds) into a false duplicate, even at the same date and price", () => {
    const base = {
      portfolioId: "p1",
      ticker: "HRHO",
      exitPrice: 27.6,
      executionDate: "2026-02-02",
      executionTime: "11:00",
    };
    const allocations = [
      createTradeAllocation({ ...base, id: "a1", sellGroupId: "sg1", tradeId: "t1", sharesClosed: 30 }),
      createTradeAllocation({ ...base, id: "a2", sellGroupId: "sg2", tradeId: "t2", sharesClosed: 15 }),
    ];
    const candidate = buyCandidate({ ticker: "HRHO", side: "SELL", shares: 45, price: 27.6, date: "2026-02-02" });
    expect(findDuplicateSellMatch(candidate, allocations)).toBeUndefined();
  });

  it("flags a split sell as a possible match when the shares total matches but the price differs", () => {
    const base = {
      sellGroupId: "sg1",
      portfolioId: "p1",
      ticker: "HRHO",
      exitPrice: 27.6,
      executionDate: "2026-02-02",
      executionTime: "11:00",
    };
    const allocations = [
      createTradeAllocation({ ...base, id: "a1", tradeId: "t1", sharesClosed: 30 }),
      createTradeAllocation({ ...base, id: "a2", tradeId: "t2", sharesClosed: 15 }),
    ];
    const candidate = buyCandidate({ ticker: "HRHO", side: "SELL", shares: 45, price: 27.75, date: "2026-02-02" });
    expect(findDuplicateSellMatch(candidate, allocations)).toEqual({ matchType: "possible", matchedId: "a1", matchedPrice: 27.6 });
  });

  it("flags an exact match by transaction number alone, even with a wildly different price/date", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 40,
      exitPrice: 999,
      executionDate: "2020-01-01",
      executionTime: "11:00",
      transactionNumber: "N000248458443",
    });
    const candidate = buyCandidate({ side: "SELL", transactionNumber: "N000248458443" });
    expect(findDuplicateSellMatch(candidate, [allocation])).toEqual({ matchType: "exact", matchedId: "a1", matchedPrice: 999 });
  });

  it("never matches two sell orders carrying different transaction numbers, even at the same date/shares/price", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 100,
      exitPrice: 50,
      executionDate: "2026-06-01",
      executionTime: "11:00",
      transactionNumber: "N000000000001",
    });
    const candidate = buyCandidate({ side: "SELL", price: 50, transactionNumber: "N000000000002" });
    expect(findDuplicateSellMatch(candidate, [allocation])).toBeUndefined();
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

  it("does NOT suggest deleting a same-signature sibling whose price sits clearly apart — possibly a different real trade", () => {
    // Same ticker/side/date/shares but 50.00 vs 46.00 (~8% apart): two
    // distinct same-day orders, not two reads of one execution. A false
    // merge loses a real trade; leaving both pending just waits for the user.
    const entries = [
      { key: "a", candidate: buyCandidate({ price: 50.0 }) },
      { key: "b", candidate: buyCandidate({ price: 46.0 }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual([]);
  });

  it("keeps the invoice-sourced read as survivor even when the price heuristic favors the other read", () => {
    // Buy heuristic alone would keep the higher-priced statement read —
    // but the invoice's labeled price + fees are ground truth.
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.2, source: "statement" }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice", fees: 4.32 }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual(["st"]);
  });

  it("does NOT merge two genuinely different invoice-sourced trades that happen to share ticker/side/date/shares and a close price, when their transaction numbers differ", () => {
    // Two real, separate buys of the same stock on the same day for the same
    // share count at a similar price — exactly the false-positive the price
    // heuristic alone would wrongly collapse into one. A defined, differing
    // transaction number is ground truth that they are NOT the same order.
    const entries = [
      { key: "inv1", candidate: buyCandidate({ price: 50.1, source: "invoice", transactionNumber: "N000000000001" }) },
      { key: "inv2", candidate: buyCandidate({ price: 50.0, source: "invoice", transactionNumber: "N000000000002" }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual([]);
  });

  it("merges two reads sharing the same transaction number even when their price gap exceeds the normal sibling tolerance", () => {
    const entries = [
      { key: "inv1", candidate: buyCandidate({ price: 50.0, source: "invoice", transactionNumber: "N000000000001" }) },
      // >2% apart — outside SIBLING_DUPLICATE_PRICE_TOLERANCE — but the
      // matching transaction number proves it's the same real order (e.g. a
      // re-read of the same invoice with one OCR digit dropped).
      { key: "inv2", candidate: buyCandidate({ price: 48.0, source: "invoice", transactionNumber: "N000000000001" }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual(["inv2"]);
  });

  it("does NOT flag two same-signature Buys as duplicates when both carry a real, differing execution time (the RMDA case: two genuine same-day, same-price buys 28 minutes apart)", () => {
    const entries = [
      { key: "b1", candidate: buyCandidate({ ticker: "RMDA", price: 2.94, date: "2023-01-05", shares: 500, time: "10:33AM" }) },
      { key: "b2", candidate: buyCandidate({ ticker: "RMDA", price: 2.94, date: "2023-01-05", shares: 500, time: "10:05AM" }) },
    ];
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual([]);
  });

  it("still flags a same-signature pair as a duplicate when only one side carries a time (the routine statement+orders-screen pairing case)", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.0, source: "statement" }) }, // statement rows never carry a time
      { key: "os", candidate: buyCandidate({ price: 50.0, source: "orders-screen", time: "10:33AM" }) },
    ];
    // "st" sorts first (tied price, stable sort keeps array order) and
    // survives; "os" — missing a time on the OTHER side, so the new time
    // guard doesn't apply — is still flagged as the duplicate to delete.
    expect(suggestDuplicatePendingCandidateKeysToDelete(entries)).toEqual(["os"]);
  });
});

describe("completeCandidateFieldsFromSiblings", () => {
  it("copies missing fees/taxes/time from a price-close sibling of a different source, never overwriting present values", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.1, source: "statement" as const }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, fees: 4.32, time: "10:30" }) },
    ];
    const completions = completeCandidateFieldsFromSiblings(entries);
    expect(completions.get("st")).toEqual({ fees: 4.32, time: "10:30", confidence: "high" });
    // "inv" has no missing fields to backfill, but is itself corroborated by
    // "st" (a different-source, same-execution sibling), so it also gets its
    // confidence raised — corroboration is symmetric, not one-directional.
    expect(completions.get("inv")).toEqual({ confidence: "high" });
  });

  it("prefers the invoice-sourced donor when several siblings carry the same field", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.0, source: "statement" as const }) },
      { key: "os", candidate: buyCandidate({ price: 50.0, source: "orders-screen" as const, fees: 9.99 }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, fees: 4.32 }) },
    ];
    expect(completeCandidateFieldsFromSiblings(entries).get("st")).toEqual({ fees: 4.32, confidence: "high" });
  });

  it("raises confidence to high when a different-source sibling corroborates the same execution, but never lowers it", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.0, source: "statement" as const, confidence: "low" as const }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, confidence: "high" as const }) },
    ];
    const completions = completeCandidateFieldsFromSiblings(entries);
    expect(completions.get("st")).toEqual({ confidence: "high" });
    expect(completions.has("inv")).toBe(false);
  });

  it("never completes from a sibling whose price sits clearly apart (possibly a different real trade)", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.0, source: "statement" as const }) },
      { key: "inv", candidate: buyCandidate({ price: 46.0, source: "invoice" as const, fees: 4.32 }) },
    ];
    expect(completeCandidateFieldsFromSiblings(entries).size).toBe(0);
  });

  it("never enriches a legacy untyped candidate — its real document type is unknowable", () => {
    const entries = [
      { key: "old", candidate: buyCandidate({ price: 50.0 }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, fees: 4.32 }) },
    ];
    expect(completeCandidateFieldsFromSiblings(entries).has("old")).toBe(false);
  });

  it("never completes from a same-source sibling or an untyped legacy one", () => {
    const entries = [
      { key: "a", candidate: buyCandidate({ source: "statement" as const }) },
      { key: "b", candidate: buyCandidate({ source: "statement" as const, fees: 4.32 }) },
      { key: "c", candidate: buyCandidate({ fees: 9.99 }) },
    ];
    expect(completeCandidateFieldsFromSiblings(entries).size).toBe(0);
  });

  it("backfills transactionNumber from an invoice sibling onto a statement row that never prints one", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.1, source: "statement" as const }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, transactionNumber: "N000248458443" }) },
    ];
    expect(completeCandidateFieldsFromSiblings(entries).get("st")).toEqual({ transactionNumber: "N000248458443", confidence: "high" });
  });

  it("never overwrites a statement row's own transaction number with a sibling's different one", () => {
    // Extremely unlikely in practice (a statement never actually prints an
    // ID), but the "strictly additive, never overwrite" contract must hold
    // for every field, not just the ones already covered.
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.1, source: "statement" as const, transactionNumber: "OWN" }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, transactionNumber: "OTHER" }) },
    ];
    const completions = completeCandidateFieldsFromSiblings(entries);
    expect(completions.has("st")).toBe(false);
  });
});

describe("findCrossSourceVerifiedKeys", () => {
  it("flags both sides of a pair where one candidate is an invoice and the other isn't (ORHD-shaped: OCR screenshot corroborated by an invoice)", () => {
    const screenshotRead = { key: "s1", candidate: buyCandidate({ ticker: "ORHD", shares: 10, price: 23.13, date: "2026-01-14" }) };
    const invoiceRead = {
      key: "i1",
      candidate: buyCandidate({ ticker: "ORHD", shares: 10, price: 23.2, date: "2026-01-14", source: "invoice" }),
    };
    const unrelated = { key: "u1", candidate: buyCandidate({ ticker: "ORHD", shares: 25, price: 22.77, date: "2026-01-15" }) };
    const verified = findCrossSourceVerifiedKeys([screenshotRead, invoiceRead, unrelated]);
    expect(verified).toEqual(new Set(["s1", "i1"]));
  });

  it("does not flag two candidates that are both invoices or both non-invoice (no cross-source corroboration)", () => {
    const twoInvoices = [
      { key: "a", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "invoice" as const }) },
      { key: "b", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "invoice" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(twoInvoices)).toEqual(new Set());

    const twoScreenshots = [
      { key: "c", candidate: buyCandidate({ shares: 10, date: "2026-01-14" }) },
      { key: "d", candidate: buyCandidate({ shares: 10, date: "2026-01-14" }) },
    ];
    expect(findCrossSourceVerifiedKeys(twoScreenshots)).toEqual(new Set());
  });

  it("does not flag a lone invoice-sourced candidate with no non-invoice sibling to corroborate", () => {
    const entries = [{ key: "a", candidate: buyCandidate({ source: "invoice" as const }) }];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set());
  });

  it("ignores ticker/side/date/shares mismatches — only an exact signature match cross-verifies", () => {
    const entries = [
      { key: "a", candidate: buyCandidate({ shares: 10, date: "2026-01-14" }) },
      { key: "b", candidate: buyCandidate({ shares: 11, date: "2026-01-14", source: "invoice" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set());
  });

  it("flags any pair of two DIFFERENT document types — statement + orders screenshot, no invoice involved", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "statement" as const }) },
      { key: "os", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "orders-screen" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set(["st", "os"]));
  });

  it("flags a CSV export paired with a statement read", () => {
    const entries = [
      { key: "csv", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "csv" as const }) },
      { key: "st", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "statement" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set(["csv", "st"]));
  });

  it("never pairs two reads of the same document type — two statements are a re-upload, not independent confirmation", () => {
    const entries = [
      { key: "a", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "statement" as const }) },
      { key: "b", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "statement" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set());
  });

  it("does not cross-verify two documents that share a signature but disagree on price — possibly two different real trades", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.0, shares: 10, date: "2026-01-14", source: "statement" as const }) },
      { key: "inv", candidate: buyCandidate({ price: 46.0, shares: 10, date: "2026-01-14", source: "invoice" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set());
  });

  it("never pairs a legacy untyped candidate (pre-source session) with a typed non-invoice one — its real type is unknowable", () => {
    const entries = [
      { key: "old", candidate: buyCandidate({ shares: 10, date: "2026-01-14" }) },
      { key: "new", candidate: buyCandidate({ shares: 10, date: "2026-01-14", source: "orders-screen" as const }) },
    ];
    expect(findCrossSourceVerifiedKeys(entries)).toEqual(new Set());
  });
});

describe("findAggregateStatementMatches", () => {
  it("Case 1: a Statement row matches exactly one same-day execution of the identical share count", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const order = { key: "o1", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, order]);
    expect(result.get("st")).toEqual(["o1"]);
  });

  it("Case 2: a Statement row aggregates two executions whose shares sum exactly (8,000 = 5,000 + 3,000)", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2]);
    expect(new Set(result.get("st"))).toEqual(new Set(["o1", "o2"]));
  });

  it("Case 2: a Statement row aggregates three executions whose shares sum exactly (10,000 = 2,000 + 3,000 + 5,000)", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 10000, price: 6.5, date: "2026-02-01", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 2000, price: 6.5, date: "2026-02-01", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 6.5, date: "2026-02-01", source: "invoice" as const }) };
    const o3 = { key: "o3", candidate: buyCandidate({ shares: 5000, price: 6.5, date: "2026-02-01", source: "csv" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2, o3]);
    expect(new Set(result.get("st"))).toEqual(new Set(["o1", "o2", "o3"]));
  });

  it("prefers the smallest exact matching group when more than one subset would sum exactly", () => {
    // 8,000 could be 5,000+3,000 or 4,000+4,000+... — a lone 8,000 row must
    // win over any multi-row combination if one exists in the pool.
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const solo = { key: "solo", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, solo, o1, o2]);
    expect(result.get("st")).toEqual(["solo"]);
  });

  it("leaves a Statement row unmatched when no exact combination exists — never guesses a partial/approximate sum", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 2500, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2]);
    expect(result.has("st")).toBe(false);
  });

  it("rejects a subset that sums exactly but whose weighted-average price disagrees with the Statement row", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 5.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 5.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2]);
    expect(result.has("st")).toBe(false);
  });

  it("requires the same side — a Sell Statement row never matches Buy executions even with an exact share sum", () => {
    const statement = {
      key: "st",
      candidate: buyCandidate({ side: "SELL" as const, shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }),
    };
    const o1 = { key: "o1", candidate: buyCandidate({ side: "BUY" as const, shares: 5000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ side: "BUY" as const, shares: 3000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2]);
    expect(result.has("st")).toBe(false);
  });

  it("requires the same day — an exact share sum on a different date never matches", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-15", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2]);
    expect(result.has("st")).toBe(false);
  });

  it("never uses another Statement row as an execution — a Statement only ever aggregates higher-detail sources", () => {
    const statement = { key: "st1", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const otherStatement = { key: "st2", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const result = findAggregateStatementMatches([statement, otherStatement]);
    expect(result.has("st1")).toBe(false);
  });

  it("skips a Statement row already resolved by direct 1:1 cross-source verification (alreadyVerifiedKeys)", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2], new Set(["st"]));
    expect(result.has("st")).toBe(false);
  });

  it("never lets two different Statement rows aggregate the same execution — each execution is consumed once", () => {
    const st1 = { key: "st1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const st2 = { key: "st2", candidate: buyCandidate({ shares: 8000, price: 8.0, date: "2026-01-14", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 5000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 8.0, date: "2026-01-14", source: "orders-screen" as const }) };
    const result = findAggregateStatementMatches([st1, st2, o1, o2]);
    // st1 (5,000) is processed first (smallest-shares-first) and claims o1
    // outright — st2 (8,000) is left with only o2 (3,000) in the pool, which
    // can't sum to 8,000, so it's correctly unmatched rather than reusing o1.
    expect(result.get("st1")).toEqual(["o1"]);
    expect(result.has("st2")).toBe(false);
  });

  it("no candidate is ever double-counted: a Statement row plus its matched group never produce more committed trades than the underlying executions", () => {
    const statement = { key: "st", candidate: buyCandidate({ shares: 10000, price: 6.5, date: "2026-02-01", source: "statement" as const }) };
    const o1 = { key: "o1", candidate: buyCandidate({ shares: 2000, price: 6.5, date: "2026-02-01", source: "orders-screen" as const }) };
    const o2 = { key: "o2", candidate: buyCandidate({ shares: 3000, price: 6.5, date: "2026-02-01", source: "invoice" as const }) };
    const o3 = { key: "o3", candidate: buyCandidate({ shares: 5000, price: 6.5, date: "2026-02-01", source: "csv" as const }) };
    const result = findAggregateStatementMatches([statement, o1, o2, o3]);
    const matchedKeys = result.get("st")!;
    // Every key returned actually belongs to the execution pool, never to the
    // Statement row itself — committing the matched group plus skipping the
    // Statement row accounts for exactly 10,000 shares once, not twice.
    expect(matchedKeys).not.toContain("st");
    const totalMatchedShares = matchedKeys
      .map((k) => [o1, o2, o3].find((e) => e.key === k)!.candidate.shares)
      .reduce((a, b) => a + b, 0);
    expect(totalMatchedShares).toBe(statement.candidate.shares);
  });
});

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

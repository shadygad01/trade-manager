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
  findWrongTickerCandidateKeys,
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
});

describe("completeCandidateFieldsFromSiblings", () => {
  it("copies missing fees/taxes/time from a price-close sibling of a different source, never overwriting present values", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.1, source: "statement" as const }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, fees: 4.32, time: "10:30" }) },
    ];
    const completions = completeCandidateFieldsFromSiblings(entries);
    expect(completions.get("st")).toEqual({ fees: 4.32, time: "10:30" });
    expect(completions.has("inv")).toBe(false);
  });

  it("prefers the invoice-sourced donor when several siblings carry the same field", () => {
    const entries = [
      { key: "st", candidate: buyCandidate({ price: 50.0, source: "statement" as const }) },
      { key: "os", candidate: buyCandidate({ price: 50.0, source: "orders-screen" as const, fees: 9.99 }) },
      { key: "inv", candidate: buyCandidate({ price: 50.0, source: "invoice" as const, fees: 4.32 }) },
    ];
    expect(completeCandidateFieldsFromSiblings(entries).get("st")).toEqual({ fees: 4.32 });
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

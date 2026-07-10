import { describe, it, expect } from "vitest";
import { reconcilePositions, suggestDuplicateTradeIds } from "./reconciliation";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { PositionAggregate } from "./TradeService";

function position(ticker: string, totalShares: number): PositionAggregate {
  return { ticker, totalShares, costBasis: 0, avgCost: 0, openTrades: [] };
}

function verification(overrides: Partial<PositionVerification> = {}): PositionVerification {
  return {
    id: "v1",
    portfolioId: "p1",
    ticker: "COMI",
    units: 100,
    capturedAt: "2026-06-01T00:00",
    source: "screenshot",
    ...overrides,
  };
}

describe("reconcilePositions", () => {
  it("flags no mismatch when computed matches verified", () => {
    const [result] = reconcilePositions([position("COMI", 100)], [verification()], [], []);
    expect(result.quantityMismatch).toBe(false);
    expect(result.quantityShortfall).toBe(false);
  });

  it("flags quantityMismatch when computed exceeds verified", () => {
    const [result] = reconcilePositions([position("COMI", 150)], [verification()], [], []);
    expect(result.quantityMismatch).toBe(true);
    expect(result.quantityShortfall).toBe(false);
  });

  it("flags quantityShortfall when computed is below verified", () => {
    const [result] = reconcilePositions([position("COMI", 50)], [verification()], [], []);
    expect(result.quantityShortfall).toBe(true);
    expect(result.quantityMismatch).toBe(false);
  });

  it("suppresses mismatch flags when a newer trade explains the gap (stale verification)", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 10,
      executionDate: "2026-06-15",
      executionTime: "10:00",
    });
    const [result] = reconcilePositions([position("COMI", 150)], [verification()], [trade], []);
    expect(result.verificationStale).toBe(true);
    expect(result.quantityMismatch).toBe(false);
    expect(result.quantityShortfall).toBe(false);
  });

  it("suppresses mismatch when a newer sell allocation explains the gap", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 50,
      exitPrice: 12,
      executionDate: "2026-06-20",
      executionTime: "10:00",
    });
    const [result] = reconcilePositions([position("COMI", 50)], [verification()], [], [allocation]);
    expect(result.verificationStale).toBe(true);
    expect(result.quantityShortfall).toBe(false);
  });

  it("uses the most recent verification when multiple exist for a ticker", () => {
    const older = verification({ id: "v-old", capturedAt: "2026-01-01T00:00", units: 999 });
    const newer = verification({ id: "v-new", capturedAt: "2026-06-01T00:00", units: 100 });
    const [result] = reconcilePositions([position("COMI", 100)], [older, newer], [], []);
    expect(result.verifiedUnits).toBe(100);
    expect(result.quantityMismatch).toBe(false);
  });

  it("reports a verified position even when there are zero computed shares (shortfall)", () => {
    const [result] = reconcilePositions([], [verification({ units: 30 })], [], []);
    expect(result.computedShares).toBe(0);
    expect(result.quantityShortfall).toBe(true);
  });

  it("skips tickers with no verification at all", () => {
    const results = reconcilePositions([position("HRHO", 10)], [], [], []);
    expect(results).toHaveLength(0);
  });
});

describe("suggestDuplicateTradeIds", () => {
  it("picks the single lowest-priced deletable trade when only one duplicate exists", () => {
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 50, shares: 100, remainingShares: 100 },
        { id: "t2", entryPrice: 48, shares: 100, remainingShares: 100 },
        { id: "t3", entryPrice: 55, shares: 100, remainingShares: 100 },
      ],
      computedShares: 300,
      verifiedUnits: 200,
    });
    expect(suggested).toEqual(["t2"]);
  });

  it("delegates to the canonical avg-cost-ranked solver when a verified avg cost is available — picking the subset whose surviving avg cost is closest to it", () => {
    // Removing t1 (50) leaves t2+t3, implied avg (48+55)/2 = 51.5 — farther
    // from the broker's 54 than removing t2 (48), which leaves t1+t3, avg
    // (50+55)/2 = 52.5. The canonical solver correctly prefers removing t2.
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 50, shares: 100, remainingShares: 100 },
        { id: "t2", entryPrice: 48, shares: 100, remainingShares: 100 },
        { id: "t3", entryPrice: 55, shares: 100, remainingShares: 100 },
      ],
      computedShares: 300,
      verifiedUnits: 200,
      verifiedAvgCost: 54,
    });
    expect(suggested).toEqual(["t2"]);
  });

  it("returns every trade needed to close a gap spanning more than one duplicate", () => {
    // Three 100-share buys (t1 kept, t2/t3 duplicates) computed at 300 vs. a
    // broker-verified 100 — both duplicates must go in one pass, not just one.
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 50, shares: 100, remainingShares: 100 },
        { id: "t2", entryPrice: 48, shares: 100, remainingShares: 100 },
        { id: "t3", entryPrice: 47, shares: 100, remainingShares: 100 },
      ],
      computedShares: 300,
      verifiedUnits: 100,
    });
    expect(suggested.sort()).toEqual(["t2", "t3"]);
  });

  it("never suggests a trade that already has shares sold against it", () => {
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 10, shares: 100, remainingShares: 40 },
        { id: "t2", entryPrice: 50, shares: 100, remainingShares: 100 },
      ],
      computedShares: 200,
      verifiedUnits: 100,
    });
    expect(suggested).toEqual(["t2"]);
  });

  it("skips a trade that would undershoot into a shortfall, trying a different one instead", () => {
    // Gap is 50, but the lowest-priced trade is 100 shares — removing it
    // would leave 250 computed vs. 300 verified (a new shortfall), so it's
    // skipped in favor of the 50-share trade that closes the gap exactly.
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "big", entryPrice: 10, shares: 100, remainingShares: 100 },
        { id: "exact", entryPrice: 20, shares: 50, remainingShares: 50 },
      ],
      computedShares: 350,
      verifiedUnits: 300,
    });
    expect(suggested).toEqual(["exact"]);
  });

  it("returns an empty list when nothing is deletable", () => {
    const suggested = suggestDuplicateTradeIds({
      openTrades: [{ id: "t1", entryPrice: 10, shares: 100, remainingShares: 40 }],
      computedShares: 100,
      verifiedUnits: 0,
    });
    expect(suggested).toEqual([]);
  });

  it("returns an empty list for an empty trade list", () => {
    expect(suggestDuplicateTradeIds({ openTrades: [], computedShares: 0, verifiedUnits: 0 })).toEqual([]);
  });
});

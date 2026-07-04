import { describe, it, expect } from "vitest";
import { reconcilePositions, acceptComputedAsVerified } from "./reconciliation";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
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

describe("acceptComputedAsVerified", () => {
  it("saves a manual verification with the given share count", async () => {
    const repos = createFakeRepositories();
    await acceptComputedAsVerified(repos, "p1", "comi", 42);
    const saved = await repos.verifications.getLatest("p1", "COMI");
    expect(saved?.units).toBe(42);
    expect(saved?.source).toBe("manual");
  });
});

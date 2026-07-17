import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import { findDuplicateTradeGroups, cleanupDuplicateTrades } from "./duplicateTradeCleanup";

/**
 * Real user-reported bug: re-uploading the same broker Excel export across
 * separate sessions committed the same real Buy execution as a brand-new
 * `Trade` row each time. Every affected lot ends up with two (or more)
 * identical rows (same ticker/date/time/shares/price) — confirmed directly
 * from the user's own Trades page screenshot (e.g. two "ELKA 26 Oct 2022
 * 1,500 shares Open" rows for what the broker's own order history proves is
 * a single real execution). Some duplicate pairs had their Sell applied to
 * only ONE copy, leaving the other stuck open forever — exactly why a
 * genuinely fully-closed position still shows shares open in Holdings.
 */

function lot(overrides: Partial<Parameters<typeof createTrade>[0]> & { remainingShares?: number }): Trade {
  const trade = createTrade({
    id: overrides.id ?? "t",
    portfolioId: "p1",
    ticker: "ELKA",
    shares: 1500,
    entryPrice: 1.11,
    executionDate: "2022-10-26",
    executionTime: "11:22AM",
    ...overrides,
  });
  return { ...trade, remainingShares: overrides.remainingShares ?? trade.shares };
}

describe("findDuplicateTradeGroups", () => {
  it("groups two untouched exact duplicates and marks the extra one removable", () => {
    const a = lot({ id: "a" });
    const b = lot({ id: "b" });
    const groups = findDuplicateTradeGroups([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ambiguous).toBe(false);
    expect(groups[0].keep.map((t) => t.id)).toEqual(["a"]);
    expect(groups[0].removable.map((t) => t.id)).toEqual(["b"]);
  });

  it("keeps the copy with real sell history and removes only the untouched duplicate", () => {
    const sold = lot({ id: "sold", remainingShares: 0 });
    const phantom = lot({ id: "phantom" }); // still fully open
    const groups = findDuplicateTradeGroups([sold, phantom]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keep.map((t) => t.id)).toEqual(["sold"]);
    expect(groups[0].removable.map((t) => t.id)).toEqual(["phantom"]);
  });

  it("removes every untouched copy when three duplicates exist and only one was ever sold", () => {
    const sold = lot({ id: "sold", remainingShares: 0 });
    const phantom1 = lot({ id: "p1id" });
    const phantom2 = lot({ id: "p2id" });
    const groups = findDuplicateTradeGroups([sold, phantom1, phantom2]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keep.map((t) => t.id)).toEqual(["sold"]);
    expect(groups[0].removable.map((t) => t.id).sort()).toEqual(["p1id", "p2id"]);
  });

  it("flags a group ambiguous (touches nothing) when two duplicates were independently PARTIALLY sold to different remaining counts", () => {
    const partialA = lot({ id: "pa", remainingShares: 500 });
    const partialB = lot({ id: "pb", remainingShares: 900 });
    const groups = findDuplicateTradeGroups([partialA, partialB]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ambiguous).toBe(true);
    expect(groups[0].removable).toHaveLength(0);
  });

  it("never groups two real twin lots that differ by execution time — the legitimate case this app's own architecture already accounts for", () => {
    const fillA = lot({ id: "fillA", executionTime: "2:01PM" });
    const fillB = lot({ id: "fillB", executionTime: "2:02PM" });
    const groups = findDuplicateTradeGroups([fillA, fillB]);
    expect(groups).toHaveLength(0);
  });

  it("ignores a ticker/date/price/shares combination that only appears once", () => {
    const single = lot({ id: "solo" });
    expect(findDuplicateTradeGroups([single])).toHaveLength(0);
  });

  it("scopes grouping to the same portfolio — two portfolios legitimately holding the identical-looking lot are never cross-matched", () => {
    const a = lot({ id: "a", portfolioId: "p1" });
    const b = lot({ id: "b", portfolioId: "p2" });
    expect(findDuplicateTradeGroups([a, b])).toHaveLength(0);
  });
});

describe("cleanupDuplicateTrades", () => {
  it("deletes only the identified removable trades via the real deleteTrade, refunding cash and leaving the kept trade untouched", async () => {
    const portfolio = createPortfolio({ id: "p1", name: "Old School", kind: "Investment", initialCash: 100_000 });
    const kept = lot({ id: "sold", remainingShares: 0 });
    const removed = lot({ id: "phantom" });
    const repos = createFakeRepositories({ portfolios: [portfolio], trades: [kept, removed] });

    const groups = findDuplicateTradeGroups([kept, removed]);
    const report = await cleanupDuplicateTrades(repos, groups);

    expect(report.tradesDeleted).toBe(1);
    expect(report.errors).toHaveLength(0);
    expect(report.ambiguousGroups).toHaveLength(0);

    const remaining = await repos.trades.getByPortfolio("p1");
    expect(remaining.map((t) => t.id)).toEqual(["sold"]);

    // deleteTrade refunds the removed lot's own cost (1500 * 1.11) back to cash.
    const updatedPortfolio = await repos.portfolios.getById("p1");
    expect(updatedPortfolio?.cash).toBeCloseTo(100_000 + 1500 * 1.11, 6);
  });

  it("never touches an ambiguous group's trades", async () => {
    const portfolio = createPortfolio({ id: "p1", name: "Old School", kind: "Investment", initialCash: 100_000 });
    const partialA = lot({ id: "pa", remainingShares: 500 });
    const partialB = lot({ id: "pb", remainingShares: 900 });
    const repos = createFakeRepositories({ portfolios: [portfolio], trades: [partialA, partialB] });

    const groups = findDuplicateTradeGroups([partialA, partialB]);
    const report = await cleanupDuplicateTrades(repos, groups);

    expect(report.tradesDeleted).toBe(0);
    expect(report.ambiguousGroups).toHaveLength(1);
    expect(await repos.trades.getByPortfolio("p1")).toHaveLength(2);
  });
});

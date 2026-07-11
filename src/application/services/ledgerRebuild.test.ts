import { describe, it, expect } from "vitest";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";
import type { Upload, ParsedTradeCandidate } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { Portfolio } from "@domain/entities/Portfolio";
import { buildCanonicalTrades, dryRunLedgerRebuild, applyLedgerRebuild } from "./ledgerRebuild";

function upload(id: string, candidates: ParsedTradeCandidate[], status: Upload["status"] = "parsed"): Upload {
  return { id, fileName: `${id}.png`, fileHash: id, contentType: "image/png", status, candidates, createdAt: "2026-01-01T00:00:00Z" };
}

function buy(over: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return { ticker: "COMI", side: "BUY", shares: 100, price: 10, date: "2026-01-05", ...over };
}
function sell(over: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return { ticker: "COMI", side: "SELL", shares: 100, price: 12, date: "2026-01-10", ...over };
}

function portfolio(id = "p1"): Portfolio {
  return { id, name: "Main", kind: "Investment", currency: "EGP", cash: 100_000, createdAt: "2026-01-01T00:00:00Z" };
}

describe("buildCanonicalTrades", () => {
  it("produces one canonical buy per real execution", () => {
    const { buys } = buildCanonicalTrades([upload("u1", [buy()])]);
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({ ticker: "COMI", side: "BUY", shares: 100, price: 10 });
    expect(buys[0].sourceUploadIds).toEqual(["u1"]);
  });

  it("collapses the same real execution read from two documents into one canonical buy, keeping both sources", () => {
    const { buys } = buildCanonicalTrades([
      upload("statement", [buy({ source: "statement", price: 10 })]),
      upload("invoice", [buy({ source: "invoice", price: 10.02, fees: 5 })]),
    ]);
    expect(buys).toHaveLength(1);
    // invoice-sourced field (fees) backfilled onto the survivor via completeCandidateFieldsFromSiblings.
    expect(buys[0].fees).toBe(5);
    expect(buys[0].sourceUploadIds.sort()).toEqual(["invoice", "statement"]);
  });

  it("never double-counts a Statement row that aggregates several other-source executions", () => {
    const { buys } = buildCanonicalTrades([
      upload("statement", [buy({ source: "statement", shares: 5500, price: 10 })]),
      upload("orders", [
        buy({ source: "orders-screen", shares: 1500, price: 10, time: "10:01" }),
        buy({ source: "orders-screen", shares: 1500, price: 10, time: "10:15" }),
        buy({ source: "orders-screen", shares: 1000, price: 10, time: "10:30" }),
        buy({ source: "orders-screen", shares: 1500, price: 10, time: "10:45" }),
      ]),
    ]);
    expect(buys).toHaveLength(4);
    expect(buys.reduce((s, b) => s + b.shares, 0)).toBe(5500);
    // Each execution's canonical record folds in the confirming Statement row too.
    expect(buys[0].sourceUploadIds).toContain("statement");
  });

  it("keeps sells separate from buys and ignores unparsed uploads", () => {
    const { buys, sells } = buildCanonicalTrades([
      upload("u1", [buy(), sell()]),
      upload("u2", [buy({ shares: 999 })], "failed"),
    ]);
    expect(buys).toHaveLength(1);
    expect(sells).toHaveLength(1);
  });

  it("returns nothing for an empty upload set", () => {
    expect(buildCanonicalTrades([])).toEqual({ buys: [], sells: [] });
  });
});

describe("dryRunLedgerRebuild", () => {
  it("flags a canonical Buy with no ledger counterpart as missing", async () => {
    const repos = createFakeRepositories({ portfolios: [portfolio()], uploads: [upload("u1", [buy()])] });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.tradesToAdd).toHaveLength(1);
    expect(report.tradesToAdd[0].canonical.ticker).toBe("COMI");
    expect(report.tradesToRemove).toEqual([]);
  });

  it("flags an existing trade with no supporting source document as extraneous, and whether it's safely removable", async () => {
    const trade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const untouchedRepos = createFakeRepositories({ portfolios: [portfolio()], trades: [trade], uploads: [] });
    const untouchedReport = await dryRunLedgerRebuild(untouchedRepos);
    expect(untouchedReport.tradesToRemove).toHaveLength(1);
    expect(untouchedReport.tradesToRemove[0].blockedByAllocations).toBe(false);

    const partiallySold = { ...trade, remainingShares: 40 };
    const soldRepos = createFakeRepositories({ portfolios: [portfolio()], trades: [partiallySold], uploads: [] });
    const soldReport = await dryRunLedgerRebuild(soldRepos);
    expect(soldReport.tradesToRemove[0].blockedByAllocations).toBe(true);
  });

  it("matches a canonical Buy against its existing trade and reports no diff when every field agrees", async () => {
    const trade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const repos = createFakeRepositories({ portfolios: [portfolio()], trades: [trade], uploads: [upload("u1", [buy()])] });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.tradesToAdd).toEqual([]);
    expect(report.tradesToRemove).toEqual([]);
    expect(report.tradesToModify).toEqual([]);
  });

  it("flags a companyName mismatch as auto-applicable, but a price mismatch as requiring manual correction", async () => {
    const trade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", companyName: "Old Name", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      trades: [trade],
      uploads: [upload("u1", [buy({ companyName: "Commercial International Bank" })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.tradesToModify).toHaveLength(1);
    expect(report.tradesToModify[0].autoApplicable).toBe(true);
    expect(report.tradesToModify[0].changes).toEqual([{ field: "companyName", existing: "Old Name", canonical: "Commercial International Bank" }]);

    const tradeWrongPrice = createTrade({ id: "t2", portfolioId: "p1", ticker: "EAST", shares: 50, entryPrice: 99, executionDate: "2026-02-01", executionTime: "10:00" });
    const repos2 = createFakeRepositories({
      portfolios: [portfolio()],
      trades: [tradeWrongPrice],
      uploads: [upload("u2", [buy({ ticker: "EAST", shares: 50, price: 20, date: "2026-02-01" })])],
    });
    const report2 = await dryRunLedgerRebuild(repos2);
    expect(report2.tradesToModify).toHaveLength(1);
    expect(report2.tradesToModify[0].autoApplicable).toBe(false);
    expect(report2.tradesToModify[0].changes.some((c) => c.field === "price")).toBe(true);
  });

  it("flags a canonical Sell aggregate missing from the ledger, and an existing sell order unsupported by any source document", async () => {
    const buyTrade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const orphanAllocation = createTradeAllocation({
      id: "a1", sellGroupId: "sg1", portfolioId: "p1", tradeId: "t1", ticker: "COMI", sharesClosed: 40, exitPrice: 12, executionDate: "2026-01-10", executionTime: "10:00",
    });
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      trades: [{ ...buyTrade, remainingShares: 60 }],
      allocations: [orphanAllocation],
      uploads: [upload("u1", [buy(), sell({ shares: 55 })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.sellsToAdd).toHaveLength(1);
    expect(report.sellsToAdd[0].canonical.shares).toBe(55);
    expect(report.sellsExtraneous).toHaveLength(1);
    expect(report.sellsExtraneous[0].group.totalShares).toBe(40);
  });

  it("reports a holdings contradiction when the canonical calculated remaining disagrees with the latest verification, and none when they agree", async () => {
    const verification: PositionVerification = { id: "v1", portfolioId: "p1", ticker: "COMI", units: 200, capturedAt: "2026-01-06", source: "screenshot" };
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      verifications: [verification],
      uploads: [upload("u1", [buy({ shares: 100 })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.holdingsMismatches).toHaveLength(1);
    expect(report.holdingsMismatches[0]).toMatchObject({ ticker: "COMI", calculatedRemaining: 100, verifiedUnits: 200 });

    const agreeingVerification: PositionVerification = { ...verification, units: 100 };
    const repos2 = createFakeRepositories({
      portfolios: [portfolio()],
      verifications: [agreeingVerification],
      uploads: [upload("u1", [buy({ shares: 100 })])],
    });
    const report2 = await dryRunLedgerRebuild(repos2);
    expect(report2.holdingsMismatches).toEqual([]);
  });

  // The exact bug this migration fixed: Rebuild used to compare calculated
  // remaining against Holdings with no concept of source at all, so an
  // official-broker-excel-sourced ticker with a disagreeing screenshot still
  // showed a "Holdings Mismatch" here even though Import's checkTickerMatch
  // would call the identical ticker "broker-excel-verified" and never ask
  // for a screenshot. Both engines now share one call to checkTickerMatch.
  it("never flags a holdings mismatch for a ticker whose complete canonical history is official-broker-excel-sourced, even against a disagreeing screenshot", async () => {
    const verification: PositionVerification = { id: "v1", portfolioId: "p1", ticker: "PHAR", units: 999, capturedAt: "2026-01-06", source: "screenshot" };
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      verifications: [verification],
      uploads: [upload("u1", [buy({ ticker: "PHAR", shares: 100, source: "official-broker-excel" })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.holdingsMismatches).toEqual([]);
  });

  it("still flags a genuine holdings mismatch for a non-Excel-sourced ticker disagreeing with a screenshot", async () => {
    const verification: PositionVerification = { id: "v1", portfolioId: "p1", ticker: "COMI", units: 999, capturedAt: "2026-01-06", source: "screenshot" };
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      verifications: [verification],
      uploads: [upload("u1", [buy({ ticker: "COMI", shares: 100, source: "statement" })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.holdingsMismatches).toHaveLength(1);
    expect(report.holdingsMismatches[0]).toMatchObject({ ticker: "COMI", calculatedRemaining: 100, verifiedUnits: 999 });
  });

  it("never flags a holdings mismatch for a ticker whose complete canonical history is invoice-sourced, when no screenshot exists to disagree with", async () => {
    // Per checkTickerMatch's own policy, invoice-verified (unlike
    // broker-excel-verified) only ever substitutes for a MISSING screenshot
    // — a real, present disagreement still blocks, for either engine.
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      uploads: [upload("u1", [buy({ ticker: "SWDY", shares: 100, source: "invoice" })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.holdingsMismatches).toEqual([]);
  });

  it("preserves the surviving canonical row's own source — the invoice donor, not the statement it corroborates — after a cross-source merge", async () => {
    const { buys } = buildCanonicalTrades([
      upload("statement", [buy({ source: "statement", price: 10 })]),
      upload("invoice", [buy({ source: "invoice", price: 10.02, fees: 5 })]),
    ]);
    expect(buys).toHaveLength(1);
    expect(buys[0].source).toBe("invoice");
  });

  it("never reads Trade/TradeAllocation as reconstruction input — an existing trade with no upload has zero influence on tradesToAdd", async () => {
    const trade = createTrade({ id: "t1", portfolioId: "p1", ticker: "ORHD", shares: 500, entryPrice: 3, executionDate: "2026-01-01", executionTime: "10:00" });
    const repos = createFakeRepositories({ portfolios: [portfolio()], trades: [trade], uploads: [] });
    const { buys } = buildCanonicalTrades(await repos.uploads.getAll());
    expect(buys).toEqual([]); // the committed trade is invisible to canonicalization
  });
});

describe("applyLedgerRebuild", () => {
  it("adds a missing trade only when a portfolio is supplied for it, skipping unassigned ones", async () => {
    const repos = createFakeRepositories({ portfolios: [portfolio()], uploads: [upload("u1", [buy(), buy({ ticker: "EAST", date: "2026-02-01" })])] });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.tradesToAdd).toHaveLength(2);

    const comiKey = report.tradesToAdd.find((a) => a.canonical.ticker === "COMI")!.canonical.key;
    const result = await applyLedgerRebuild(repos, report, { addToPortfolioByKey: { [comiKey]: "p1" }, removeTradeIds: [], modifyTradeIds: [] });
    expect(result.added).toBe(1);
    const trades = await repos.trades.getAll();
    expect(trades).toHaveLength(1);
    expect(trades[0].ticker).toBe("COMI");
  });

  it("removes only an unblocked extraneous trade, skipping one with allocations against it", async () => {
    const removable = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const blocked = { ...createTrade({ id: "t2", portfolioId: "p1", ticker: "EAST", shares: 50, entryPrice: 5, executionDate: "2026-01-01", executionTime: "10:00" }), remainingShares: 10 };
    const repos = createFakeRepositories({ portfolios: [portfolio()], trades: [removable, blocked], uploads: [] });
    const report = await dryRunLedgerRebuild(repos);
    expect(report.tradesToRemove).toHaveLength(2);

    const result = await applyLedgerRebuild(repos, report, { addToPortfolioByKey: {}, removeTradeIds: ["t1", "t2"], modifyTradeIds: [] });
    expect(result.removed).toBe(1);
    expect(result.skipped).toEqual([{ tradeId: "t2", reason: expect.stringContaining("sold") }]);
    const remaining = await repos.trades.getAll();
    expect(remaining.map((t) => t.id)).toEqual(["t2"]);
  });

  it("applies only cash-safe field corrections, never a cash-affecting one, even if explicitly listed", async () => {
    const trade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", companyName: "Old", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const priceTrade = createTrade({ id: "t2", portfolioId: "p1", ticker: "EAST", shares: 50, entryPrice: 99, executionDate: "2026-02-01", executionTime: "10:00" });
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      trades: [trade, priceTrade],
      uploads: [upload("u1", [buy({ companyName: "Commercial International Bank" }), buy({ ticker: "EAST", shares: 50, price: 20, date: "2026-02-01" })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    const result = await applyLedgerRebuild(repos, report, { addToPortfolioByKey: {}, removeTradeIds: [], modifyTradeIds: ["t1", "t2"] });
    expect(result.modified).toBe(1);
    expect(result.skipped).toEqual([{ tradeId: "t2", reason: expect.stringContaining("manual delete") }]);
    const trades = await repos.trades.getAll();
    expect(trades.find((t) => t.id === "t1")!.companyName).toBe("Commercial International Bank");
    expect(trades.find((t) => t.id === "t2")!.entryPrice).toBe(99); // untouched
  });

  it("never creates or deletes a TradeAllocation, regardless of sell diff contents", async () => {
    const buyTrade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const orphanAllocation = createTradeAllocation({ id: "a1", sellGroupId: "sg1", portfolioId: "p1", tradeId: "t1", ticker: "COMI", sharesClosed: 40, exitPrice: 12, executionDate: "2026-01-10", executionTime: "10:00" });
    const repos = createFakeRepositories({
      portfolios: [portfolio()],
      trades: [{ ...buyTrade, remainingShares: 60 }],
      allocations: [orphanAllocation],
      uploads: [upload("u1", [buy(), sell({ shares: 55 })])],
    });
    const report = await dryRunLedgerRebuild(repos);
    await applyLedgerRebuild(repos, report, { addToPortfolioByKey: {}, removeTradeIds: [], modifyTradeIds: [] });
    const allocations = await repos.allocations.getAll();
    expect(allocations).toEqual([orphanAllocation]); // completely untouched
  });
});

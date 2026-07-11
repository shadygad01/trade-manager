import { describe, it, expect } from "vitest";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import { createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { dryRunProvenanceRepair, applyProvenanceRepair } from "./provenanceRepair";
import { isTickerFullyOfficialBrokerExcelSourced } from "./reconciliation";
import type { CommitEngineRepos } from "./commitEngine";

function repos(seed: RawTransaction[]): CommitEngineRepos {
  return {
    rawTransactions: createFakeRawTransactionRepository(seed),
    committedLedger: createFakeCommittedLedgerRepository(),
  };
}

/** Exactly what the pre-fix ensureSellFacts left behind: the correctly-sourced extraction-time fact, orphaned; a wrongly-"manual" duplicate the ledger's decision actually references. */
function corruptedCloheLikeFixture(): RawTransaction[] {
  return [
    {
      ...createRawTransaction({
        id: "buy-1",
        portfolioId: "p1",
        kind: "BuyExecution",
        source: "official-broker-excel",
        ticker: "CLHO",
        payload: { ticker: "CLHO", shares: 3000, price: 0.38, executionDate: "2022-11-02", executionTime: "10:00" },
      }),
      seq: 1,
    },
    {
      ...createRawTransaction({
        id: "sell-correct-orphaned",
        portfolioId: "p1",
        kind: "SellExecution",
        source: "official-broker-excel",
        ticker: "CLHO",
        payload: { ticker: "CLHO", shares: 3000, price: 0.5, executionDate: "2022-11-10", executionTime: "10:00" },
      }),
      seq: 2,
    },
    {
      ...createRawTransaction({
        id: "sell-wrong-operative",
        portfolioId: "p1",
        kind: "SellExecution",
        source: "manual",
        ticker: "CLHO",
        payload: { ticker: "CLHO", shares: 3000, price: 0.5, executionDate: "2022-11-10", executionTime: "10:00" },
      }),
      seq: 3,
    },
    {
      ...createRawTransaction({
        id: "decision-1",
        portfolioId: "p1",
        kind: "SellAllocationDecision",
        source: "manual",
        ticker: "CLHO",
        payload: { sellExecutionId: "sell-wrong-operative", allocations: [{ lotRef: "buy-1", shares: 3000 }] },
      }),
      seq: 4,
    },
  ];
}

describe("dryRunProvenanceRepair", () => {
  it("finds a decision referencing a wrongly-'manual'-sourced fact when a correctly-sourced unclaimed twin exists", async () => {
    const report = await dryRunProvenanceRepair(repos(corruptedCloheLikeFixture()));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      ticker: "CLHO",
      decisionId: "decision-1",
      wrongFactId: "sell-wrong-operative",
      wrongSource: "manual",
      correctFactId: "sell-correct-orphaned",
      correctSource: "official-broker-excel",
    });
  });

  it("finds nothing for a genuinely manual sell with no unclaimed twin of the same value", async () => {
    const facts: RawTransaction[] = [
      { ...createRawTransaction({ id: "buy-1", portfolioId: "p1", kind: "BuyExecution", source: "manual", ticker: "COMI", payload: { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-01-05", executionTime: "10:00" } }), seq: 1 },
      { ...createRawTransaction({ id: "sell-1", portfolioId: "p1", kind: "SellExecution", source: "manual", ticker: "COMI", payload: { ticker: "COMI", shares: 100, price: 60, executionDate: "2026-02-01", executionTime: "11:00" } }), seq: 2 },
      { ...createRawTransaction({ id: "decision-1", portfolioId: "p1", kind: "SellAllocationDecision", source: "manual", ticker: "COMI", payload: { sellExecutionId: "sell-1", allocations: [{ lotRef: "buy-1", shares: 100 }] } }), seq: 3 },
    ];
    const report = await dryRunProvenanceRepair(repos(facts));
    expect(report.findings).toHaveLength(0);
  });

  it("finds nothing when the referenced fact is already correctly sourced", async () => {
    const facts: RawTransaction[] = [
      { ...createRawTransaction({ id: "buy-1", portfolioId: "p1", kind: "BuyExecution", source: "official-broker-excel", ticker: "CLHO", payload: { ticker: "CLHO", shares: 3000, price: 0.38, executionDate: "2022-11-02", executionTime: "10:00" } }), seq: 1 },
      { ...createRawTransaction({ id: "sell-1", portfolioId: "p1", kind: "SellExecution", source: "official-broker-excel", ticker: "CLHO", payload: { ticker: "CLHO", shares: 3000, price: 0.5, executionDate: "2022-11-10", executionTime: "10:00" } }), seq: 2 },
      { ...createRawTransaction({ id: "decision-1", portfolioId: "p1", kind: "SellAllocationDecision", source: "manual", ticker: "CLHO", payload: { sellExecutionId: "sell-1", allocations: [{ lotRef: "buy-1", shares: 3000 }] } }), seq: 3 },
    ];
    const report = await dryRunProvenanceRepair(repos(facts));
    expect(report.findings).toHaveLength(0);
  });
});

describe("applyProvenanceRepair", () => {
  it("retracts the wrong fact and its decision, re-points a replacement decision at the correct fact, and the ticker becomes fully Excel-sourced", async () => {
    const r = repos(corruptedCloheLikeFixture());
    const report = await dryRunProvenanceRepair(r);
    const result = await applyProvenanceRepair(r, report.findings);

    expect(result.repaired).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const all = await r.rawTransactions.getAll();
    const retractions = all.filter((t) => t.kind === "Retraction");
    const retractedIds = new Set(retractions.map((t) => (t.payload as { targetId: string }).targetId));
    expect(retractedIds.has("sell-wrong-operative")).toBe(true);
    expect(retractedIds.has("decision-1")).toBe(true);

    const liveDecisions = all.filter((t) => t.kind === "SellAllocationDecision" && !retractedIds.has(t.id));
    expect(liveDecisions).toHaveLength(1);
    expect((liveDecisions[0].payload as { sellExecutionId: string; allocations: unknown }).sellExecutionId).toBe("sell-correct-orphaned");
    expect((liveDecisions[0].payload as { allocations: { lotRef: string; shares: number }[] }).allocations).toEqual([
      { lotRef: "buy-1", shares: 3000 },
    ]);

    expect(isTickerFullyOfficialBrokerExcelSourced(all, "CLHO")).toBe(true);
  });

  it("never touches unrelated tickers' facts", async () => {
    const facts = [
      ...corruptedCloheLikeFixture(),
      { ...createRawTransaction({ id: "buy-comi", portfolioId: "p1", kind: "BuyExecution", source: "manual", ticker: "COMI", payload: { ticker: "COMI", shares: 10, price: 5, executionDate: "2026-01-01", executionTime: "10:00" } }), seq: 5 },
    ];
    const r = repos(facts);
    const report = await dryRunProvenanceRepair(r);
    await applyProvenanceRepair(r, report.findings);

    const all = await r.rawTransactions.getAll();
    const comiFact = all.find((t) => t.id === "buy-comi");
    expect(comiFact?.source).toBe("manual"); // untouched
    const retractions = all.filter((t) => t.kind === "Retraction");
    expect(retractions.every((t) => (t.payload as { targetId: string }).targetId !== "buy-comi")).toBe(true);
  });

  it("skips a finding whose underlying facts already changed since the dry-run report — never acts on stale data", async () => {
    const r = repos(corruptedCloheLikeFixture());
    const report = await dryRunProvenanceRepair(r);

    // Simulate something else already having retracted the wrong fact
    // between dry-run and apply (e.g. a concurrent action).
    const { retractRawTransaction } = await import("./commitEngine");
    await retractRawTransaction(r, "sell-wrong-operative", "unrelated concurrent action");

    const result = await applyProvenanceRepair(r, report.findings);
    expect(result.repaired).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });
});

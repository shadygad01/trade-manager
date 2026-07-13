// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { createRawTransaction, type RawTransaction, type RetractionPayload, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import { createTrade } from "@domain/entities/Trade";
import { shouldCommit, commitTicker } from "@application/services/commitEngine";
import { createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";

/**
 * Phase 9.7, task 5: proves Skip/Dismiss/Discard actions now emit a
 * RawTransaction Retraction (not just a localStorage session flag), and that
 * the canonical rebuild (commitEngine.commitTicker) correctly excludes the
 * retracted row afterward — the two things the audit's "blocker 1" gap
 * report said were still missing after Phase 9.6.
 *
 * Same seam as the sibling autoAssignPortfolio/reconciliation test files:
 * real ImportPage rendered against an in-memory repos mock, pending pool
 * seeded directly into localStorage (bypassing the OCR orchestrator). The
 * exact-duplicate auto-skip effect is the trigger here — it needs no button
 * interaction (fires automatically once a pending candidate matches an
 * existing committed trade), and it shares the exact same
 * retractRawTransactionKeys helper every other Skip/Dismiss/Discard site in
 * ImportPage.tsx now calls, so this is a faithful proof of the mechanism.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  allocations: [] as TradeAllocation[],
  verifications: [] as PositionVerification[],
  rawTransactions: [] as RawTransaction[],
  nextSeq: 0,
}));

vi.mock("@presentation/lib/data", () => ({
  diagnostics: { recordSessionEvent() {}, recordWrite() {}, recordRead() {}, recordDecision() {}, recordRuleExecution() {}, recordPerfSample() {} },
  repos: {
    portfolios: {
      getAll: () => Promise.resolve(state.portfolios),
      getById: (id: string) => Promise.resolve(state.portfolios.find((p) => p.id === id)),
      save: () => Promise.resolve(),
    },
    trades: {
      getAll: () => Promise.resolve(state.trades),
      getById: (id: string) => Promise.resolve(state.trades.find((t) => t.id === id)),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    allocations: { getAll: () => Promise.resolve(state.allocations), save: () => Promise.resolve() },
    verifications: { getAll: () => Promise.resolve(state.verifications), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    timeline: { getAll: () => Promise.resolve([]), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    uploads: { getAll: () => Promise.resolve([]), getByHash: () => Promise.resolve(undefined), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    journal: { getByTrade: () => Promise.resolve(undefined) },
    prices: { getAllPrices: () => Promise.resolve({}), getSnapshotInfo: () => Promise.resolve(undefined) },
    rawTransactions: {
      getAll: () => Promise.resolve(state.rawTransactions),
      getByPortfolio: (portfolioId: string) => Promise.resolve(state.rawTransactions.filter((t) => t.portfolioId === portfolioId)),
      getByTicker: (ticker: string) => Promise.resolve(state.rawTransactions.filter((t) => t.ticker === ticker)),
      getById: (id: string) => Promise.resolve(state.rawTransactions.find((t) => t.id === id)),
      append: (t: Omit<RawTransaction, "seq">) => {
        state.nextSeq += 1;
        const record = { ...t, seq: state.nextSeq } as RawTransaction;
        state.rawTransactions.push(record);
        return Promise.resolve(record);
      },
    },
    committedLedger: {
      getLedgerEvents: () => Promise.resolve([]),
      getAllocations: () => Promise.resolve([]),
      commitTicker: () => Promise.resolve(),
    },
  },
  getImportOrchestrator: () => Promise.reject(new Error("not used in this test")),
}));

// The pending candidate's key ("dup-1") matches the RawTransaction id seeded
// below — exactly what recordImportedRawTransactions now guarantees (Phase
// 9.7, task 1) for any row extracted after this change ships.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      { key: "dup-1", candidate: { ticker: "COMI", side: "BUY", shares: 100, price: 45.5, date: "2026-02-01", confidence: "high", source: "statement" } },
    ],
    pendingVerifications: [],
    pendingDividends: [],
    pendingOrderEvidences: [],
    discardedCandidates: [],
    addedKeys: [],
    acceptedKeys: [],
    skippedKeys: [],
    dismissedKeys: [],
    addedTradeIds: {},
    addedAllocationIds: {},
    tickerPortfolio: {},
    uploadSeq: 1,
    filesProcessed: 1,
  }),
);

const { ImportPage } = await import("./ImportPage");

describe("Skip/Dismiss/Discard actions emit a RawTransaction Retraction (Phase 9.7)", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Only Portfolio", kind: "Trading", initialCash: 1_000_000 })];
    // The exact-duplicate this pending candidate will auto-skip against.
    state.trades = [
      createTrade({ id: "existing-trade-1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-02-01", executionTime: "10:00" }),
    ];
    state.allocations = [];
    state.verifications = [];
    state.nextSeq = 0;

    // Mirrors what recordImportedRawTransactions (Phase 9.7's authoritative
    // write) already wrote for the seeded pending candidate, with the same
    // id as its session key.
    const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" };
    state.rawTransactions = [{ ...createRawTransaction({ id: "dup-1", kind: "BuyExecution", source: "statement", ticker: "COMI", payload }), seq: 1 }];
  });

  // One combined test, not two — importSession is a true module-level
  // singleton (backed by localStorage, loaded once at import time), so a
  // second `it()` in this file would see the first test's already-mutated
  // skippedKeys and never re-fire the auto-skip effect. Sequencing both
  // assertions here (retraction fires, then rebuild excludes it) avoids that
  // cross-test leakage entirely rather than fighting it with extra reset
  // plumbing.
  it("auto-skipping an exact-duplicate candidate appends a Retraction targeting its own RawTransaction id, and commitEngine's rebuild then excludes it", async () => {
    render(<ImportPage />);

    await waitFor(() => {
      const retractions = state.rawTransactions.filter(
        (t): t is RawTransaction & { payload: RetractionPayload } => t.kind === "Retraction",
      );
      expect(retractions).toHaveLength(1);
      expect(retractions[0].payload.targetId).toBe("dup-1");
    });

    // The original BuyExecution is untouched (immutable) — only a new
    // Retraction fact was appended, per RawTransaction.ts's own contract.
    const original = state.rawTransactions.find((t) => t.id === "dup-1")!;
    expect(original.kind).toBe("BuyExecution");

    // Assign the retracted (still-unassigned) BuyExecution to a portfolio,
    // as a real cutover caller eventually would, and rebuild.
    const commitRepos = {
      rawTransactions: {
        getAll: () => Promise.resolve(state.rawTransactions),
        getByPortfolio: (portfolioId: string) => Promise.resolve(state.rawTransactions.filter((t) => t.portfolioId === portfolioId)),
        getByTicker: (ticker: string) => Promise.resolve(state.rawTransactions.filter((t) => t.ticker === ticker)),
        getById: (id: string) => Promise.resolve(state.rawTransactions.find((t) => t.id === id)),
        append: (t: Omit<RawTransaction, "seq">) => {
          state.nextSeq += 1;
          const record = { ...t, seq: state.nextSeq } as RawTransaction;
          state.rawTransactions.push(record);
          return Promise.resolve(record);
        },
      },
      committedLedger: createFakeCommittedLedgerRepository(),
    };

    // Directly assign the target row (bypassing assignPortfolio's own
    // ticker-wide semantics — this test only needs the one row) so
    // commitTicker has something in scope to evaluate.
    const target = state.rawTransactions.find((t) => t.id === "dup-1")!;
    target.portfolioId = "p1";

    expect(await shouldCommit(commitRepos, "p1", "COMI")).toBe(false); // nothing live left to verify — the only candidate is retracted
    await commitTicker(commitRepos, "p1", "COMI");
    expect(await commitRepos.committedLedger.getLedgerEvents("p1", "COMI")).toEqual([]);
  });
});

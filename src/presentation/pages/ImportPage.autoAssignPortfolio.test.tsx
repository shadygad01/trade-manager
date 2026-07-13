// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { createRawTransaction, type RawTransaction, type PortfolioAssignmentPayload, type BuyExecutionPayload } from "@domain/entities/RawTransaction";

/**
 * Regression coverage for a code-review finding: resolvedPortfolioId can
 * resolve a ticker's portfolio IMPLICITLY (a single-portfolio app, here —
 * or a ticker already uniquely tied to one portfolio) without the user ever
 * touching the per-ticker dropdown. setTickerPortfolio's assignPortfolio
 * dual-write only fires from that dropdown's onChange, so an implicitly
 * resolved ticker used to commit its Buy to the legacy ledger while its
 * already-recorded RawTransaction (written earlier by processFiles' own
 * dual-write) stayed permanently unassigned — never reaching the new
 * architecture's commit trigger at all. commitTickerGroup now calls
 * assignPortfolio itself, on every commit, regardless of how the portfolio
 * resolved. Same seam as the sibling reconciliation/aggregateStatement test
 * files (real ImportPage against an in-memory repos mock) — the pending pool
 * is seeded directly into localStorage/session state (bypassing the OCR
 * orchestrator), and the RawTransaction processFiles would have separately
 * written for that same candidate is seeded directly into the rawTransactions
 * fake for the same reason.
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
      save: (p: Portfolio) => {
        const i = state.portfolios.findIndex((existing) => existing.id === p.id);
        if (i >= 0) state.portfolios[i] = p;
        else state.portfolios.push(p);
        return Promise.resolve();
      },
    },
    trades: {
      getAll: () => Promise.resolve(state.trades),
      getById: (id: string) => Promise.resolve(state.trades.find((t) => t.id === id)),
      save: (t: Trade) => {
        const i = state.trades.findIndex((existing) => existing.id === t.id);
        if (i >= 0) state.trades[i] = t;
        else state.trades.push(t);
        return Promise.resolve();
      },
      delete: (id: string) => {
        state.trades = state.trades.filter((t) => t.id !== id);
        return Promise.resolve();
      },
    },
    allocations: {
      getAll: () => Promise.resolve(state.allocations),
      save: (a: TradeAllocation) => {
        state.allocations.push(a);
        return Promise.resolve();
      },
    },
    verifications: {
      getAll: () => Promise.resolve(state.verifications),
      save: (v: PositionVerification) => {
        state.verifications.push(v);
        return Promise.resolve();
      },
      delete: (id: string) => {
        state.verifications = state.verifications.filter((v) => v.id !== id);
        return Promise.resolve();
      },
    },
    timeline: { getAll: () => Promise.resolve([]), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    uploads: {
      getAll: () => Promise.resolve([]),
      getByHash: () => Promise.resolve(undefined),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
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

// importSession.ts reads localStorage once at import time — seed before the
// dynamic import, same as the sibling reconciliation/aggregateStatement tests.
// Deliberately no tickerPortfolio entry: the user never picks from the
// dropdown in this test — resolvedPortfolioId must resolve implicitly via
// "only one portfolio exists". source: "invoice" alone is enough to satisfy
// the match gate (invoice-verified) without needing a broker screenshot or a
// second corroborating document.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "invoice-1",
        candidate: { ticker: "COMI", side: "BUY", shares: 100, price: 50, date: "2026-06-01", confidence: "high", source: "invoice" },
      },
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

describe("Auto-resolved portfolio still triggers the migration dual-write", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Only Portfolio", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [];
    state.allocations = [];
    state.verifications = [];
    state.nextSeq = 0;

    // Mirrors what processFiles' own dual-write (recordImportedRawTransactions)
    // would already have written for the seeded candidate above, before any
    // portfolio was ever picked.
    const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-06-01" };
    state.rawTransactions = [{ ...createRawTransaction({ kind: "BuyExecution", source: "invoice", ticker: "COMI", payload }), seq: 1 }];
  });

  it("assigns the pending RawTransaction for the ticker to the app's only portfolio, with no dropdown interaction", async () => {
    render(<ImportPage />);

    const confirmButton = await screen.findByRole("button", { name: "Confirm COMI" });
    await userEvent.click(confirmButton);

    await waitFor(() => expect(state.trades.length).toBeGreaterThan(0));

    // The dropdown's own onChange (setTickerPortfolio) never fired — the
    // portfolio resolved implicitly. Confirming must still have assigned the
    // pre-existing COMI RawTransaction to the app's one portfolio.
    await waitFor(() => {
      const assignments = state.rawTransactions.filter(
        (t): t is RawTransaction & { payload: PortfolioAssignmentPayload } => t.kind === "PortfolioAssignment",
      );
      expect(assignments).toHaveLength(1);
      expect(assignments[0].payload.portfolioId).toBe("p1");
    });

    const buyTransaction = state.rawTransactions.find((t) => t.kind === "BuyExecution")!;
    expect(buyTransaction.portfolioId).toBeUndefined(); // immutable — assignment is a separate fact
  });
});

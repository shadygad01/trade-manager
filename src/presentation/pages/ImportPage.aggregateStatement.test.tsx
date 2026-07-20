// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * End-to-end harness for Statement Aggregate Reconciliation: renders the
 * real ImportPage (same seam as ImportPage.reconciliation.test.tsx) with a
 * pending pool seeded to reproduce the Statement-aggregates-several-
 * executions shape from a real broker Statement (see
 * findAggregateStatementMatches) — no OCR/orchestrator involved, isolating
 * the reconciliation gate + UI. See ImportPage.aggregateStatement-control.test.tsx
 * for the unmatched-case counterpart (own file, same reason
 * reconciliation.test.tsx/reconciliation-control.test.tsx are split: the
 * pending pool is seeded into localStorage once, before importSession's
 * module-level singleton reads it at import time).
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  allocations: [] as TradeAllocation[],
  verifications: [] as PositionVerification[],
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
    rawTransactions: { getAll: () => Promise.resolve([]) },
    uploads: {
      getAll: () => Promise.resolve([]),
      getByHash: () => Promise.resolve(undefined),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    journal: { getByTrade: () => Promise.resolve(undefined) },
    prices: { getAllPrices: () => Promise.resolve({}), getSnapshotInfo: () => Promise.resolve(undefined) },
  },
  getImportOrchestrator: () => Promise.reject(new Error("not used in this test")),
}));

// importSession.ts reads localStorage once at import time (see the sibling
// reconciliation test's identical note) — seed before the dynamic import.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "statement-row",
        candidate: {
          ticker: "ABUK",
          side: "BUY",
          shares: 8000,
          price: 8.0,
          date: "2026-06-01",
          confidence: "high",
          source: "statement",
        },
      },
      {
        key: "order-1",
        candidate: {
          ticker: "ABUK",
          side: "BUY",
          shares: 5000,
          price: 8.0,
          date: "2026-06-01",
          confidence: "high",
          source: "orders-screen",
        },
      },
      {
        key: "order-2",
        candidate: {
          ticker: "ABUK",
          side: "BUY",
          shares: 3000,
          price: 8.0,
          date: "2026-06-01",
          confidence: "high",
          source: "orders-screen",
        },
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

describe("Statement Aggregate Reconciliation, end to end", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Aggregate Test", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [];
    state.allocations = [];
    state.verifications = [];
  });

  it("confirms a Statement row (8,000) against two same-day Orders executions (5,000 + 3,000) with no broker screenshot, without treating the Statement row as a third trade", async () => {
    render(<ImportPage />);

    // The whole ticker-groups section (ImportPage.tsx's `reviewDataSettled`
    // gate) stays hidden until every useLiveQuery — including the ledger
    // data this aggregate match itself doesn't strictly need — has settled,
    // so neither "Needs broker screenshot" going away nor the "Confirmed by
    // Statement" badges appearing is guaranteed by the time the FIRST one is
    // observed; both become true together on the render `reviewDataSettled`
    // flips on. ImportPage's own initial render does substantial synchronous
    // work (many useMemo passes over a large component tree), which can
    // exceed RTL's 1000ms default `waitFor` timeout under a loaded/resource-
    // constrained runner — same reasoning as this suite's other race-
    // condition tests (e.g. ImportPage.brokerExcelLoadRace.test.tsx), which
    // use an explicit longer timeout for exactly this reason.
    await waitFor(() => expect(screen.queryByText("Needs broker screenshot")).toBeNull(), { timeout: 8000 });
    expect(screen.queryByText("Mismatch")).toBeNull();

    const badges = await waitFor(() => {
      const found = screen.getAllByText("Confirmed by Statement");
      expect(found).toHaveLength(2);
      return found;
    }, { timeout: 8000 });
    expect(badges).toHaveLength(2);

    // The Statement row itself never renders as its own candidate row (it
    // would show as an 8,000-share BUY pill) — only the two 5,000/3,000
    // execution rows are visible; committing all three would double the
    // real 8,000 shares to 16,000.
    expect(screen.getAllByText("BUY")).toHaveLength(2);
    expect(screen.getByText("5,000 sh")).toBeInTheDocument();
    expect(screen.getByText("3,000 sh")).toBeInTheDocument();
    expect(screen.queryByText("8,000 sh")).toBeNull();
  }, 15000);
});

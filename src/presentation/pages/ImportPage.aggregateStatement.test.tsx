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

    // The "Confirmed by Statement" badges render as soon as the aggregate
    // match is found (independent of the ledger data useLiveQuery still
    // loading) — but the ticker only flips off "Needs broker screenshot"
    // once the Statement row is actually auto-skipped, which is gated on
    // that same ledger data (initialDataLoaded) resolving one tick later.
    await waitFor(() => expect(screen.queryByText("Needs broker screenshot")).toBeNull());
    expect(screen.queryByText("Mismatch")).toBeNull();

    const badges = screen.getAllByText("Confirmed by Statement");
    expect(badges).toHaveLength(2);

    // The Statement row itself never renders as its own candidate row (it
    // would show as an 8,000-share BUY pill) — only the two 5,000/3,000
    // execution rows are visible; committing all three would double the
    // real 8,000 shares to 16,000.
    expect(screen.getAllByText("BUY")).toHaveLength(2);
    expect(screen.getByText("5,000 sh")).toBeInTheDocument();
    expect(screen.getByText("3,000 sh")).toBeInTheDocument();
    expect(screen.queryByText("8,000 sh")).toBeNull();
  });
});

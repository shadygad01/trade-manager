// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * Control counterpart to ImportPage.aggregateStatement.test.tsx: a Statement
 * row whose share count has no exact matching combination among its
 * same-day executions must stay unmatched and fully visible, exactly like
 * today — Statement Aggregate Reconciliation must never guess a partial sum
 * or silently drop a row nothing explains. Own file for the same reason the
 * positive case is split out: the pending pool is seeded into localStorage
 * once, before importSession's module-level singleton reads it at import
 * time (see reconciliation.test.tsx / reconciliation-control.test.tsx).
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

describe("Statement Aggregate Reconciliation, control: no exact combination exists", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Aggregate Control", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [];
    state.allocations = [];
    state.verifications = [];
  });

  it("leaves the Statement row unmatched and fully visible when no execution group sums to it exactly", async () => {
    render(<ImportPage />);

    await screen.findByText("Needs broker screenshot");
    expect(screen.queryByText("Confirmed by Statement")).toBeNull();
    // All rows still shown for manual review — nothing auto-resolved.
    expect(screen.getAllByText("BUY")).toHaveLength(2);
    expect(screen.getByText("8,000 sh")).toBeInTheDocument();
    expect(screen.getByText("5,000 sh")).toBeInTheDocument();
  });
});

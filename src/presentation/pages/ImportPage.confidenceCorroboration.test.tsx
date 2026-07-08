// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * End-to-end harness for the live corroboration confidence bump
 * (keysToRaiseToHighConfidence, duplicateDetection.ts): a still-pending row
 * whose ticker guess started at "low" confidence but is independently
 * corroborated (two document types agreeing, or a Statement aggregate
 * match) should stop showing "Low-confidence ticker guess" — the badges
 * proving corroboration are strictly stronger evidence than the original
 * OCR-ticker-resolution guess. Same seam as the sibling reconciliation/
 * aggregateStatement test files (real ImportPage against an in-memory repos
 * mock, pending pool seeded into localStorage before importSession's
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

localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      // Two DIFFERENT document types (statement + orders-screen) reading the
      // same low-confidence-ticker-guessed transaction — findCrossSourceVerifiedKeys
      // marks both "Two documents agree"; the corroboration bump should then
      // raise both to "high" and drop the low-confidence badge on both.
      {
        key: "cross-1",
        candidate: {
          ticker: "ARAB",
          side: "BUY",
          shares: 3000,
          price: 0.46,
          date: "2026-06-01",
          confidence: "low",
          source: "statement",
        },
      },
      {
        key: "cross-2",
        candidate: {
          ticker: "ARAB",
          side: "BUY",
          shares: 3000,
          price: 0.46,
          date: "2026-06-01",
          confidence: "low",
          source: "orders-screen",
        },
      },
      // Aggregate case: a low-confidence Orders-screen pair whose shares sum
      // exactly to a same-day Statement row — findAggregateStatementMatches
      // confirms the group; the corroboration bump should raise both.
      {
        key: "stmt-agg",
        candidate: {
          ticker: "ARAB",
          side: "BUY",
          shares: 6000,
          price: 0.5,
          date: "2026-06-02",
          confidence: "high",
          source: "statement",
        },
      },
      {
        key: "agg-1",
        candidate: {
          ticker: "ARAB",
          side: "BUY",
          shares: 3500,
          price: 0.5,
          date: "2026-06-02",
          confidence: "low",
          source: "orders-screen",
        },
      },
      {
        key: "agg-2",
        candidate: {
          ticker: "ARAB",
          side: "BUY",
          shares: 2500,
          price: 0.5,
          date: "2026-06-02",
          confidence: "low",
          source: "orders-screen",
        },
      },
      // Control: a low-confidence row with no corroboration at all — must
      // stay low, proving the bump isn't unconditional.
      {
        key: "uncorroborated",
        candidate: {
          ticker: "ARAB",
          side: "BUY",
          shares: 5950,
          price: 0.48,
          date: "2026-06-03",
          confidence: "low",
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

describe("Live corroboration confidence bump", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Confidence Test", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [];
    state.allocations = [];
    state.verifications = [];
  });

  it("drops the low-confidence badge on rows corroborated by two documents or a Statement aggregate, but keeps it on an uncorroborated row", async () => {
    render(<ImportPage />);

    // The two cross-source-verified rows and the two aggregate-matched rows
    // (4 total) lose "Low-confidence ticker guess"; only the uncorroborated
    // row keeps it.
    await waitFor(() => expect(screen.getAllByText("Low-confidence ticker guess")).toHaveLength(1));

    expect(screen.getAllByText("Two documents agree")).toHaveLength(2);
    expect(screen.getAllByText("Confirmed by Statement")).toHaveLength(2);

    // The uncorroborated row (5,950 sh) is still there with its own badge —
    // proving the bump is conditional, not a blanket "hide all low-confidence" change.
    expect(screen.getByText("5,950 sh")).toBeInTheDocument();
  });
});

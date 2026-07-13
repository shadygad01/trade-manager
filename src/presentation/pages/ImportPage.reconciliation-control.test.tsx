// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * Control counterpart to ImportPage.reconciliation.test.tsx: proves the
 * auto-skip generalization (Buy side now covered, not just Sell) doesn't
 * loosen anything for a genuinely NEW, non-duplicate transaction that
 * doesn't actually reconcile — a real mismatch (e.g. a misread/duplicate
 * buy hiding somewhere, or a missing sell) must still block.
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

// Seeded before the dynamic import — see the sibling reconciliation test for why.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "k1",
        candidate: {
          // A genuinely different execution: different date AND different
          // price/shares than anything on the ledger — not a re-import of
          // the existing trade, and not corroborated by any second document.
          ticker: "COMI",
          side: "BUY",
          shares: 40,
          price: 52,
          date: "2026-06-15",
          time: "11:00",
          confidence: "high",
          source: "statement",
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

describe("Reconciliation control: a genuinely new, non-duplicate, uncorroborated Buy still blocks correctly", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Recon Control", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [
      createTrade({
        id: "t1",
        portfolioId: "p1",
        ticker: "COMI",
        shares: 100,
        entryPrice: 50,
        executionDate: "2026-06-01",
        executionTime: "10:00",
      }),
    ];
    state.allocations = [];
    // The broker screenshot only confirms the 100 shares already on the
    // ledger — it does NOT confirm the new pending 40-share buy, so the
    // real, correct net (140) genuinely disagrees with verifiedUnits (100).
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-06-20T00:00", source: "screenshot" },
    ];
  });

  it("still shows Mismatch — the auto-skip fix never touches a row that isn't an exact/price-close duplicate", async () => {
    render(<ImportPage />);
    const badge = await screen.findByText("Mismatch");
    expect(badge).toBeTruthy();
    expect(screen.queryByText(/Fully matched/)).toBeNull();
  });
});

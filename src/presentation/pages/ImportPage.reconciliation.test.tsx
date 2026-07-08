// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * Reproduction harness for the reconciliation root-cause investigation:
 * renders the real ImportPage against an in-memory repos mock (same seam as
 * PortfolioDetailPage.test.tsx), seeding the pending pool directly via
 * localStorage the same way the app's own OCR pipeline would populate it —
 * no OCR/orchestrator involved, isolating the reconciliation gate itself.
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

// importSession.ts (imported transitively by ImportPage.tsx) reads
// localStorage exactly ONCE into a module-level singleton at import time —
// it never re-reads afterward, only responds to its own .update() calls.
// So the pending pool has to be seeded in localStorage BEFORE the dynamic
// import below, not inside a beforeEach/it — the same reason the earlier
// live-app investigation had to set localStorage before navigating to
// /import rather than after the page had already mounted.
const pendingBuyKey = "k1";
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: pendingBuyKey,
        candidate: {
          ticker: "COMI",
          side: "BUY",
          shares: 100,
          price: 50,
          date: "2026-06-01",
          time: "10:00",
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

describe("Reconciliation root-cause: a re-imported exact-duplicate Buy blocks its own ticker", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Recon Test", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [];
    state.allocations = [];
    state.verifications = [];
  });

  it("shows Mismatch — not Matched — for a ticker whose only pending row exactly duplicates an already-committed trade, even though the ledger and the broker screenshot already agree perfectly", async () => {
    // Ground truth: 100 shares really held, already fully recorded on the
    // ledger, and a broker "My Position" screenshot independently confirms
    // exactly 100 units. Nothing is actually wrong with this position. The
    // pending pool (seeded above, before import) holds one row: the exact
    // same execution re-read from a re-uploaded statement (same
    // ticker/date/shares/price as the trade already on the ledger) —
    // nothing new, just a re-import.
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
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-06-05T00:00", source: "screenshot" },
    ];

    render(<ImportPage />);

    // The duplicate Buy is auto-skipped (it adds nothing new — the exact
    // execution is already on the ledger), which brings the ticker's pending
    // share count back to exactly what's already recorded and already
    // broker-verified. With nothing left to resolve, it collapses out of the
    // active list into the "Fully matched" summary — never shown as blocked.
    await screen.findByText(/Fully matched \(1\)/);
    expect(screen.queryByText("Mismatch")).toBeNull();
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
  });
});

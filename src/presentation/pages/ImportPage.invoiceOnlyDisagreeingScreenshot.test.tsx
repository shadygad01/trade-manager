// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * Policy audit regression: a ticker whose entire committed history is
 * Invoice-sourced (not official-broker-excel) previously got the SAME
 * "authoritative even against a disagreeing My Position screenshot"
 * treatment reserved by checkTickerMatch's own documented policy for
 * official-broker-excel only. Root cause: ImportPage's zero-pending branch
 * fed isTickerFullyOfficialBrokerExcelSourced's rank-based result (true for
 * Invoice too, rank 6 > official-broker-excel's rank 5) straight into
 * allPendingFromOfficialBrokerExcel, which checkTickerMatch checks BEFORE
 * verifiedUnits and never downgrades on disagreement. A real, present
 * mismatch against an Invoice-only ticker's broker screenshot was silently
 * shown as "Verified — official broker Excel" instead of "Mismatch".
 *
 * Fixed by routing the zero-pending, rank-qualifying-but-not-literally-Excel
 * case to allPendingFromInvoice instead (see reconciliation.ts's new
 * isTickerFullyExcelSourced and ImportPage.tsx's updated flag computation).
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  rawTransactions: [] as RawTransaction[],
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
    allocations: { getAll: () => Promise.resolve([]), save: () => Promise.resolve() },
    verifications: {
      getAll: () => Promise.resolve(state.verifications),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    timeline: { getAll: () => Promise.resolve([]), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    rawTransactions: {
      getAll: () => Promise.resolve(state.rawTransactions),
      getById: (id: string) => Promise.resolve(state.rawTransactions.find((t) => t.id === id)),
      append: (t: RawTransaction) => {
        const withSeq = { ...t, seq: state.rawTransactions.length + 1 };
        state.rawTransactions.push(withSeq);
        return Promise.resolve(withSeq);
      },
    },
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

// importSession.ts reads localStorage exactly once at import time — see the
// other ImportPage test files' identical note.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "b1",
        candidate: {
          ticker: "TMGH",
          side: "BUY",
          shares: 1000,
          price: 10,
          date: "2026-02-05",
          time: "10:00",
          confidence: "high",
          source: "invoice",
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

describe("Policy audit regression: an Invoice-only ticker must still block on a disagreeing broker screenshot", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Policy Test", kind: "Trading", initialCash: 1_000_000 })];
    // Entire committed history for TMGH is Invoice-sourced (never
    // official-broker-excel) and open (1000 shares remaining).
    state.trades = [
      createTrade({
        id: "t1",
        portfolioId: "p1",
        ticker: "TMGH",
        shares: 1000,
        entryPrice: 10,
        executionDate: "2026-02-05",
        executionTime: "10:00",
      }),
    ];
    state.rawTransactions = [
      {
        ...createRawTransaction({
          id: "rt1",
          portfolioId: "p1",
          kind: "BuyExecution",
          source: "invoice",
          ticker: "TMGH",
          payload: { ticker: "TMGH", shares: 1000, price: 10, executionDate: "2026-02-05" },
        }),
        seq: 1,
      },
    ];
    // A real broker "My Position" screenshot disagrees: it shows only 400
    // units, not the 1000 the Invoice-sourced ledger computes.
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "TMGH", units: 400, capturedAt: "2026-02-10T00:00", source: "screenshot" },
    ];
  });

  it("shows Mismatch, not 'Verified — official broker Excel', once the exact-duplicate pending Buy auto-skips and the ticker falls back to its Invoice-only committed history", async () => {
    render(<ImportPage />);

    // The re-imported Buy is an exact duplicate of the already-committed
    // trade and auto-skips, leaving TMGH with nothing pending — exactly the
    // zero-pending branch this regression is about.
    await screen.findByText("Mismatch");
    expect(screen.queryByText("Verified — official broker Excel")).toBeNull();
    expect(screen.queryByText(/Fully matched/)).toBeNull();
  });
});

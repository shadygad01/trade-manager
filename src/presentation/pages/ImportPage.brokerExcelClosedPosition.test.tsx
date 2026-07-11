// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Regression harness for a real user-reported bug: a ticker (ACAMD) whose
 * ENTIRE history came from the official broker Excel export, already fully
 * committed and closed (net remaining shares = 0) in an earlier session,
 * still showed "Closed — needs corroborating evidence" + an Orders
 * History/Broker Statement recovery-plan recommendation on re-import —
 * even though nothing about this ticker should ever need a "My Position"
 * screenshot again.
 *
 * Root cause: ImportPage's own allPendingFromOfficialBrokerExcel check only
 * looked at THIS BATCH's still-pending candidates — once a ticker's rows are
 * all committed (nothing left pending, exactly what happens here via the
 * auto-skipped exact-duplicate Buy below), the flag degenerates to false and
 * checkTickerMatch falls through to its pre-existing closed-position/
 * no-corroboration branch. Fixed by also checking the ticker's full
 * committed RawTransaction history (isTickerFullyOfficialBrokerExcelSourced),
 * the same helper reconciliation.ts already uses.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  rawTransactions: [] as RawTransaction[],
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
    verifications: { getAll: () => Promise.resolve([]), save: () => Promise.resolve(), delete: () => Promise.resolve() },
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

// See ImportPage.reconciliation.test.tsx's own doc comment — importSession.ts
// reads localStorage exactly once at import time, so the pending pool must
// be seeded before the dynamic import below, not inside beforeEach/it.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "b1",
        candidate: {
          ticker: "ACAMD",
          side: "BUY",
          shares: 3000,
          price: 0.38,
          date: "2022-11-02",
          time: "10:00",
          confidence: "high",
          source: "official-broker-excel",
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

describe("ACAMD regression: a fully-closed, fully-Excel-sourced ticker with nothing left pending", () => {
  let originalTrackingStart: string;
  beforeEach(() => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    state.portfolios = [createPortfolio({ id: "p1", name: "Old school", kind: "Trading", initialCash: 1_000_000 })];
    // Already committed and fully closed in an earlier session — remaining
    // shares 0, exactly the "Opening 0 + Buy 0 - Sell 0 = Calculated 0" shape
    // from the real bug report.
    state.trades = [
      { ...createTrade({ id: "t1", portfolioId: "p1", ticker: "ACAMD", shares: 3000, entryPrice: 0.38, executionDate: "2022-11-02", executionTime: "10:00" }), remainingShares: 0 },
    ];
    state.rawTransactions = [
      { ...createRawTransaction({ id: "rt1", portfolioId: "p1", kind: "BuyExecution", source: "official-broker-excel", ticker: "ACAMD", payload: { ticker: "ACAMD", shares: 3000, price: 0.38, executionDate: "2022-11-02" } }), seq: 1 },
      { ...createRawTransaction({ id: "rt2", portfolioId: "p1", kind: "SellExecution", source: "official-broker-excel", ticker: "ACAMD", payload: { ticker: "ACAMD", shares: 3000, price: 0.5, executionDate: "2022-11-10" } }), seq: 2 },
    ];
  });
  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("never shows 'Closed — needs corroborating evidence' or a recovery-plan recommendation — no screenshot was ever required for this ticker", async () => {
    render(<ImportPage />);

    // The re-extracted Buy is an exact duplicate of the already-committed
    // trade — auto-skipped, leaving nothing pending for ACAMD. With the
    // fix, that's still recognized as broker-excel-verified via the
    // ticker's full committed history, not just this batch's (now empty)
    // pending rows.
    await screen.findByText(/Fully matched \(1\)/);
    expect(screen.queryByText("Closed — needs corroborating evidence")).toBeNull();
    expect(screen.queryByText(/Closes this gap/)).toBeNull();
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
  });
});

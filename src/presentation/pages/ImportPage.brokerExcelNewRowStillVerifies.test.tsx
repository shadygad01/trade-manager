// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Boundary regression for the ACAMD fix (ImportPage.brokerExcelClosedPosition.test.tsx):
 * a ticker's Excel-sourced HISTORY must never bypass verification for a
 * genuinely NEW, still-pending candidate from a DIFFERENT source — the
 * historical fallback in ImportPage's allPendingFromOfficialBrokerExcel only
 * applies once nothing is left pending at all, never as a blanket override
 * while a fresh, unverified row is still sitting in the batch.
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
// reads localStorage exactly once at import time.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        // A genuinely NEW buy, from a screenshot — not a re-read of
        // anything already on the ledger, and NOT from the Excel export.
        key: "new-screenshot-buy",
        candidate: {
          ticker: "ACAMD",
          side: "BUY",
          shares: 500,
          price: 0.45,
          date: "2026-03-01",
          time: "11:00",
          confidence: "medium",
          source: "screenshot",
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

describe("A ticker's Excel-sourced HISTORY never bypasses verification for a new, different-source pending row", () => {
  let originalTrackingStart: string;
  beforeEach(() => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    state.portfolios = [createPortfolio({ id: "p1", name: "Old school", kind: "Trading", initialCash: 1_000_000 })];
    // Existing history for ACAMD is 100% Excel-sourced and fully closed —
    // exactly the ACAMD fix's own scenario — but this batch adds a BRAND
    // NEW screenshot-sourced buy on top, which must still need real
    // verification, not ride on the ticker's unrelated past.
    state.trades = [
      { ...createTrade({ id: "t1", portfolioId: "p1", ticker: "ACAMD", shares: 3000, entryPrice: 0.38, executionDate: "2022-11-02", executionTime: "10:00" }), remainingShares: 0 },
    ];
    state.rawTransactions = [
      { ...createRawTransaction({ id: "rt1", portfolioId: "p1", kind: "BuyExecution", source: "official-broker-excel", ticker: "ACAMD", payload: { ticker: "ACAMD", shares: 3000, price: 0.38, executionDate: "2022-11-02" } }), seq: 1 },
      { ...createRawTransaction({ id: "rt2", portfolioId: "p1", kind: "SellExecution", source: "official-broker-excel", ticker: "ACAMD", payload: { ticker: "ACAMD", shares: 3000, price: 0.5, executionDate: "2022-11-10" } }), seq: 2 },
    ];
  });
  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("still shows 'Needs broker screenshot' for the new pending row, unaffected by the ticker's unrelated Excel-sourced history", async () => {
    render(<ImportPage />);

    await screen.findByText("ACAMD");
    expect(await screen.findByText("Needs broker screenshot")).toBeInTheDocument();
    expect(screen.queryByText(/Fully matched/)).toBeNull();
  });
});

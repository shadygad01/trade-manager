// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createRawTransaction, type RawTransaction, type RetractionPayload } from "@domain/entities/RawTransaction";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Real user-reported bug (ABUK): a still-OPEN position whose 27 shares were
 * originally recorded manually (source "manual"), later confirmed by
 * uploading the broker's own official Excel export. The re-extracted Buy is
 * an exact duplicate of the already-committed trade — auto-skipped, same as
 * ACAMD (ImportPage.brokerExcelClosedPosition.test.tsx) — but unlike ACAMD,
 * the ticker's only OTHER live fact is the older, lower-authority "manual"
 * one. Retracting the newly-extracted official-broker-excel fact (the old,
 * pre-fix behavior) left "manual" as the ticker's only surviving evidence,
 * so it kept reading "Needs broker screenshot" forever, even though the
 * authoritative document had just been uploaded and matched exactly.
 *
 * Fix: the auto-skip effect now compares Evidence Authority (see
 * evidenceAuthority.ts) between the new candidate and whatever fact already
 * describes the same execution, and retracts the LOWER-authority one —
 * upgrading the ticker's provenance to the newly-uploaded document instead
 * of erasing it.
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
        // The broker's official Excel export re-reading the same real buy
        // already recorded manually — an exact duplicate by ticker/date/
        // shares/price.
        key: "b1",
        candidate: {
          ticker: "ABUK",
          side: "BUY",
          shares: 27,
          price: 12.5,
          date: "2025-01-05",
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

describe("ABUK regression: an exact-duplicate Excel upload must upgrade, not erase, a lower-authority existing fact", () => {
  let originalTrackingStart: string;
  beforeEach(() => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    state.portfolios = [createPortfolio({ id: "p1", name: "SMC", kind: "Trading", initialCash: 1_000_000 })];
    // Still open (27 remaining), originally recorded manually — no document
    // ever confirmed it until now.
    state.trades = [
      { ...createTrade({ id: "t1", portfolioId: "p1", ticker: "ABUK", shares: 27, entryPrice: 12.5, executionDate: "2025-01-05", executionTime: "10:00" }), remainingShares: 27 },
    ];
    state.rawTransactions = [
      { ...createRawTransaction({ id: "rt1", portfolioId: "p1", kind: "BuyExecution", source: "manual", ticker: "ABUK", payload: { ticker: "ABUK", shares: 27, price: 12.5, executionDate: "2025-01-05" } }), seq: 1 },
      // The pending candidate's own fact, as if recordImportedRawTransactions
      // already wrote it at extraction time (real production ordering) —
      // same real execution as rt1, described by the higher-authority document.
      { ...createRawTransaction({ id: "b1", portfolioId: undefined, kind: "BuyExecution", source: "official-broker-excel", ticker: "ABUK", payload: { ticker: "ABUK", shares: 27, price: 12.5, executionDate: "2025-01-05" } }), seq: 2 },
    ];
  });
  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("retracts the older manual fact (not the new Excel one) and settles to Fully matched, never 'Needs broker screenshot'", async () => {
    render(<ImportPage />);

    await screen.findByText(/Fully matched \(1\)/);
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
    expect(screen.queryByText(/Closes this gap/)).toBeNull();

    await waitFor(() => {
      const retractions = state.rawTransactions.filter((t) => t.kind === "Retraction");
      expect(retractions.some((t) => (t.payload as RetractionPayload).targetId === "rt1")).toBe(true);
    });
    const retractions = state.rawTransactions.filter((t) => t.kind === "Retraction");
    expect(retractions.some((t) => (t.payload as RetractionPayload).targetId === "b1")).toBe(false);
  });
});

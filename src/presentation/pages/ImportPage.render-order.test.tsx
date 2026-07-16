// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * Instrumentation for Hypothesis 1 of the architectural audit: does
 * checkTickerMatch's reconciliation ever run against pending shares that
 * still include an unskipped ledger-duplicate, i.e. does duplicate removal
 * happen strictly BEFORE shortage calculation on every rendered frame, or is
 * there a transient frame where shortage is computed first against stale
 * (not-yet-deduplicated) data? Captures the DOM synchronously immediately
 * after the initial render commit (before any effect-triggered re-render
 * has had a chance to run), then again after microtasks/effects flush.
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

localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "k1",
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

describe("Hypothesis 1 instrumentation: render-order relative to duplicate skip", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Render Order Test", kind: "Trading", initialCash: 1_000_000 })];
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
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-06-05T00:00", source: "screenshot" },
    ];
  });

  it("records what the very first synchronous commit shows, and what the settled state shows, and whether the Confirm action is ever reachable during any stale window", async () => {
    let firstCommitBody = "";
    act(() => {
      render(<ImportPage />);
      // Capture strictly what's on screen at the end of React's synchronous
      // render pass, before any awaited useLiveQuery/useEffect microtask has
      // had a chance to run.
      firstCommitBody = document.body.textContent ?? "";
    });

    const firstCommitShowsConfirmEnabled =
      firstCommitBody.includes("Confirm") && !document.querySelector("button[disabled]");

    // A restored session must not paint its review rows until the durable
    // ledger has loaded and the duplicate/reconciliation pass has settled.
    // This is the user-visible regression: navigating back to Import used to
    // flash an already-recorded BUY as pending for a moment.
    expect(firstCommitBody).not.toContain("BUY");
    expect(firstCommitBody).not.toContain("Mismatch");
    expect(firstCommitBody).not.toContain("Needs broker screenshot");

    // Poll every distinct badge state observed between the first commit and
    // settlement, to catch any transient "Mismatch"/"Needs broker
    // screenshot" frame that appears once real data has loaded but before
    // the duplicate-skip effect has updated skippedKeys.
    const observedBadgeStates = new Set<string>();
    // Whether, during any frame that showed a wrong/transient badge, a real
    // money-moving action (an enabled Confirm/Distribute button) was ever
    // simultaneously reachable — the actual safety question, independent of
    // whether the badge itself is momentarily cosmetically wrong.
    let sawEnabledConfirmDuringStaleFrame = false;
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      const stale = body.includes("Mismatch") || body.includes("Needs broker screenshot");
      if (body.includes("Mismatch")) observedBadgeStates.add("Mismatch");
      if (body.includes("Needs broker screenshot")) observedBadgeStates.add("Needs broker screenshot");
      if (body.includes("Fully matched")) observedBadgeStates.add("Fully matched");
      if (stale) {
        const confirmBtn = [...document.querySelectorAll("button")].find((b) => /confirm/i.test(b.textContent ?? ""));
        if (confirmBtn && !confirmBtn.hasAttribute("disabled")) sawEnabledConfirmDuringStaleFrame = true;
      }
      expect(body).toMatch(/Fully matched \(1\)/);
    });

    // The badge itself IS allowed to be transiently stale in this assertion
    // (that's the real, if cosmetic, finding) — what must NEVER happen is a
    // real commit action being reachable while it's stale.
    expect(sawEnabledConfirmDuringStaleFrame).toBe(false);

    // The critical safety question: even if a transient stale frame renders
    // Mismatch, was there ever a frame where the corresponding data write
    // would have been possible against that stale read? The Confirm-All
    // button only ever acts on tickers tickerMatchStatuses reports matched
    // at the moment of the click (a live read, not the stale snapshot), and
    // is additionally disabled while initialDataLoaded is false — so the
    // real question (checked below across every frame, not just this first
    // one) is whether a stale badge frame ever coexists with an ENABLED
    // path to commit money against it.
    expect(firstCommitShowsConfirmEnabled).toBe(false);
  });
});

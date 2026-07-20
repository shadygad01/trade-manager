// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Architectural-audit regression: ImportPage.tsx reads
 * portfolios/trades/allocations/verifications/timeline/rawTransactions each
 * via its OWN independent useLiveQuery — each resolves on its own schedule.
 * A fully-closed, fully-official-broker-excel-sourced ticker with nothing
 * left pending this session (the ACAMD/CLHO shape) depends ENTIRELY on
 * existingRawTransactions to be recognized as broker-excel-verified — if
 * every OTHER query resolved but that ONE hadn't yet, the ticker used to
 * transiently but visibly read as "closed-position, unmatched" — "Closed —
 * needs corroborating evidence" — purely because its default-empty [] read
 * could never satisfy isTickerFullyOfficialBrokerExcelSourced. See
 * docs/ROADMAP.md's "Architectural audit" entry for the original finding.
 *
 * The fix that shipped for this is `reviewDataSettled`
 * (ImportPage.tsx: `initialDataLoaded` requires
 * `existingRawTransactionsRaw !== undefined` among every other query, and the
 * entire ticker-groups section is gated on `reviewDataSettled &&
 * tickerGroups.length > 0`) — stricter than "show correct data immediately":
 * nothing renders AT ALL until every one of those queries, including
 * rawTransactions, has settled. This test still holds rawTransactions'
 * query open while every other query resolves immediately, to prove the
 * gate actually works: no ticker card of any kind — right or wrong — may
 * appear until it's released, and the ticker settles to "Fully matched"
 * immediately once it is.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  rawTransactions: [] as RawTransaction[],
}));

let resolveRawTransactions: (() => void) | undefined;

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
    allocations: { getAll: () => Promise.resolve([]), save: () => Promise.resolve() },
    verifications: { getAll: () => Promise.resolve([]), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    timeline: { getAll: () => Promise.resolve([]), save: () => Promise.resolve(), delete: () => Promise.resolve() },
    rawTransactions: {
      // Held open deliberately — every OTHER query above resolves
      // immediately, isolating exactly this one query's independent
      // resolution schedule, the real-world condition this bug depends on.
      getAll: () =>
        new Promise<RawTransaction[]>((resolve) => {
          resolveRawTransactions = () => resolve(state.rawTransactions);
        }),
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

// importSession.ts reads localStorage exactly once at import time — seed
// before the dynamic import, same as every sibling ImportPage test harness.
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
    // Already committed in an earlier session — nothing left pending for
    // ACAMD from the very first render, deterministically isolating the
    // historical-fallback code path (isTickerFullyOfficialBrokerExcelSourced)
    // instead of depending on the auto-skip-duplicate effect's own timing.
    addedKeys: ["b1"],
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

describe("ImportPage load-order race: a fully-closed, fully-Excel-sourced ticker while rawTransactions is still loading", () => {
  let originalTrackingStart: string;
  beforeEach(() => {
    resolveRawTransactions = undefined;
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    state.portfolios = [createPortfolio({ id: "p1", name: "Old school", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [
      { ...createTrade({ id: "t1", portfolioId: "p1", ticker: "ACAMD", shares: 3000, entryPrice: 0.38, executionDate: "2022-11-02", executionTime: "10:00" }), remainingShares: 0 },
    ];
    state.rawTransactions = [
      { ...createRawTransaction({ id: "rt1", portfolioId: "p1", kind: "BuyExecution", source: "official-broker-excel", ticker: "ACAMD", payload: { ticker: "ACAMD", shares: 3000, price: 0.38, executionDate: "2022-11-02" } }), seq: 1 },
      { ...createRawTransaction({ id: "rt2", portfolioId: "p1", kind: "SellExecution", source: "official-broker-excel", ticker: "ACAMD", payload: { ticker: "ACAMD", shares: 3000, price: 0.5, executionDate: "2022-11-10" } }), seq: 2 },
      // The lot allocation itself (ADR-002: allocation is always an explicit
      // fact, never inferred from net-share arithmetic alone) — without this,
      // rawTransactionFolds.findUnallocatedSellExecutions correctly reports
      // rt2 as still-unallocated, and the ticker can never reach "Fully
      // matched" regardless of how the load race below resolves. Buy+Sell
      // facts with no backing decision is an invalid, unrealistic fixture
      // shape per this app's own data model (see the sibling
      // ImportPage.brokerExcelClosedPosition.test.tsx fixture, fixed the
      // same way).
      {
        ...createRawTransaction({
          id: "rt3",
          portfolioId: "p1",
          kind: "SellAllocationDecision",
          source: "official-broker-excel",
          ticker: "ACAMD",
          payload: { sellExecutionId: "rt2", allocations: [{ lotRef: "rt1", shares: 3000 }] },
        }),
        seq: 3,
      },
    ];
  });
  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("shows no ticker card at all — right or wrong — until every query including rawTransactions settles, then settles directly to Fully matched", async () => {
    render(<ImportPage />);

    // dexie-react-hooks' useLiveQuery doesn't invoke its fetcher
    // synchronously within render() — it schedules the first run a tick (or
    // several) later, so `resolveRawTransactions` isn't assigned the instant
    // render() returns. Wait for the real fetcher to actually run and
    // capture it before ever trying to call it — calling it too early is a
    // silent no-op that leaves the held-open promise pending forever.
    await waitFor(() => expect(resolveRawTransactions).toBeDefined(), { timeout: 8000 });

    // The other five queries have already resolved (they're plain
    // Promise.resolve()s); rawTransactions has not — reviewDataSettled's own
    // `initialDataLoaded` check requires it too, so the entire ticker
    // section (gated on `reviewDataSettled && tickerGroups.length > 0`)
    // must stay hidden through this whole window. No stale/incorrect badge
    // to assert against — nothing renders at all, which is the actual
    // current fix for the load-order race this test exists to guard.
    expect(screen.queryByText("ACAMD")).toBeNull();
    expect(screen.queryByText("Closed — needs corroborating evidence")).toBeNull();
    expect(screen.queryByText(/Closes this gap/)).toBeNull();
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();

    resolveRawTransactions?.();

    // ImportPage's own initial render does substantial synchronous work
    // (many useMemo passes over a large component tree) — under a loaded/
    // resource-constrained runner this can take noticeably longer than RTL's
    // 1000ms default `waitFor` timeout, same reasoning as this file's
    // sibling race-condition tests (ImportPage.multiBuySameTickerRace/
    // inFlightDuplicateRace/brokerExcelProvenanceUpgrade.test.tsx), which
    // already use an explicit longer timeout for exactly this reason.
    await screen.findByText(/Fully matched \(1\)/, {}, { timeout: 8000 });
    expect(screen.queryByText("Closed — needs corroborating evidence")).toBeNull();
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
  }, 15000);
});

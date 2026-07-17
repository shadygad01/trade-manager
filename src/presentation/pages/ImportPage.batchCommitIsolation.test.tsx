// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createPortfolio } from "@domain/entities/Portfolio";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Real user-reported bug: after importing a large native Thndr "Your Orders"
 * Excel export (dozens of tickers, hundreds of Buy/Sell rows, all
 * `source: "official-broker-excel"`), MANY tickers the broker's own export
 * proves fully closed (net shares 0) still showed up in Holdings as open
 * positions with their full gross Buy history and zero Sells applied.
 *
 * Root cause, found by tracing ImportPage's own bulk-commit path rather than
 * guessing: `confirmAndDistributeAll` processes each portfolio's matched
 * tickers in one plain sequential `for` loop, and `commitTickerGroupLocked`'s
 * own official-broker-excel auto-FIFO-sell loop had no per-row `catch`
 * either. A single ticker whose Sell candidate can't find enough eligible
 * open lots — e.g. its corresponding Buy fell outside the tracking window,
 * or was an unreconstructable "invest by EGP amount" order (see
 * ThndrOrdersWorkbookParser's own skippedValueOrders warning) — threw an
 * uncaught error that unwound BOTH loops: every Sell queued after the
 * failing one for that SAME ticker was skipped, AND (far worse) every OTHER,
 * perfectly healthy ticker queued after it in the SAME portfolio's commit
 * loop never got its own commitTickerGroup call at all. A batch import with
 * one bad row anywhere could silently leave dozens of genuinely closed
 * tickers sitting as open positions.
 *
 * This test reproduces the exact shape with two tickers sharing one
 * portfolio, ordered so the broken one is processed first: BADX (Buy 100,
 * Sell 150 — the Sell can never fully allocate, no matter what) and GOOD1
 * (Buy 200, Sell 200 — a completely ordinary full round trip). Before the
 * fix, GOOD1 never got processed at all. After the fix, GOOD1 must close out
 * cleanly regardless of BADX's own unresolved problem.
 */

vi.mock("@presentation/lib/data", async () => {
  const { PortfolioOsDatabase: DB } = await import("@infrastructure/db/db");
  const { createRepositories: create } = await import("@infrastructure/db/repositories");
  const testDb = new DB(`import-batch-commit-isolation-test-${Math.random()}`);
  const base = create(testDb);
  return {
    diagnostics: { recordSessionEvent() {}, recordWrite() {}, recordRead() {}, recordDecision() {}, recordRuleExecution() {}, recordPerfSample() {} },
    repos: {
      ...base,
      allocations: base.tradeAllocations,
      prices: { getAllPrices: () => Promise.resolve({}), getSnapshotInfo: () => Promise.resolve(undefined) },
    },
    getImportOrchestrator: () => Promise.reject(new Error("not used in this test")),
    __testDb: testDb,
  };
});

localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "bad-buy",
        candidate: {
          ticker: "BADX",
          side: "BUY",
          shares: 100,
          price: 10,
          date: "2026-04-01",
          time: "09:00AM",
          confidence: "high",
          source: "official-broker-excel",
        },
      },
      {
        key: "bad-sell",
        candidate: {
          ticker: "BADX",
          side: "SELL",
          shares: 150,
          price: 12,
          date: "2026-04-10",
          time: "09:00AM",
          confidence: "high",
          source: "official-broker-excel",
        },
      },
      {
        key: "good-buy",
        candidate: {
          ticker: "GOOD1",
          side: "BUY",
          shares: 200,
          price: 5,
          date: "2026-04-01",
          time: "09:00AM",
          confidence: "high",
          source: "official-broker-excel",
        },
      },
      {
        key: "good-sell",
        candidate: {
          ticker: "GOOD1",
          side: "SELL",
          shares: 200,
          price: 6,
          date: "2026-04-15",
          time: "09:00AM",
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
    tickerPortfolio: { BADX: "p1", GOOD1: "p1" },
    uploadSeq: 1,
    filesProcessed: 1,
  }),
);

const { ImportPage } = await import("./ImportPage");
const dataModule = (await import("@presentation/lib/data")) as unknown as {
  repos: ReturnType<typeof createRepositories> & { allocations: unknown };
  __testDb: PortfolioOsDatabase;
};

describe("Bulk Confirm & Distribute: one unresolvable ticker must not block its siblings in the same portfolio", () => {
  let originalTrackingStart: string;

  beforeEach(async () => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    await dataModule.repos.portfolios.save(createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1_000_000 }));
  });

  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("still fully closes GOOD1 even though BADX's Sell can never find enough open shares", async () => {
    render(<ImportPage />);

    await screen.findByText("BADX");
    await screen.findByText("GOOD1");

    await waitFor(() => expect(screen.getByText("Confirm — Distribute to Portfolios").closest("button")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Confirm — Distribute to Portfolios"));

    // Wait for the whole batch (both tickers, processed sequentially within
    // their shared portfolio) to finish, not just BADX's own row error —
    // GOOD1 is queued after BADX, so asserting the moment BADX's error first
    // appears would race GOOD1's still-in-flight commit.
    await waitFor(
      async () => {
        const trades = await dataModule.repos.trades.getByPortfolio("p1");
        expect(trades.find((t) => t.ticker === "GOOD1")?.remainingShares).toBe(0);
      },
      { timeout: 8000 },
    );

    // BADX's unresolvable Sell surfaces as a row error instead of silently
    // swallowing the rest of the batch.
    expect(screen.getByText(/Official broker sell cannot be allocated/)).toBeInTheDocument();

    const trades = await dataModule.repos.trades.getByPortfolio("p1");
    const goodTrades = trades.filter((t) => t.ticker === "GOOD1");
    const badTrades = trades.filter((t) => t.ticker === "BADX");

    // The headline assertion: GOOD1's perfectly ordinary Buy+Sell round trip
    // must commit and fully close, unaffected by BADX's own unrelated
    // problem sitting earlier in the same portfolio's commit queue.
    expect(goodTrades).toHaveLength(1);
    expect(goodTrades[0].shares).toBe(200);
    expect(goodTrades[0].remainingShares).toBe(0);

    // BADX's Buy still committed (100 shares); its Sell never allocated, so
    // the lot stays open — exactly the honest state to show while unresolved,
    // never a silent, invisible loss of the whole ticker.
    expect(badTrades).toHaveLength(1);
    expect(badTrades[0].shares).toBe(100);
    expect(badTrades[0].remainingShares).toBe(100);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createPortfolio } from "@domain/entities/Portfolio";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Direct follow-up to ImportPage.batchCommitIsolation.test.tsx, prompted by a
 * real user report (in Arabic): the Dashboard's "Total Dividends" tile showed
 * E£0 even though dividends had been recorded via Import for a sub-portfolio.
 * The user confirmed these dividends were imported from the Excel screen (not
 * added manually via the per-portfolio "Add Dividend" button) — the same
 * commit path as the closed-positions bug above.
 *
 * `commitTickerGroupLocked` processes a ticker's pending Dividends in the
 * same call as its Buys/Sells, and `confirmAndDistributeAll` commits every
 * matched ticker for one portfolio in a single sequential loop. Before the
 * fix, a completely unrelated ticker's Sell-allocation failure earlier in
 * that SAME portfolio's queue silently prevented every ticker queued after
 * it — including a ticker whose only pending item was a Dividend — from ever
 * reaching `recordDividend` at all, even though Import's own review screen
 * had already marked that Dividend "confirmed" (extraction/verification is a
 * separate step from actually committing it). This is the same fix, proven
 * here specifically for the Dividend-only case.
 */

vi.mock("@presentation/lib/data", async () => {
  const { PortfolioOsDatabase: DB } = await import("@infrastructure/db/db");
  const { createRepositories: create } = await import("@infrastructure/db/repositories");
  const testDb = new DB(`import-batch-commit-isolation-dividend-test-${Math.random()}`);
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
          ticker: "BADY",
          side: "BUY",
          shares: 50,
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
          ticker: "BADY",
          side: "SELL",
          shares: 80,
          price: 12,
          date: "2026-04-10",
          time: "09:00AM",
          confidence: "high",
          source: "official-broker-excel",
        },
      },
    ],
    pendingVerifications: [],
    pendingDividends: [
      {
        key: "div-1",
        dividend: { ticker: "DIVX", date: "2026-05-01", amount: 250, source: "official-broker-excel" },
      },
    ],
    pendingOrderEvidences: [],
    discardedCandidates: [],
    addedKeys: [],
    acceptedKeys: [],
    skippedKeys: [],
    dismissedKeys: [],
    addedTradeIds: {},
    addedAllocationIds: {},
    tickerPortfolio: { BADY: "p1", DIVX: "p1" },
    uploadSeq: 1,
    filesProcessed: 1,
  }),
);

const { ImportPage } = await import("./ImportPage");
const dataModule = (await import("@presentation/lib/data")) as unknown as {
  repos: ReturnType<typeof createRepositories> & { allocations: unknown };
  __testDb: PortfolioOsDatabase;
};

describe("Bulk Confirm & Distribute: a Dividend-only ticker must still commit despite an unrelated sibling ticker's Sell failure", () => {
  let originalTrackingStart: string;

  beforeEach(async () => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    await dataModule.repos.portfolios.save(createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1_000_000 }));
  });

  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("still records DIVX's dividend even though BADY (queued first) can never allocate its Sell", async () => {
    render(<ImportPage />);

    await screen.findByText("BADY");
    await screen.findByText("DIVX");

    await waitFor(() => expect(screen.getByText("Confirm — Distribute to Portfolios").closest("button")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Confirm — Distribute to Portfolios"));

    await waitFor(
      async () => {
        const timeline = await dataModule.repos.timeline.getByPortfolio("p1");
        expect(timeline.some((e) => e.type === "Dividend")).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(screen.getByText(/Official broker sell cannot be allocated/)).toBeInTheDocument();

    const timeline = await dataModule.repos.timeline.getByPortfolio("p1");
    const dividendEvents = timeline.filter((e) => e.type === "Dividend");
    expect(dividendEvents).toHaveLength(1);
    expect(dividendEvents[0].amount).toBe(250);

    const portfolio = await dataModule.repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBe(1_000_000 - 50 * 10 + 250);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createRawTransaction } from "@domain/entities/RawTransaction";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * A second, independent real bug (ORWE shape) found while stress-testing the
 * ARCC/CLHO fix (ImportPage.inFlightDuplicateRace.test.tsx) against a ticker
 * with MORE THAN ONE still-pending Buy candidate in the same import batch —
 * a very common real shape (an investor buying the same stock more than
 * once). Confirming it produced a genuinely corrupted ledger: a DUPLICATE
 * Trade row for the second Buy (double-counting real shares) and its own
 * RawTransaction fact wrongly retracted, losing official-broker-excel
 * provenance the same way the ARCC/CLHO bug did.
 *
 * Root cause, found by instrumenting a real browser run against real
 * IndexedDB: `ensureBuyFact`/`ensureSellFacts` (TradeService.ts), once they
 * adopt or create a fact, called the TICKER-WIDE `assignPortfolio` —
 * "assign every still-unassigned live fact for this ticker" — instead of
 * assigning just the one fact they were handling. While `commitTickerGroup`
 * processes a ticker's Buys sequentially (one `recordBuy` at a time), the
 * FIRST Buy's own `assignPortfolio` call swept up the SECOND Buy's still-
 * unprocessed fact too (it looked exactly like a genuine assignment gap).
 * Assigning a fact reactively fires commitEngine's own `shouldCommit`/
 * `commitTicker` trigger — a SEPARATE commit pathway from this function's
 * own `recordBuy` calls — which materialized a legacy Trade for the second
 * Buy straight from the raw fact via `projectLegacyTicker`, BEFORE the
 * second Buy's own `recordBuy` call ever ran. That phantom Trade then raced
 * the second Buy's genuine `recordBuy` moments later: two Trade rows for one
 * real execution, and the genuine candidate's own fact got auto-skipped as
 * an apparent "exact duplicate" of the phantom one it never should have
 * competed with in the first place.
 *
 * Fixed by adding `assignPortfolioToFact` (commitEngine.ts) — a single-
 * target counterpart to the ticker-wide `assignPortfolio` — and switching
 * `ensureBuyFact`/`ensureSellFacts` to it, so adopting/creating one fact
 * never touches any of its still-pending siblings.
 */

vi.mock("@presentation/lib/data", async () => {
  const { PortfolioOsDatabase: DB } = await import("@infrastructure/db/db");
  const { createRepositories: create } = await import("@infrastructure/db/repositories");
  const testDb = new DB(`import-multibuy-race-test-${Math.random()}`);
  const base = create(testDb);
  return {
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
        key: "0-c0",
        candidate: {
          ticker: "ORWE",
          side: "BUY",
          shares: 1000,
          price: 8.1,
          date: "2026-04-01",
          time: "09:00AM",
          confidence: "high",
          source: "official-broker-excel",
        },
      },
      {
        key: "0-c1",
        candidate: {
          ticker: "ORWE",
          side: "BUY",
          shares: 500,
          price: 8.4,
          date: "2026-04-20",
          time: "09:30AM",
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
    tickerPortfolio: { ORWE: "p1" },
    uploadSeq: 1,
    filesProcessed: 1,
  }),
);

const { ImportPage } = await import("./ImportPage");
const dataModule = (await import("@presentation/lib/data")) as unknown as { repos: ReturnType<typeof createRepositories> & { allocations: unknown }; __testDb: PortfolioOsDatabase };

describe("ORWE regression: two Excel-sourced Buys for the same ticker in one batch must not race each other's commit", () => {
  let originalTrackingStart: string;

  beforeEach(async () => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    await dataModule.repos.portfolios.save(createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1_000_000 }));
    await dataModule.repos.rawTransactions.append(
      createRawTransaction({
        id: "0-c0",
        kind: "BuyExecution",
        source: "official-broker-excel",
        ticker: "ORWE",
        confidence: "high",
        payload: { ticker: "ORWE", shares: 1000, price: 8.1, executionDate: "2026-04-01", executionTime: "09:00AM" },
      }),
    );
    await dataModule.repos.rawTransactions.append(
      createRawTransaction({
        id: "0-c1",
        kind: "BuyExecution",
        source: "official-broker-excel",
        ticker: "ORWE",
        confidence: "high",
        payload: { ticker: "ORWE", shares: 500, price: 8.4, executionDate: "2026-04-20", executionTime: "09:30AM" },
      }),
    );
  });

  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("commits both Buys to exactly one Trade each (1500 total shares), never a duplicate, and stays Excel-sourced", async () => {
    render(<ImportPage />);

    await screen.findByText("ORWE");
    expect(screen.getByText("Verified — official broker Excel")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Confirm — Distribute to Portfolios").closest("button")).not.toBeDisabled());

    fireEvent.click(screen.getByText("Confirm ORWE"));

    await waitFor(() => expect(screen.getByText(/Fully matched/)).toBeInTheDocument(), { timeout: 8000 });
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
    expect(screen.queryByText(/Closes this gap/)).toBeNull();

    const facts = await dataModule.repos.rawTransactions.getAll();
    const buyFacts = facts.filter((f) => f.kind === "BuyExecution");
    expect(buyFacts).toHaveLength(2);
    expect(buyFacts.every((f) => f.source === "official-broker-excel")).toBe(true);

    const trades = await dataModule.repos.trades.getByPortfolio("p1");
    const orweTrades = trades.filter((t) => t.ticker === "ORWE");
    // Exactly one Trade per Buy — no phantom/duplicate row from the
    // commitEngine-vs-recordBuy race, and no double-counted shares.
    expect(orweTrades).toHaveLength(2);
    expect(orweTrades.reduce((sum, t) => sum + t.shares, 0)).toBe(1500);
  });
});

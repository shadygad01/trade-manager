// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createRawTransaction } from "@domain/entities/RawTransaction";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

/**
 * Real, reproduced user-reported bug (ARCC/CLHO shape): confirming a
 * still-open, entirely official-broker-excel-sourced ticker's ONLY pending
 * Buy flips it straight to "Needs broker screenshot" the instant the commit
 * finishes — even though nothing about it should ever need one.
 *
 * Root cause, found by instrumenting a real browser run against real
 * IndexedDB: ImportPage's own "auto-skip an exact ledger duplicate" effect
 * (the one keyed off `existingTrades`/`existingAllocations`) races the
 * in-flight commit it is itself watching. `commitTickerGroup`'s
 * `addBuyCandidate` → `recordBuy` saves the Trade several `await`s before it
 * ever ensures the candidate's own RawTransaction fact and before the caller
 * updates `addedKeys`. Dexie's real `useLiveQuery` picks up that
 * intermediate Trade write immediately (this is genuine IndexedDB
 * reactivity — a hand-mocked, non-Dexie `repos` object can't reproduce it,
 * which is why this test wires up REAL Dexie repositories backed by
 * fake-indexeddb instead of the usual plain-object mock). In that window the
 * candidate looks like "not yet added, and now duplicates an existing
 * trade" — the trade its own commit just wrote — so the auto-skip effect
 * marks it skipped and retracts its RawTransaction fact. `ensureBuyFact`
 * then finds no live fact left to adopt and mints a brand new one hardcoded
 * to source "manual", permanently destroying the ticker's
 * official-broker-excel provenance.
 *
 * Fixed by excluding `inFlightKeys` (commitTickerGroup's own reentrancy
 * guard) from the auto-skip effect's candidate pool.
 */

vi.mock("@presentation/lib/data", async () => {
  const { PortfolioOsDatabase: DB } = await import("@infrastructure/db/db");
  const { createRepositories: create } = await import("@infrastructure/db/repositories");
  const testDb = new DB(`import-race-test-${Math.random()}`);
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
          ticker: "ARCC",
          side: "BUY",
          shares: 42,
          price: 37,
          date: "2026-07-08",
          time: "10:58AM",
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
    tickerPortfolio: { ARCC: "p1" },
    uploadSeq: 1,
    filesProcessed: 1,
  }),
);

const { ImportPage } = await import("./ImportPage");
const dataModule = (await import("@presentation/lib/data")) as unknown as { repos: ReturnType<typeof createRepositories> & { allocations: unknown }; __testDb: PortfolioOsDatabase };

describe("ARCC/CLHO regression: confirming an Excel-sourced Buy must not race its own auto-skip-duplicate effect", () => {
  let originalTrackingStart: string;

  beforeEach(async () => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    await dataModule.repos.portfolios.save(createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1_000_000 }));
    // The extraction-time write recordImportedRawTransactions makes for
    // every candidate BEFORE the user ever confirms anything — seeded
    // directly (via append, not the presentation-layer call) since this
    // test starts mid-session (Step 1 already ran in an earlier render this
    // test doesn't replay). Same id as the pending candidate's own session
    // key ("0-c0"), exactly like the real write does.
    await dataModule.repos.rawTransactions.append(
      createRawTransaction({
        id: "0-c0",
        kind: "BuyExecution",
        source: "official-broker-excel",
        ticker: "ARCC",
        confidence: "high",
        payload: { ticker: "ARCC", shares: 42, price: 37, executionDate: "2026-07-08", executionTime: "10:58AM" },
      }),
    );
  });

  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("stays 'Verified — official broker Excel' / reaches 'Fully matched' after Confirm, never 'Needs broker screenshot'", async () => {
    render(<ImportPage />);

    await screen.findByText("ARCC");
    expect(screen.getByText("Verified — official broker Excel")).toBeInTheDocument();

    // Every useLiveQuery this page depends on (portfolios/trades/allocations/
    // verifications/timeline/rawTransactions) must resolve at least once
    // before Confirm actually does anything — confirmTicker no-ops while
    // initialDataLoaded is false, but that only gates the GLOBAL "Confirm —
    // Distribute to Portfolios" button's disabled state, not the per-ticker
    // one. Real Dexie queries genuinely take a tick longer than the
    // candidate list itself (plain local state), so wait for the global
    // button to enable as a reliable proxy before clicking the per-ticker one.
    await waitFor(() => expect(screen.getByText("Confirm — Distribute to Portfolios").closest("button")).not.toBeDisabled());

    fireEvent.click(screen.getByText("Confirm ARCC"));

    await waitFor(() => expect(screen.getByText(/Fully matched/)).toBeInTheDocument(), { timeout: 8000 });
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
    expect(screen.queryByText(/Closes this gap/)).toBeNull();

    // Confirm the underlying fact log stayed 100% Excel-sourced too — the
    // actual mechanism the bug corrupted (see reconciliation.ts's
    // isTickerFullyOfficialBrokerExcelSourced).
    const facts = await dataModule.repos.rawTransactions.getAll();
    const arccBuyFacts = facts.filter((f) => f.kind === "BuyExecution");
    expect(arccBuyFacts).toHaveLength(1);
    expect(arccBuyFacts[0].source).toBe("official-broker-excel");
  });
});

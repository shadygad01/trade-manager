// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createRawTransaction, type RetractionPayload } from "@domain/entities/RawTransaction";
import { recordBuy } from "@application/services/TradeService";
import type { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
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
 *
 * Uses REAL Dexie repositories backed by fake-indexeddb, not the usual
 * hand-mocked plain-object `repos` — this ticker's card only settles to
 * "Fully matched" once `existingRawTransactions` (a `useLiveQuery`) actually
 * RE-READS the post-retraction fact log. Dexie's `liveQuery` only re-emits
 * when a write touches a table it detected being read during the querier's
 * own execution; a hand-mocked, non-Dexie `getAll()` is never detected as
 * touching anything, so it would stay frozen at its pre-retraction snapshot
 * forever, making the very thing this test needs to verify unobservable
 * (see ImportPage.inFlightDuplicateRace.test.tsx's own doc comment for the
 * same reasoning, applied there to a different race).
 */

vi.mock("@presentation/lib/data", async () => {
  const { PortfolioOsDatabase: DB } = await import("@infrastructure/db/db");
  const { createRepositories: create } = await import("@infrastructure/db/repositories");
  const testDb = new DB(`abuk-provenance-test-${Math.random()}`);
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

// The broker's official Excel export re-reading the same real buy already
// recorded manually — an exact duplicate by ticker/date/shares/price.
localStorage.setItem(
  "portfolio-os:import-session",
  JSON.stringify({
    pendingCandidates: [
      {
        key: "0-c0",
        candidate: {
          ticker: "ABUK",
          side: "BUY",
          shares: 27,
          price: 12.5,
          date: "2025-01-05",
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
const dataModule = (await import("@presentation/lib/data")) as unknown as {
  repos: ReturnType<typeof createRepositories> & { allocations: ReturnType<typeof createRepositories>["tradeAllocations"] };
  __testDb: PortfolioOsDatabase;
};

describe("ABUK regression: an exact-duplicate Excel upload must upgrade, not erase, a lower-authority existing fact", () => {
  let originalTrackingStart: string;

  beforeEach(async () => {
    originalTrackingStart = getTrackingStartDate();
    setTrackingStartDate("2020-01-01");
    await dataModule.repos.portfolios.save(createPortfolio({ id: "p1", name: "SMC", kind: "Trading", initialCash: 1_000_000 }));
    // Still open (27 remaining), originally recorded via the real manual
    // Record Buy flow — no document ever confirmed it until now. This is
    // the actual production code path (TradeService.recordBuy ->
    // ensureBuyFact), not a hand-crafted fact, so its shape (id, source)
    // matches exactly what a real user's manual entry produces.
    await recordBuy(dataModule.repos, {
      portfolioId: "p1",
      ticker: "ABUK",
      shares: 27,
      entryPrice: 12.5,
      executionDate: "2025-01-05",
      executionTime: "00:00",
    });
    // The pending candidate's own fact, as if recordImportedRawTransactions
    // already wrote it at extraction time (real production ordering) — same
    // real execution as the manual trade above, described by the
    // higher-authority document.
    await dataModule.repos.rawTransactions.append(
      createRawTransaction({
        id: "0-c0",
        kind: "BuyExecution",
        source: "official-broker-excel",
        ticker: "ABUK",
        confidence: "high",
        payload: { ticker: "ABUK", shares: 27, price: 12.5, executionDate: "2025-01-05" },
      }),
    );
  });
  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("retracts the older manual fact (not the new Excel one) and settles to Fully matched, never 'Needs broker screenshot'", async () => {
    render(<ImportPage />);

    await screen.findByText(/Fully matched \(1\)/, {}, { timeout: 8000 });
    expect(screen.queryByText("Needs broker screenshot")).toBeNull();
    expect(screen.queryByText(/Closes this gap/)).toBeNull();

    // Confirm the underlying fact log actually upgraded, not just the badge:
    // exactly one live BuyExecution fact for ABUK, and it's the Excel one.
    const facts = await dataModule.repos.rawTransactions.getAll();
    const isRetracted = (id: string) => facts.some((f) => f.kind === "Retraction" && (f.payload as RetractionPayload).targetId === id);
    const liveBuyFacts = facts.filter((f) => f.kind === "BuyExecution" && !isRetracted(f.id));
    expect(liveBuyFacts).toHaveLength(1);
    expect(liveBuyFacts[0].source).toBe("official-broker-excel");
    expect(liveBuyFacts[0].id).toBe("0-c0");

    const manualFact = facts.find((f) => f.kind === "BuyExecution" && f.source === "manual");
    expect(manualFact).toBeDefined();
    expect(isRetracted(manualFact!.id)).toBe(true);

    // The real ledger row must survive the upgrade — a genuine, reproduced
    // regression: retracting the old fact re-triggers a commit for this
    // (portfolio, ticker), and if the surviving fact never inherited the old
    // one's portfolio assignment, that commit sees zero relevant
    // transactions and projectLegacyTicker (ledgerProjection.ts) deletes the
    // Trade as "stale" — the provenance badge fixes itself while the actual
    // Holdings row silently vanishes.
    const trades = await dataModule.repos.trades.getByPortfolio("p1");
    const abukTrades = trades.filter((t) => t.ticker === "ABUK");
    expect(abukTrades).toHaveLength(1);
    expect(abukTrades[0].remainingShares).toBe(27);
  });
});

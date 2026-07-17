import { describe, expect, it } from "vitest";
import { computeCanonicalPositions } from "./canonicalHoldings";
import { recordBuy, moveTrade } from "./TradeService";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import {
  createFakeRepositories,
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
} from "@application/testUtils/fakeRepositories";

/**
 * The concrete proof this module exists to satisfy: does the production
 * read cutover ever cause a real, currently-held position to silently
 * disappear from Holdings? Reproduces the exact mechanism a naive cutover
 * (read ledgerCache/computeHoldings unconditionally, drop Trade entirely)
 * would break — a ticker whose RawTransaction facts exist and are recorded
 * as real Trade rows, but whose verification hasn't reached a terminal
 * verdict (e.g. the closed-position corroboration fix from this session's
 * first sprint, or simply a fresh import not yet committed through the
 * shadow path at all).
 */
describe("canonicalHoldings.computeCanonicalPositions — the production cutover's own safety net", () => {
  it("a ticker with a real recorded Trade but NO committed ledgerCache entry (Needs Review, or never assigned to the shadow path) still shows its real shares — legacy-fallback, never silently dropped", async () => {
    const portfolio = createPortfolio({ id: "p1", name: "Main", kind: "Investment", initialCash: 100_000 });
    const base = createFakeRepositories({ portfolios: [portfolio] });
    const repos = { ...base, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() };

    // Real committed Trade (the legacy write path — unconditional, as
    // TradeService.recordBuy always is), but nothing ever reached the
    // ledgerCache for SKPC: no assignPortfolio/commitTicker call happened.
    await recordBuy(repos, { portfolioId: "p1", ticker: "SKPC", shares: 82, entryPrice: 14.7, executionDate: "2026-01-20", executionTime: "12:00" });

    const positions = await computeCanonicalPositions(repos, "p1", {});

    expect(positions).toHaveLength(1);
    expect(positions[0].ticker).toBe("SKPC");
    expect(positions[0].totalShares).toBe(82);
    expect(positions[0].source).toBe("legacy-fallback");
    expect(positions[0].fallbackReason).toContain("terminal verification verdict");
  });

  it("a ticker whose canonical ledger agrees exactly with the recorded trades is served as 'canonical'", async () => {
    const portfolio = createPortfolio({ id: "p1", name: "Main", kind: "Investment", initialCash: 100_000 });
    const base = createFakeRepositories({ portfolios: [portfolio] });
    const rawTransactions = createFakeRawTransactionRepository();
    const committedLedger = createFakeCommittedLedgerRepository();
    const repos = { ...base, rawTransactions, committedLedger };

    const { trade } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-02-01", executionTime: "10:00" });
    // Independently corroborate it (invoice-sourced) so it reaches a terminal
    // verdict and the shadow path actually commits it to the ledgerCache.
    const { assignPortfolio, commitTicker } = await import("./commitEngine");
    const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", executionTime: "10:00" };
    await rawTransactions.append(createRawTransaction({ id: trade.id, kind: "BuyExecution", source: "invoice", portfolioId: "p1", ticker: "COMI", payload }));
    await assignPortfolio(repos, "COMI", "p1");
    await commitTicker(repos, "p1", "COMI");

    const positions = await computeCanonicalPositions(repos, "p1", {});

    const comi = positions.find((p) => p.ticker === "COMI")!;
    expect(comi.source).toBe("canonical");
    expect(comi.totalShares).toBe(100);
  });

  it("a ticker where the canonical ledger DISAGREES with the recorded trades falls back to the recorded trades, with an explanatory reason naming both numbers", async () => {
    // Isolates the reconciliation logic itself: a real Trade (50 shares) and
    // a directly-injected, already-committed ledgerCache entry that
    // disagrees with it (80 shares) — the shape a genuine divergence between
    // the two systems would take, regardless of how it got there.
    const portfolio = createPortfolio({ id: "p1", name: "Main", kind: "Investment", initialCash: 100_000 });
    const base = createFakeRepositories({ portfolios: [portfolio] });
    const rawTransactions = createFakeRawTransactionRepository();
    const committedLedger = createFakeCommittedLedgerRepository();
    const repos = { ...base, rawTransactions, committedLedger };

    await recordBuy(repos, { portfolioId: "p1", ticker: "HRHO", shares: 50, entryPrice: 20, executionDate: "2026-03-01", executionTime: "09:00" });
    await committedLedger.commitTicker({
      portfolioId: "p1",
      ticker: "HRHO",
      events: [{ type: "LotOpened", eventId: "HRHO|BUY|2026-03-01|80|20", executionDate: "2026-03-01", ticker: "HRHO", shares: 80, price: 20, sourceTransactionIds: ["x"] }],
      allocations: [],
    });

    const positions = await computeCanonicalPositions(repos, "p1", {});

    const hrho = positions.find((p) => p.ticker === "HRHO")!;
    expect(hrho.source).toBe("legacy-fallback");
    expect(hrho.totalShares).toBe(50); // the recorded trade's own number, never silently replaced
    expect(hrho.fallbackReason).toContain("disagrees");
  });

  it("a ticker the canonical ledger has confidently closed (real committed Buy + a fully-covering Sell allocation) never shows as open, even when a stale legacy Trade row still has shares", async () => {
    // Real user-reported bug: closed positions kept showing as open Holdings
    // despite the sell having been fully allocated. Root cause — a canonical
    // ledger that correctly computed zero open shares was indistinguishable,
    // in computeCanonicalPositions, from a ticker that simply never reached
    // the canonical ledger at all; both cases fell back to whatever the
    // legacy Trade row said, silently trusting a stale remainingShares that
    // a legacy-projection bug never reduced (see the reconcileDuplicateAuthority/
    // reconciliationSweep sprints for the class of bug that leaves this kind
    // of staleness behind).
    const portfolio = createPortfolio({ id: "p1", name: "Main", kind: "Investment", initialCash: 100_000 });
    const base = createFakeRepositories({ portfolios: [portfolio] });
    const rawTransactions = createFakeRawTransactionRepository();
    const committedLedger = createFakeCommittedLedgerRepository();
    const repos = { ...base, rawTransactions, committedLedger };

    // Legacy Trade row is stale: still shows all 50 shares open, as if the
    // sell's allocation never reduced remainingShares.
    await recordBuy(repos, { portfolioId: "p1", ticker: "SKPC", shares: 50, entryPrice: 14.7, executionDate: "2026-01-20", executionTime: "12:00" });

    // The canonical ledger, however, has real committed facts proving the
    // position is fully closed: the lot opened, and a real allocation
    // closing every one of its shares.
    const eventId = "SKPC|BUY|2026-01-20|50|14.7";
    await committedLedger.commitTicker({
      portfolioId: "p1",
      ticker: "SKPC",
      events: [{ type: "LotOpened", eventId, executionDate: "2026-01-20", ticker: "SKPC", shares: 50, price: 14.7, sourceTransactionIds: ["x"] }],
      allocations: [
        { id: "a1", lotEventId: eventId, sellEventId: "y", shares: 50, price: 16, fees: 0, taxes: 0, executionDate: "2026-02-01" },
      ],
    });

    const positions = await computeCanonicalPositions(repos, "p1", {});

    expect(positions.find((p) => p.ticker === "SKPC")).toBeUndefined();
  });

  it("moving a Trade to a different portfolio must not leave a phantom canonical position behind in the source portfolio", async () => {
    // Real user-reported bug (the ADPC shape): moveTrade/consolidateTicker
    // reassign a Trade's portfolioId but never touch the matching
    // RawTransaction fact or committedLedger cache entry left behind in the
    // SOURCE portfolio. Before this fix, computeCanonicalPositions's
    // "!legacyPos && canonical" branch trusted that orphaned canonical entry
    // unconditionally, showing the ticker's full original cost basis as an
    // open position in a portfolio it no longer belongs to — with zero open
    // lots to back it up (Lots: 0 in the Holdings table).
    const p1 = createPortfolio({ id: "p1", name: "Source", kind: "Investment", initialCash: 100_000 });
    const p2 = createPortfolio({ id: "p2", name: "Target", kind: "Investment", initialCash: 100_000 });
    const base = createFakeRepositories({ portfolios: [p1, p2] });
    const rawTransactions = createFakeRawTransactionRepository();
    const committedLedger = createFakeCommittedLedgerRepository();
    const repos = { ...base, rawTransactions, committedLedger };

    const { trade } = await recordBuy(repos, { portfolioId: "p1", ticker: "ADPC", shares: 500, entryPrice: 1.8, executionDate: "2026-01-20", executionTime: "12:00" });
    const eventId = "ADPC|BUY|2026-01-20|500|1.8";
    await committedLedger.commitTicker({
      portfolioId: "p1",
      ticker: "ADPC",
      events: [{ type: "LotOpened", eventId, executionDate: "2026-01-20", ticker: "ADPC", shares: 500, price: 1.8, sourceTransactionIds: [trade.id] }],
      allocations: [],
    });

    await moveTrade(repos, trade.id, "p2");

    const sourcePositions = await computeCanonicalPositions(repos, "p1", {});
    expect(sourcePositions.find((p) => p.ticker === "ADPC")).toBeUndefined();
  });
});

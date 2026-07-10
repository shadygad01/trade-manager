import { describe, expect, it } from "vitest";
import { computeCanonicalPositions } from "./canonicalHoldings";
import { recordBuy } from "./TradeService";
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
});

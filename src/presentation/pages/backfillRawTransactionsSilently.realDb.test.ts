import { describe, it, expect } from "vitest";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { backfillRawTransactionsSilently } from "@application/services/backfillRawTransactions";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";

/**
 * The rest of backfillRawTransactions.test.ts validates
 * `backfillRawTransactionsSilently` against in-memory fakes — this file
 * closes the one remaining gap in the BF-1 Validation Design
 * (docs/PORTFOLIO_OS_V2_SPEC.md Part 19): proof against a REAL Dexie
 * instance, the same infrastructure `src/presentation/lib/data.ts`'s
 * startup hook actually calls. Fakes and the real IndexedDB adapter could
 * in principle diverge on subtle points (transaction semantics, `seq`
 * assignment, `bulkAdd` vs sequential `add`); this test rules that out for
 * the one property BF-1's entire safety case rests on: that running the
 * silent backfill leaves `trades`, `tradeAllocations`, `ledgerCache`, and
 * `allocationsCache` completely untouched, against the app's own real
 * repository wiring, not a stand-in.
 *
 * Lives in `src/presentation/pages/` (alongside `excelWorkflowEndToEnd.test.ts`,
 * the codebase's other real-Dexie integration test) rather than
 * `src/application/services/`, because it imports `@infrastructure/db`
 * directly — application-layer files are structurally forbidden from doing
 * that (see `.dependency-cruiser.cjs`'s `application-no-infrastructure-or-presentation`
 * rule), the same layering this test itself is proving BF-1 respects.
 */
describe("backfillRawTransactionsSilently against a real Dexie database", () => {
  it("appends facts to rawTransactions and touches nothing else — verified against real infrastructure, not fakes", async () => {
    const db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    const baseRepos = createRepositories(db);
    const repos = { ...baseRepos, allocations: baseRepos.tradeAllocations };

    await repos.portfolios.save(createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 10_000 }));
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 40,
      executionDate: "2026-01-15",
      executionTime: "10:00",
      notes: "conviction buy",
      strategyTags: ["swing"],
    });
    await repos.trades.save(trade);
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 100,
      exitPrice: 50,
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });
    await repos.allocations.save(allocation);

    const beforeTrades = await repos.trades.getAll();
    const beforeAllocations = await repos.allocations.getAll();

    const result = await backfillRawTransactionsSilently(repos);
    expect(result).toEqual({ buysBackfilled: 1, sellOrdersBackfilled: 1, verificationsBackfilled: 0, cashEventsBackfilled: 0 });

    // The actual safety claim: real Dexie, real repos, zero rows touched
    // outside rawTransactions.
    expect(await repos.trades.getAll()).toEqual(beforeTrades);
    expect(await repos.allocations.getAll()).toEqual(beforeAllocations);
    expect(await repos.committedLedger.getLedgerEvents("p1", "COMI")).toEqual([]);
    expect(await repos.committedLedger.getAllocations("p1", "COMI")).toEqual([]);

    const facts = await repos.rawTransactions.getAll();
    expect(facts.map((f) => f.kind).sort()).toEqual(["BuyExecution", "SellAllocationDecision", "SellExecution"]);
    expect(facts.every((f) => f.source === "backfill")).toBe(true);

    await db.delete();
  });

  it("running it twice against the same real database throws BackfillAlreadyRanError the second time, not a duplicate fact set", async () => {
    const db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    const baseRepos = createRepositories(db);
    const repos = { ...baseRepos, allocations: baseRepos.tradeAllocations };
    await repos.portfolios.save(createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 10_000 }));
    await repos.trades.save(
      createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" })
    );

    await backfillRawTransactionsSilently(repos);
    const factsAfterFirstRun = await repos.rawTransactions.getAll();

    await expect(backfillRawTransactionsSilently(repos)).rejects.toThrow(/already run/);
    expect(await repos.rawTransactions.getAll()).toEqual(factsAfterFirstRun);

    await db.delete();
  });
});

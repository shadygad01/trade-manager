import { beforeEach, describe, expect, it } from "vitest";
import { backfillRawTransactions, backfillRawTransactionsSilently, BackfillAlreadyRanError, type BackfillRepos } from "./backfillRawTransactions";
import {
  createFakeTradeRepository,
  createFakeTradeAllocationRepository,
  createFakeVerificationRepository,
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
  createFakePortfolioRepository,
  createFakeTimelineRepository,
} from "@application/testUtils/fakeRepositories";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, type TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { createPortfolio } from "@domain/entities/Portfolio";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import { isTickerFullyOfficialBrokerExcelSourced } from "./reconciliation";

const PORTFOLIO = "p1";

describe("backfillRawTransactions", () => {
  let trades: Trade[];
  let allocations: TradeAllocation[];
  let verifications: PositionVerification[];
  let timelineEvents: TimelineEvent[];
  let repos: BackfillRepos;

  function buildRepos() {
    return {
      portfolios: createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO, name: "Main", kind: "Trading" })]),
      trades: createFakeTradeRepository(trades),
      allocations: createFakeTradeAllocationRepository(allocations),
      verifications: createFakeVerificationRepository(verifications),
      timeline: createFakeTimelineRepository(timelineEvents),
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    };
  }

  beforeEach(() => {
    trades = [];
    allocations = [];
    verifications = [];
    timelineEvents = [];
  });

  it("backfills a single Trade into a BuyExecution raw transaction with source backfill, preserving its portfolioId", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }),
    ];
    repos = buildRepos();

    const result = await backfillRawTransactions(repos);
    expect(result).toEqual({ buysBackfilled: 1, sellOrdersBackfilled: 0, verificationsBackfilled: 0, cashEventsBackfilled: 0 });

    const all = await repos.rawTransactions.getAll();
    const buy = all.find((t) => t.kind === "BuyExecution")!;
    expect(buy.source).toBe("backfill");
    expect(buy.portfolioId).toBe(PORTFOLIO);
    expect(buy.ticker).toBe("COMI");
    expect(buy.payload).toMatchObject({ shares: 100, price: 40, executionDate: "2026-01-15" });
  });

  it("backfilling a fully-closed position reaches the same holdings the old system would report: it commits into ledgerCache/allocationsCache automatically", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }),
    ];
    allocations = [
      createTradeAllocation({
        id: "a1",
        sellGroupId: "sg1",
        portfolioId: PORTFOLIO,
        tradeId: "t1",
        ticker: "COMI",
        sharesClosed: 100,
        exitPrice: 50,
        executionDate: "2026-02-01",
        executionTime: "11:00",
      }),
    ];
    repos = buildRepos();

    await backfillRawTransactions(repos);

    const events = await repos.committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);

    const cachedAllocations = await repos.committedLedger.getAllocations(PORTFOLIO, "COMI");
    expect(cachedAllocations).toHaveLength(1);
    expect(cachedAllocations[0].shares).toBe(100);
  });

  it("a sell split across two lots (one sellGroupId, two TradeAllocation rows) backfills into one SellExecution and one SellAllocationDecision with two lines", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 30, entryPrice: 40, executionDate: "2026-01-10", executionTime: "10:00" }),
      createTrade({ id: "t2", portfolioId: PORTFOLIO, ticker: "COMI", shares: 70, entryPrice: 41, executionDate: "2026-01-12", executionTime: "10:00" }),
    ];
    allocations = [
      createTradeAllocation({ id: "a1", sellGroupId: "sg1", portfolioId: PORTFOLIO, tradeId: "t1", ticker: "COMI", sharesClosed: 30, exitPrice: 50, executionDate: "2026-02-01", executionTime: "11:00" }),
      createTradeAllocation({ id: "a2", sellGroupId: "sg1", portfolioId: PORTFOLIO, tradeId: "t2", ticker: "COMI", sharesClosed: 70, exitPrice: 50, executionDate: "2026-02-01", executionTime: "11:00" }),
    ];
    repos = buildRepos();

    const result = await backfillRawTransactions(repos);
    expect(result.sellOrdersBackfilled).toBe(1); // one sell order, not two

    const cachedAllocations = await repos.committedLedger.getAllocations(PORTFOLIO, "COMI");
    expect(cachedAllocations).toHaveLength(2);
    expect(cachedAllocations.map((a) => a.shares).sort((a, b) => a - b)).toEqual([30, 70]);
  });

  it("backfills a PositionVerification into a PositionVerificationCapture", async () => {
    verifications = [{ id: "v1", portfolioId: PORTFOLIO, ticker: "COMI", units: 100, capturedAt: "2026-02-10T00:00", source: "screenshot" }];
    repos = buildRepos();

    const result = await backfillRawTransactions(repos);
    expect(result.verificationsBackfilled).toBe(1);

    const [txn] = await repos.rawTransactions.getAll();
    expect(txn.kind).toBe("PositionVerificationCapture");
    expect(txn.source).toBe("backfill");
  });

  it("refuses to run a second time — re-running would duplicate every historical fact", async () => {
    trades = [createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" })];
    repos = buildRepos();

    await backfillRawTransactions(repos);
    await expect(backfillRawTransactions(repos)).rejects.toBeInstanceOf(BackfillAlreadyRanError);
  });

  it("an allocation referencing a deleted trade fails loudly rather than silently producing a wrong lotRef", async () => {
    allocations = [
      createTradeAllocation({ id: "a1", sellGroupId: "sg1", portfolioId: PORTFOLIO, tradeId: "does-not-exist", ticker: "COMI", sharesClosed: 30, exitPrice: 50, executionDate: "2026-02-01", executionTime: "11:00" }),
    ];
    repos = buildRepos();

    await expect(backfillRawTransactions(repos)).rejects.toThrow(/no longer exists/);
  });

  it("backfills a Dividend and a CashAdjustment TimelineEvent into facts, reusing the event's own id", async () => {
    timelineEvents = [
      { id: "div-1", portfolioId: PORTFOLIO, type: "Dividend", timestamp: "2026-04-30T00:00", ticker: "PHAR", amount: 44.18, attachments: [], createdAt: "2026-04-30T00:00" },
      { id: "adj-1", portfolioId: PORTFOLIO, type: "CashAdjustment", timestamp: "2026-01-15T00:00", amount: -50, notes: "bank fee", attachments: [], createdAt: "2026-01-15T00:00" },
    ];
    repos = buildRepos();

    const result = await backfillRawTransactions(repos);
    expect(result.cashEventsBackfilled).toBe(2);

    const facts = await repos.rawTransactions.getAll();
    const dividendFact = facts.find((f) => f.id === "div-1")!;
    expect(dividendFact.kind).toBe("DividendPayment");
    expect(dividendFact.source).toBe("backfill");
    expect(dividendFact.payload).toEqual({ ticker: "PHAR", amount: 44.18, date: "2026-04-30" });

    const adjustmentFact = facts.find((f) => f.id === "adj-1")!;
    expect(adjustmentFact.kind).toBe("CashAdjustment");
    expect(adjustmentFact.payload).toEqual({ amount: -50, notes: "bank fee", date: "2026-01-15" });
  });

  it("a portfolio with only a Dividend event (no trades at all) is still backfilled — enumerated from every portfolio, not just ones with trades", async () => {
    timelineEvents = [{ id: "div-1", portfolioId: PORTFOLIO, type: "Dividend", timestamp: "2026-04-30T00:00", amount: 10, attachments: [], createdAt: "2026-04-30T00:00" }];
    repos = buildRepos();

    const result = await backfillRawTransactions(repos);
    expect(result).toEqual({ buysBackfilled: 0, sellOrdersBackfilled: 0, verificationsBackfilled: 0, cashEventsBackfilled: 1 });
  });

  it("an empty ledger backfills nothing", async () => {
    repos = buildRepos();
    const result = await backfillRawTransactions(repos);
    expect(result).toEqual({ buysBackfilled: 0, sellOrdersBackfilled: 0, verificationsBackfilled: 0, cashEventsBackfilled: 0 });
    expect(await repos.rawTransactions.getAll()).toEqual([]);
  });
});

/**
 * BF-1 Validation Design (docs/PORTFOLIO_OS_V2_SPEC.md Part 19): the safety
 * case for running a backfill automatically, unattended, on every app load
 * rests entirely on this variant NEVER touching anything but rawTransactions
 * — no commit, no cache write, no legacy-table rewrite. These tests are that
 * safety case's regression coverage: every one of them is meaningless (and
 * would need to fail) if `backfillRawTransactionsSilently` were ever changed
 * to route through `appendAndMaybeCommit` like its sibling.
 */
describe("backfillRawTransactionsSilently", () => {
  let trades: Trade[];
  let allocations: TradeAllocation[];
  let verifications: PositionVerification[];
  let timelineEvents: TimelineEvent[];
  let repos: BackfillRepos;

  function buildRepos() {
    return {
      portfolios: createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO, name: "Main", kind: "Trading" })]),
      trades: createFakeTradeRepository(trades),
      allocations: createFakeTradeAllocationRepository(allocations),
      verifications: createFakeVerificationRepository(verifications),
      timeline: createFakeTimelineRepository(timelineEvents),
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    };
  }

  beforeEach(() => {
    trades = [];
    allocations = [];
    verifications = [];
    timelineEvents = [];
  });

  /**
   * NOT a byte-for-byte comparison against `backfillRawTransactions`'s own
   * output — an earlier version of this test asserted exact equality and
   * caught a real, previously-undocumented defect in the REACTIVE variant
   * instead: appending the SellExecution fact reactively triggers
   * `commitTicker` (via `appendAndMaybeCommit`) mid-loop, before the main
   * backfill loop has written its own `SellAllocationDecision` fact for that
   * sell — so `commitTicker`'s own `ensureLegacyFactsExist` gap-backfill step
   * sees no decision yet, treats it as a gap, and writes one itself. The
   * main loop then writes its own, second, decision fact for the identical
   * sell order moments later. Functionally harmless (the Allocation Engine's
   * replay only ever draws down a lot's remaining balance once — the second,
   * duplicate decision resolves against an already-fully-consumed lot and is
   * silently skipped, per `generateAllocations`'s own `remaining === 0`
   * guard) but it is a real duplicate immutable fact, permanently doubling
   * that sell's audit trail. This is exactly the kind of emergent,
   * non-obvious behavior the BF-1 Validation Design (Part 19) flagged as a
   * reason the reactive path can't be fully reasoned about from source
   * alone — filed as a known, disclosed, NOT-fixed-here defect in
   * `backfillRawTransactions` (out of scope: a different, already-tested,
   * already-shipped function; "never combine unrelated migrations"). The
   * silent variant is immune by construction — it never triggers a commit at
   * all, so `ensureLegacyFactsExist` never runs during a silent backfill.
   */
  it("produces exactly one fact per real Buy/Sell/Decision — no duplicates, unlike a known quirk in the reactive variant", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }),
    ];
    allocations = [
      createTradeAllocation({
        id: "a1",
        sellGroupId: "sg1",
        portfolioId: PORTFOLIO,
        tradeId: "t1",
        ticker: "COMI",
        sharesClosed: 100,
        exitPrice: 50,
        executionDate: "2026-02-01",
        executionTime: "11:00",
      }),
    ];
    repos = buildRepos();

    await backfillRawTransactionsSilently(repos);

    const facts = await repos.rawTransactions.getAll();
    const kindCounts = Object.fromEntries(["BuyExecution", "SellExecution", "SellAllocationDecision"].map((k) => [k, facts.filter((f) => f.kind === k).length]));
    expect(kindCounts).toEqual({ BuyExecution: 1, SellExecution: 1, SellAllocationDecision: 1 });

    const decision = facts.find((f) => f.kind === "SellAllocationDecision")!;
    expect(decision.payload).toEqual({ sellExecutionId: "sg1", allocations: [{ lotRef: "t1", shares: 100 }] });
  });

  it("never touches ledgerCache/allocationsCache — the entire reason this variant is safe for an automatic, unattended trigger", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }),
    ];
    allocations = [
      createTradeAllocation({
        id: "a1",
        sellGroupId: "sg1",
        portfolioId: PORTFOLIO,
        tradeId: "t1",
        ticker: "COMI",
        sharesClosed: 100,
        exitPrice: 50,
        executionDate: "2026-02-01",
        executionTime: "11:00",
      }),
    ];
    repos = buildRepos();

    // Sanity check first: the SAME data, through the reactive variant, DOES
    // populate the cache (already proven above) — so this test's "empty"
    // result below is a real property of the silent variant, not an
    // artifact of the fixture never producing a terminal verdict at all.
    await backfillRawTransactionsSilently(repos);

    expect(await repos.committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
    expect(await repos.committedLedger.getAllocations(PORTFOLIO, "COMI")).toEqual([]);
  });

  it("never touches the legacy trades/allocations tables — the original rows are returned byte-for-byte unchanged", async () => {
    const originalTrade = createTrade({
      id: "t1",
      portfolioId: PORTFOLIO,
      ticker: "COMI",
      shares: 100,
      entryPrice: 40,
      executionDate: "2026-01-15",
      executionTime: "10:00",
      notes: "conviction buy",
      strategyTags: ["swing"],
    });
    trades = [originalTrade];
    const originalAllocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: PORTFOLIO,
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 100,
      exitPrice: 50,
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });
    allocations = [originalAllocation];
    repos = buildRepos();

    await backfillRawTransactionsSilently(repos);

    expect(await repos.trades.getByPortfolio(PORTFOLIO)).toEqual([originalTrade]);
    expect(await repos.allocations.getByPortfolio(PORTFOLIO)).toEqual([originalAllocation]);
  });

  it("refuses to run a second time, same guard as the reactive variant", async () => {
    trades = [createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" })];
    repos = buildRepos();

    await backfillRawTransactionsSilently(repos);
    await expect(backfillRawTransactionsSilently(repos)).rejects.toBeInstanceOf(BackfillAlreadyRanError);
  });

  it("once complete, computeCashProjection over the resulting facts matches the cash a real Deposit/Buy/Sell/Dividend history should produce — the actual goal this variant exists to unblock", async () => {
    timelineEvents = [
      { id: "div-1", portfolioId: PORTFOLIO, type: "Dividend", timestamp: "2026-04-30T00:00", ticker: "PHAR", amount: 44.18, attachments: [], createdAt: "2026-04-30T00:00" },
      { id: "adj-1", portfolioId: PORTFOLIO, type: "CashAdjustment", timestamp: "2026-01-15T00:00", amount: -50, notes: "bank fee", attachments: [], createdAt: "2026-01-15T00:00" },
    ];
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, fees: 5, executionDate: "2026-01-15", executionTime: "10:00" }),
    ];
    repos = buildRepos();

    await backfillRawTransactionsSilently(repos);

    const { computeCashProjection } = await import("./cashProjection");
    const facts = await repos.rawTransactions.getAll();
    const cashDelta = computeCashProjection(facts, PORTFOLIO);
    // -4005 (100 * 40 + 5 fee) - 50 (adjustment) + 44.18 (dividend)
    expect(cashDelta).toBeCloseTo(-4000 - 5 - 50 + 44.18, 5);
  });
});

/**
 * Regression coverage for the invariant: "exactly one live canonical
 * execution fact per business execution identity." A real, reported defect
 * (ARCC: 42 shares, 1 Official-Broker-Excel-adopted lot) — BF-1's own loop
 * unconditionally wrote `{id: trade.id, source: "backfill"}` for EVERY
 * trade with no existence check, so any trade whose real fact had been
 * "adopted" (trade.id !== fact.id, the normal case for a document-sourced
 * Buy/Sell — see TradeService.ensureBuyFact) got a second, phantom,
 * lowest-authority live fact. That phantom broke
 * isTickerFullyOfficialBrokerExcelSourced (dragging the whole ticker's
 * authority down to "backfill" rank 0), which flipped Import's "Needs
 * broker screenshot" badge on for an already-fully-verified position, and
 * — proven separately — corrupted a raw-fact replay's Holdings/Ledger
 * (double-counted shares) and the real fact's own Verification verdict
 * (Verified -> Rejected, as the "duplicate" of its own phantom). These
 * tests fail against the pre-fix `runBackfill` (no existence check) and
 * pass against the fixed one (skips a trade/sell-order already covered by
 * a live fact of the same execution identity).
 */
describe("backfillRawTransactionsSilently — one-canonical-fact-per-execution invariant", () => {
  const PORTFOLIO_2 = "p1";

  it("ARCC regression: does not create a second fact for a Trade already covered by an adopted (differently-id'd) live BuyExecution fact", async () => {
    const adoptedFact: RawTransaction = {
      ...createRawTransaction({
        id: "extracted-key-1", // the import session key — NOT trade.id, exactly like a real adopted fact.
        kind: "BuyExecution",
        source: "official-broker-excel",
        portfolioId: PORTFOLIO_2,
        ticker: "ARCC",
        payload: { ticker: "ARCC", shares: 42, price: 10, fees: 0, taxes: 0, executionDate: "2026-01-15", executionTime: "10:00AM" },
      }),
      seq: 1,
    };
    const trade = createTrade({ id: "trade-1", portfolioId: PORTFOLIO_2, ticker: "ARCC", shares: 42, entryPrice: 10, executionDate: "2026-01-15", executionTime: "10:00AM" });
    expect(trade.id).not.toBe(adoptedFact.id); // the exact "adoption" shape the bug depended on.

    const repos: BackfillRepos = {
      portfolios: createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO_2, name: "Main", kind: "Trading" })]),
      trades: createFakeTradeRepository([trade]),
      allocations: createFakeTradeAllocationRepository([]),
      verifications: createFakeVerificationRepository([]),
      timeline: createFakeTimelineRepository([]),
      rawTransactions: createFakeRawTransactionRepository([adoptedFact]),
      committedLedger: createFakeCommittedLedgerRepository(),
    };

    const result = await backfillRawTransactionsSilently(repos);
    expect(result.buysBackfilled).toBe(0); // already covered — nothing to backfill.

    const facts = await repos.rawTransactions.getAll();
    expect(facts).toHaveLength(1); // no phantom fact created.
    expect(facts[0].id).toBe(adoptedFact.id);
    expect(facts[0].source).toBe("official-broker-excel");
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "ARCC")).toBe(true); // the warning stays off.
  });

  it("sell side: does not create a second SellExecution fact for a sell order already covered by an adopted live fact", async () => {
    const adoptedSellFact: RawTransaction = {
      ...createRawTransaction({
        id: "extracted-sell-key",
        kind: "SellExecution",
        source: "official-broker-excel",
        portfolioId: PORTFOLIO_2,
        ticker: "ARCC",
        payload: { ticker: "ARCC", shares: 20, price: 12, fees: 0, taxes: 0, executionDate: "2026-02-01", executionTime: "11:00AM" },
      }),
      seq: 1,
    };
    const buyTrade = createTrade({ id: "t1", portfolioId: PORTFOLIO_2, ticker: "ARCC", shares: 20, entryPrice: 10, executionDate: "2026-01-15", executionTime: "10:00AM" });
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg-does-not-match-fact-id", // legacy sellGroupId not equal to the adopted fact's real id — the exact shape that let the sell-side loop miss the existing fact before the fix.
      portfolioId: PORTFOLIO_2,
      tradeId: buyTrade.id,
      ticker: "ARCC",
      sharesClosed: 20,
      exitPrice: 12,
      executionDate: "2026-02-01",
      executionTime: "11:00AM",
    });

    const repos: BackfillRepos = {
      portfolios: createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO_2, name: "Main", kind: "Trading" })]),
      trades: createFakeTradeRepository([buyTrade]),
      allocations: createFakeTradeAllocationRepository([allocation]),
      verifications: createFakeVerificationRepository([]),
      timeline: createFakeTimelineRepository([]),
      rawTransactions: createFakeRawTransactionRepository([adoptedSellFact]),
      committedLedger: createFakeCommittedLedgerRepository(),
    };

    const result = await backfillRawTransactionsSilently(repos);
    expect(result.sellOrdersBackfilled).toBe(0);

    const facts = await repos.rawTransactions.getAll();
    const sellFacts = facts.filter((f) => f.kind === "SellExecution");
    expect(sellFacts).toHaveLength(1); // no phantom SellExecution created.
    expect(sellFacts[0].id).toBe(adoptedSellFact.id);

    // The SellAllocationDecision this run DOES still write must reference
    // the real, existing fact's id — never a stale/wrong id from the
    // skipped write.
    const decision = facts.find((f) => f.kind === "SellAllocationDecision")!;
    expect((decision.payload as { sellExecutionId: string }).sellExecutionId).toBe(adoptedSellFact.id);
  });

  it("a Trade with NO existing live fact at all is still backfilled normally — the invariant fix only skips genuinely-covered executions", async () => {
    const trade = createTrade({ id: "t1", portfolioId: PORTFOLIO_2, ticker: "COMI", shares: 50, entryPrice: 30, executionDate: "2026-01-15", executionTime: "10:00" });
    const repos: BackfillRepos = {
      portfolios: createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO_2, name: "Main", kind: "Trading" })]),
      trades: createFakeTradeRepository([trade]),
      allocations: createFakeTradeAllocationRepository([]),
      verifications: createFakeVerificationRepository([]),
      timeline: createFakeTimelineRepository([]),
      rawTransactions: createFakeRawTransactionRepository([]),
      committedLedger: createFakeCommittedLedgerRepository(),
    };

    const result = await backfillRawTransactionsSilently(repos);
    expect(result.buysBackfilled).toBe(1);
    const facts = await repos.rawTransactions.getAll();
    expect(facts).toHaveLength(1);
    expect(facts[0].source).toBe("backfill");
  });
});

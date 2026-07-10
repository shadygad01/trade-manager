import { beforeEach, describe, expect, it } from "vitest";
import { backfillRawTransactions, BackfillAlreadyRanError, type BackfillRepos } from "./backfillRawTransactions";
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

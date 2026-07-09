import { beforeEach, describe, expect, it } from "vitest";
import { validatePortfolio } from "./systemValidation";
import { backfillRawTransactions } from "./backfillRawTransactions";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { createTrade, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, type TradeAllocation } from "@domain/entities/TradeAllocation";
import type { AppRepositories } from "./types";
import type { CommitEngineRepos } from "./commitEngine";

const PORTFOLIO = "p1";

describe("systemValidation.validatePortfolio", () => {
  let trades: Trade[];
  let allocations: TradeAllocation[];
  let repos: AppRepositories & CommitEngineRepos;

  function buildRepos() {
    return {
      ...createFakeRepositories({ trades, allocations }),
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    };
  }

  beforeEach(() => {
    trades = [];
    allocations = [];
  });

  it("an empty portfolio validates as clear with nothing to compare", async () => {
    repos = buildRepos();
    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.summary).toEqual({ tickersCompared: 0, clear: 0, blocked: 0 });
  });

  it("a portfolio backfilled correctly (old and new agree) validates as clear", async () => {
    trades = [createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" })];
    repos = buildRepos();
    await backfillRawTransactions(repos);

    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.summary).toEqual({ tickersCompared: 1, clear: 1, blocked: 0 });
    expect(report.tickers[0]).toMatchObject({ ticker: "COMI", status: "clear", differences: [] });
  });

  it("a closed position (buy+sell backfilled) still validates as clear — shares/cost-basis both agree at zero open shares", async () => {
    // remainingShares: 0 mirrors what TradeService.recordSell would have set
    // in the real app — the old system's own computePositions relies on it
    // being kept in sync, same as everywhere else in this codebase.
    trades = [
      { ...createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }), remainingShares: 0 },
    ];
    allocations = [
      createTradeAllocation({ id: "a1", sellGroupId: "sg1", portfolioId: PORTFOLIO, tradeId: "t1", ticker: "COMI", sharesClosed: 100, exitPrice: 50, executionDate: "2026-02-01", executionTime: "11:00" }),
    ];
    repos = buildRepos();
    await backfillRawTransactions(repos);

    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.tickers[0].status).toBe("clear");
  });

  it("a Trade that was never backfilled is reported missing-in-new and blocks the ticker", async () => {
    trades = [createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" })];
    repos = buildRepos();
    // Deliberately skip backfillRawTransactions — simulates a portfolio the migration hasn't reached yet.

    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.tickers[0].status).toBe("blocked");
    expect(report.tickers[0].differences.some((d) => d.category === "missing-in-new")).toBe(true);
    expect(report.summary.blocked).toBe(1);
  });

  it("a genuine shares disagreement between old and new is caught even when every trade is present in the new ledger", async () => {
    trades = [createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" })];
    repos = buildRepos();
    await backfillRawTransactions(repos);

    // Simulate a bug in the new system's replay: overwrite the committed
    // ledger with a lot whose shares disagree with the old Trade, keeping
    // the same eventId so the "missing-in-new" check alone wouldn't catch it.
    const events = await repos.committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    const corrupted = events.map((e) => (e.type === "LotOpened" ? { ...e, shares: 999 } : e));
    await repos.committedLedger.commitTicker({ portfolioId: PORTFOLIO, ticker: "COMI", events: corrupted, allocations: [] });

    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.tickers[0].status).toBe("blocked");
    expect(report.tickers[0].differences.some((d) => d.category === "shares-mismatch")).toBe(true);
  });

  it("multiple tickers are reported independently, sorted, with an accurate summary", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "HRHO", shares: 20, entryPrice: 10, executionDate: "2026-01-01", executionTime: "10:00" }),
      createTrade({ id: "t2", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }),
    ];
    repos = buildRepos();
    await backfillRawTransactions(repos);

    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.tickers.map((t) => t.ticker)).toEqual(["COMI", "HRHO"]); // sorted
    expect(report.summary).toEqual({ tickersCompared: 2, clear: 2, blocked: 0 });
  });

  it("validation for one portfolio never reads or reports another portfolio's trades", async () => {
    trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 40, executionDate: "2026-01-15", executionTime: "10:00" }),
      createTrade({ id: "t2", portfolioId: "other-portfolio", ticker: "HRHO", shares: 20, entryPrice: 10, executionDate: "2026-01-01", executionTime: "10:00" }),
    ];
    repos = buildRepos();
    await backfillRawTransactions(repos);

    const report = await validatePortfolio(repos, PORTFOLIO);
    expect(report.tickers.map((t) => t.ticker)).toEqual(["COMI"]);
  });
});

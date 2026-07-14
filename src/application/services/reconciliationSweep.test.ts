import { beforeEach, describe, expect, it } from "vitest";
import { runReconciliationSweep, type ReconciliationSweepRepos } from "./reconciliationSweep";
import {
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
  createFakeTradeRepository,
  createFakeTradeAllocationRepository,
} from "@application/testUtils/fakeRepositories";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import { isRetracted } from "./rawTransactionFolds";
import type { RawTransactionRepository, CommittedLedgerRepository, TradeRepository, TradeAllocationRepository } from "@domain/repositories";

const PORTFOLIO = "portfolio-sweep-1";

let rawTransactions: RawTransactionRepository;
let committedLedger: CommittedLedgerRepository;
let trades: TradeRepository;
let allocations: TradeAllocationRepository;
let repos: ReconciliationSweepRepos;

beforeEach(() => {
  rawTransactions = createFakeRawTransactionRepository();
  committedLedger = createFakeCommittedLedgerRepository();
  trades = createFakeTradeRepository();
  allocations = createFakeTradeAllocationRepository();
  repos = { rawTransactions, committedLedger, trades, allocations };
});

/** Same synthetic-fixture discipline as commitEngine.reconcileDuplicateAuthority.test.ts — proves the sweep is generic, not special-cased to any one real ticker. */
describe("runReconciliationSweep — manual, user-initiated retroactive pass", () => {
  it("converges a pre-existing backfill/official-broker-excel duplicate pair via the real commitTicker pipeline", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEP1", shares: 14, price: 67.4, executionDate: "2026-06-30" };
    const backfillFact = await rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEP1", payload }),
    );
    const excelFact = await rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEP1", payload }),
    );

    const report = await runReconciliationSweep(repos);

    expect(report.tickersScanned).toBe(1);
    expect(report.duplicateGroupsFound).toBe(1);
    expect(report.factsRetracted).toBe(1);
    expect(report.factsSkipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.perTicker).toEqual([
      { portfolioId: PORTFOLIO, ticker: "SWEEP1", duplicateGroupsFound: 1, factsRetracted: 1, factsSkipped: 0 },
    ]);

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillFact.id)).toBe(true);
    expect(isRetracted(all, excelFact.id)).toBe(false);
  });

  it("is idempotent — a second run over the same data reports zero, nothing left to converge", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEP2", shares: 50, price: 26.5, executionDate: "2026-03-04" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEP2", payload }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEP2", payload }));

    const first = await runReconciliationSweep(repos);
    expect(first.factsRetracted).toBe(1);

    const second = await runReconciliationSweep(repos);
    expect(second.tickersScanned).toBe(1);
    expect(second.duplicateGroupsFound).toBe(0);
    expect(second.factsRetracted).toBe(0);
    expect(second.factsSkipped).toBe(0);
    expect(second.errors).toEqual([]);
  });

  it("reports a genuine tie as found-but-skipped, never auto-resolving it", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEP3", shares: 40, price: 5.5, executionDate: "2026-02-14" };
    const first = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "SWEEP3", payload }));
    const second = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "SWEEP3", payload }));

    const report = await runReconciliationSweep(repos);

    expect(report.duplicateGroupsFound).toBe(1);
    expect(report.factsRetracted).toBe(0);
    expect(report.factsSkipped).toBe(2);

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, first.id)).toBe(false);
    expect(isRetracted(all, second.id)).toBe(false);
  });

  it("a mixed group (one clear loser plus two tied co-leaders) reports the resolved loser as retracted and the tied leftover pair as skipped, not as a full survivor", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEP5", shares: 100, price: 12, executionDate: "2026-04-01" };
    const loser = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEP5", payload }));
    const leaderA = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEP5", payload }));
    const leaderB = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEP5", payload }));

    const report = await runReconciliationSweep(repos);

    expect(report.duplicateGroupsFound).toBe(1);
    expect(report.factsRetracted).toBe(1);
    expect(report.factsSkipped).toBe(2);

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, loser.id)).toBe(true);
    expect([isRetracted(all, leaderA.id), isRetracted(all, leaderB.id)]).toEqual([false, false]);
  });

  it("does not process a ticker with no live Buy/Sell facts, and skips a fact with no resolved portfolio", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEP4", shares: 3, price: 448, executionDate: "2026-02-11" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "SWEEP4", payload }));

    const report = await runReconciliationSweep(repos);

    expect(report.tickersScanned).toBe(0);
    expect(report.perTicker).toEqual([]);
  });

  it("isolates a per-ticker failure — one ticker erroring does not stop the rest of the sweep", async () => {
    const payloadErr: BuyExecutionPayload = { ticker: "SWEEPERR", shares: 89, price: 22.3, executionDate: "2026-02-02" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPERR", payload: payloadErr }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPERR", payload: payloadErr }));

    const payloadOk: BuyExecutionPayload = { ticker: "SWEEPOK", shares: 35, price: 76.5, executionDate: "2026-03-09" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPOK", payload: payloadOk }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPOK", payload: payloadOk }));

    // SWEEPERR is processed first (fact insertion order = pair enumeration
    // order for this fake store) — simulates a transient read failure while
    // the sweep is mid-way through that one ticker's own before/after diff.
    let callCount = 0;
    const flakyRawTransactions: RawTransactionRepository = {
      ...rawTransactions,
      async getAll() {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated transient read failure");
        return rawTransactions.getAll();
      },
    };

    const report = await runReconciliationSweep({ ...repos, rawTransactions: flakyRawTransactions });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({ portfolioId: PORTFOLIO, ticker: "SWEEPERR", message: "simulated transient read failure" });

    const okResult = report.perTicker.find((r) => r.ticker === "SWEEPOK");
    expect(okResult).toEqual({ portfolioId: PORTFOLIO, ticker: "SWEEPOK", duplicateGroupsFound: 1, factsRetracted: 1, factsSkipped: 0 });
  });
});

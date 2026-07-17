
import { beforeEach, describe, expect, it } from "vitest";
import { runReconciliationSweep, type ReconciliationSweepRepos } from "./reconciliationSweep";
import {
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
  createFakeTradeRepository,
  createFakeTradeAllocationRepository,
} from "@application/testUtils/fakeRepositories";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import { createTrade } from "@domain/entities/Trade";
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

/** Same synthetic-fixture discipline as commitEngine.reconcileDuplicateAuthority.test.ts â€” proves the sweep is generic, not special-cased to any one real ticker. */
describe("runReconciliationSweep â€” manual, user-initiated retroactive pass", () => {
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
      {
        portfolioId: PORTFOLIO,
        ticker: "SWEEP1",
        duplicateGroupsFound: 1,
        factsRetracted: 1,
        factsSkipped: 0,
        officialBrokerDuplicatesRetracted: 1,
        officialBrokerAllocationsRepaired: 0,
      },
    ]);

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillFact.id)).toBe(true);
    expect(isRetracted(all, excelFact.id)).toBe(false);
  });

  it("converges a time-resolved duplicate even when a different twin lot shares its time-blind canonical key", async () => {
    const earlier: BuyExecutionPayload = {
      ticker: "SWEEPTIME",
      shares: 49,
      price: 42.4,
      executionDate: "2026-02-01",
      executionTime: "10:32AM",
    };
    await trades.save(createTrade({ id: "trade-earlier", portfolioId: PORTFOLIO, ticker: "SWEEPTIME", shares: 49, entryPrice: 42.4, executionDate: "2026-02-01", executionTime: "10:32" }));
    await trades.save(createTrade({ id: "trade-later", portfolioId: PORTFOLIO, ticker: "SWEEPTIME", shares: 49, entryPrice: 42.4, executionDate: "2026-02-01", executionTime: "10:34" }));
    const backfillFact = await rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPTIME", payload: earlier }),
    );
    const excelFact = await rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPTIME", payload: earlier }),
    );
    const report = await runReconciliationSweep(repos);

    expect(report.factsRetracted).toBe(1);
    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillFact.id)).toBe(true);
    expect(isRetracted(all, excelFact.id)).toBe(false);
  });

  it("does not mistake duplicate projected Trade rows for two genuine executions", async () => {
    const payload: BuyExecutionPayload = {
      ticker: "SWEEPPROJECTION",
      shares: 75,
      price: 18.2,
      executionDate: "2026-03-08",
      executionTime: "11:15",
    };
    await trades.save(createTrade({ id: "legacy-projection", portfolioId: PORTFOLIO, ticker: payload.ticker, shares: payload.shares, entryPrice: payload.price, executionDate: payload.executionDate, executionTime: payload.executionTime! }));
    await trades.save(createTrade({ id: "excel-projection", portfolioId: PORTFOLIO, ticker: payload.ticker, shares: payload.shares, entryPrice: payload.price, executionDate: payload.executionDate, executionTime: payload.executionTime! }));
    const backfillFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: payload.ticker, payload }));
    const excelFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: payload.ticker, payload }));

    const report = await runReconciliationSweep(repos);

    expect(report.factsRetracted).toBe(1);
    expect(report.factsSkipped).toBe(0);
    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillFact.id)).toBe(true);
    expect(isRetracted(all, excelFact.id)).toBe(false);
  });

  it("is idempotent â€” a second run over the same data reports zero, nothing left to converge", async () => {
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

  it("isolates a per-ticker failure â€” one ticker erroring does not stop the rest of the sweep", async () => {
    const payloadErr: BuyExecutionPayload = { ticker: "SWEEPERR", shares: 89, price: 22.3, executionDate: "2026-02-02" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPERR", payload: payloadErr }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPERR", payload: payloadErr }));

    const payloadOk: BuyExecutionPayload = { ticker: "SWEEPOK", shares: 35, price: 76.5, executionDate: "2026-03-09" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPOK", payload: payloadOk }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPOK", payload: payloadOk }));

    // SWEEPERR is processed first (fact insertion order = pair enumeration
    // order for this fake store) â€” simulates a transient read failure while
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
    expect(okResult).toEqual({
      portfolioId: PORTFOLIO,
      ticker: "SWEEPOK",
      duplicateGroupsFound: 1,
      factsRetracted: 1,
      factsSkipped: 0,
      officialBrokerDuplicatesRetracted: 1,
      officialBrokerAllocationsRepaired: 0,
    });
  });

  /**
   * Real, user-reported failure: `commitTicker` threw Dexie's own
   * "PrematureCommitError: Transaction committed too early" for a ticker
   * mid-sweep (first FIRE, later also ESRS) — a transient timing race, not a
   * data problem, since the same ticker converged cleanly on a later run.
   * The sweep now retries a `commitTicker` call that fails with exactly this
   * Dexie error, up to twice more, before giving up.
   */
  it("retries a ticker that fails with Dexie's transient 'transaction committed too early' error, and still converges it", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEPRACE", shares: 22, price: 9.9, executionDate: "2026-05-05" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPRACE", payload }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPRACE", payload }));

    let getAllCalls = 0;
    const raceyRawTransactions: RawTransactionRepository = {
      ...rawTransactions,
      async getAll() {
        getAllCalls += 1;
        // Call #9 is `relevantTradeTransactions`'s own read inside
        // commitTicker's FIRST attempt for this ticker — the one call in the
        // whole chain that isn't already swallowed by an internal try/catch
        // (ensureLegacyFactsExist/reconcileDuplicateAuthority both are), so
        // it's the one whose failure actually propagates out of commitTicker
        // exactly the way a real PrematureCommitError would. Every other
        // call (including the retry's own full second attempt) succeeds.
        if (getAllCalls === 9) throw new Error("PrematureCommitError: Transaction committed too early. See http://bit.ly/2VLxK5A");
        return rawTransactions.getAll();
      },
    };

    const report = await runReconciliationSweep({ ...repos, rawTransactions: raceyRawTransactions });

    expect(report.errors).toEqual([]);
    expect(report.factsRetracted).toBe(1);
    const all = await rawTransactions.getAll();
    const backfillLive = all.filter((t) => t.kind === "BuyExecution" && t.source === "backfill" && !isRetracted(all, t.id));
    expect(backfillLive).toHaveLength(0);
  });

  it("does not retry a non-Dexie-timing error — it still surfaces immediately as a per-ticker error", async () => {
    const payload: BuyExecutionPayload = { ticker: "SWEEPNORETRY", shares: 11, price: 3.1, executionDate: "2026-05-06" };
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SWEEPNORETRY", payload }));
    await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SWEEPNORETRY", payload }));

    let getAllCalls = 0;
    const brokenRawTransactions: RawTransactionRepository = {
      ...rawTransactions,
      async getAll() {
        getAllCalls += 1;
        // Same call site as the retry test above (relevantTradeTransactions,
        // the one unguarded read inside commitTicker) — but this message
        // doesn't match the transient-Dexie-race pattern, so it must surface
        // immediately with no retry.
        if (getAllCalls === 9) throw new Error("simulated genuine read failure");
        return rawTransactions.getAll();
      },
    };

    const report = await runReconciliationSweep({ ...repos, rawTransactions: brokenRawTransactions });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({ portfolioId: PORTFOLIO, ticker: "SWEEPNORETRY", message: "simulated genuine read failure" });

    // errorDetail (stack + any cause) is captured on the perTicker row so a
    // real browser-only failure can be diagnosed straight from the panel,
    // without asking the user to dig through DevTools themselves.
    const failedRow = report.perTicker.find((r) => r.ticker === "SWEEPNORETRY");
    expect(failedRow?.errorDetail).toContain("simulated genuine read failure");
  });
});


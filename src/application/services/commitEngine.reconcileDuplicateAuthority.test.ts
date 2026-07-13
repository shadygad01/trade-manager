import { beforeEach, describe, expect, it } from "vitest";
import { commitTicker, reconcileDuplicateAuthority, type CommitEngineRepos } from "./commitEngine";
import {
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
} from "@application/testUtils/fakeRepositories";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import { isRetracted } from "./rawTransactionFolds";
import type { RawTransactionRepository, CommittedLedgerRepository } from "@domain/repositories";

/**
 * Synthetic fixtures throughout — deliberately NOT reproducing the real
 * ABUK data used to find this bug (docs/ROADMAP.md's Sprint entry for the
 * full account). Proves the fix is generic: it must hold for any
 * ticker/portfolio/source pair satisfying "identical canonicalKey, strictly
 * different authorityRank", not a fix special-cased to one real position.
 */

const PORTFOLIO = "portfolio-synthetic-1";

let rawTransactions: RawTransactionRepository;
let committedLedger: CommittedLedgerRepository;
let repos: CommitEngineRepos;

beforeEach(() => {
  rawTransactions = createFakeRawTransactionRepository();
  committedLedger = createFakeCommittedLedgerRepository();
  repos = { rawTransactions, committedLedger };
});

describe("reconcileDuplicateAuthority — generic authority-based convergence", () => {
  it("retracts the lower-authority Buy fact when two live facts share an identical canonicalKey (synthetic ticker/prices)", async () => {
    const payload: BuyExecutionPayload = { ticker: "SYNTH1", shares: 77, price: 8.25, executionDate: "2026-04-12" };
    const backfillFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", ticker: "SYNTH1", payload }));
    const excelFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "SYNTH1", payload }));

    await reconcileDuplicateAuthority(repos, "SYNTH1");

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillFact.id)).toBe(true);
    expect(isRetracted(all, excelFact.id)).toBe(false);
  });

  it("is generic across arbitrary source pairs — not hardcoded to backfill/official-broker-excel (invoice outranks manual)", async () => {
    const payload: BuyExecutionPayload = { ticker: "SYNTH2", shares: 12, price: 130.5, executionDate: "2026-05-03" };
    const manualFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "SYNTH2", payload }));
    const invoiceFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "invoice", ticker: "SYNTH2", payload }));

    await reconcileDuplicateAuthority(repos, "SYNTH2");

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, manualFact.id)).toBe(true);
    expect(isRetracted(all, invoiceFact.id)).toBe(false);
  });

  it("is generic across an arbitrary portfolio/ticker — a completely different synthetic identity than any prior test", async () => {
    const payload: BuyExecutionPayload = { ticker: "ZZZQ", shares: 3, price: 999.99, executionDate: "2026-01-30" };
    const csvFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "csv", portfolioId: "some-other-portfolio", ticker: "ZZZQ", payload }));
    const statementFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "statement", portfolioId: "some-other-portfolio", ticker: "ZZZQ", payload }));

    await reconcileDuplicateAuthority(repos, "ZZZQ");

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, csvFact.id)).toBe(true);
    expect(isRetracted(all, statementFact.id)).toBe(false);
  });

  it("never resolves a genuine tie automatically — two facts of EQUAL authority both stay live", async () => {
    const payload: BuyExecutionPayload = { ticker: "SYNTH3", shares: 40, price: 5.5, executionDate: "2026-02-14" };
    const first = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "SYNTH3", payload }));
    const second = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "SYNTH3", payload }));

    await reconcileDuplicateAuthority(repos, "SYNTH3");

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, first.id)).toBe(false);
    expect(isRetracted(all, second.id)).toBe(false);
  });

  it("never merges two genuinely distinct executions sharing a canonicalKey (a twin lot, different executionTime, even across different authority) — canonicalKey alone is not proof of sameness", async () => {
    // Same ticker/date/shares/price, but two provably different real orders
    // (see crossTransactionIsolation.test.ts's own "twin lot" suite this
    // mirrors) — one lower-authority, one higher, which a naive
    // canonicalKey-only comparison would wrongly treat as a duplicate pair.
    const twinA: BuyExecutionPayload = { ticker: "SYNTH7", shares: 49, price: 42.4, executionDate: "2026-02-01", executionTime: "10:32AM" };
    const twinB: BuyExecutionPayload = { ticker: "SYNTH7", shares: 49, price: 42.4, executionDate: "2026-02-01", executionTime: "10:34AM" };
    const backfillTwin = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "backfill", ticker: "SYNTH7", payload: twinA }));
    const excelTwin = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "SYNTH7", payload: twinB }));

    const converged = await reconcileDuplicateAuthority(repos, "SYNTH7");

    expect(converged).toBe(0);
    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillTwin.id)).toBe(false);
    expect(isRetracted(all, excelTwin.id)).toBe(false);
  });

  it("does nothing when only one live fact exists for a canonicalKey (the common, non-duplicated case)", async () => {
    const payload: BuyExecutionPayload = { ticker: "SYNTH4", shares: 200, price: 1.1, executionDate: "2026-03-01" };
    const onlyFact = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "SYNTH4", payload }));

    const converged = await reconcileDuplicateAuthority(repos, "SYNTH4");

    expect(converged).toBe(0);
    const all = await rawTransactions.getAll();
    expect(isRetracted(all, onlyFact.id)).toBe(false);
  });

  it("Sell-side: re-points a live SellAllocationDecision at the surviving higher-authority fact instead of leaving it dangling", async () => {
    const lotPayload: BuyExecutionPayload = { ticker: "SYNTH5", shares: 60, price: 4, executionDate: "2026-01-01" };
    const lot = await rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "invoice", ticker: "SYNTH5", payload: lotPayload }));

    const sellPayload: SellExecutionPayload = { ticker: "SYNTH5", shares: 60, price: 6, executionDate: "2026-06-01" };
    const backfillSell = await rawTransactions.append(createRawTransaction({ kind: "SellExecution", source: "backfill", ticker: "SYNTH5", payload: sellPayload }));
    const excelSell = await rawTransactions.append(createRawTransaction({ kind: "SellExecution", source: "official-broker-excel", ticker: "SYNTH5", payload: sellPayload }));

    const decisionPayload: SellAllocationDecisionPayload = { sellExecutionId: backfillSell.id, allocations: [{ lotRef: lot.id, shares: 60 }] };
    const decision = await rawTransactions.append(createRawTransaction({ kind: "SellAllocationDecision", source: "backfill", ticker: "SYNTH5", payload: decisionPayload }));

    await reconcileDuplicateAuthority(repos, "SYNTH5");

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillSell.id)).toBe(true);
    expect(isRetracted(all, excelSell.id)).toBe(false);
    expect(isRetracted(all, decision.id)).toBe(true);

    const liveDecisions = all.filter((t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id));
    expect(liveDecisions).toHaveLength(1);
    expect((liveDecisions[0].payload as SellAllocationDecisionPayload).sellExecutionId).toBe(excelSell.id);
    expect((liveDecisions[0].payload as SellAllocationDecisionPayload).allocations).toEqual([{ lotRef: lot.id, shares: 60 }]);
  });
});

describe("commitTicker — reconcileDuplicateAuthority runs automatically through the real commit choke point", () => {
  /**
   * The reproduced production bug: a fact from ensureLegacyFactsExist's
   * reactive gap-fill never passes through duplicateMatch/upgradeFact
   * (those only ever fire for a NEW candidate in an active Import session),
   * so it can coexist with an already-live, higher-authority fact
   * indefinitely. This proves the convergence now happens automatically on
   * a real commit — the actual call chain a user's app takes — not just via
   * a direct, isolated call to reconcileDuplicateAuthority.
   */
  it("a commit for a ticker with a pre-existing duplicate-authority pair converges it without any Import session involved", async () => {
    const payload: BuyExecutionPayload = { ticker: "SYNTH6", shares: 15, price: 22, executionDate: "2026-07-01" };
    const backfillFact = await rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "SYNTH6", payload }),
    );
    const excelFact = await rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SYNTH6", payload }),
    );

    await commitTicker(repos, PORTFOLIO, "SYNTH6");

    const all = await rawTransactions.getAll();
    expect(isRetracted(all, backfillFact.id)).toBe(true);
    expect(isRetracted(all, excelFact.id)).toBe(false);
  });
});

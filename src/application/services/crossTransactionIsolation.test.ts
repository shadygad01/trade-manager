import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { recordBuy, recordSell, type RecordSellInput } from "./TradeService";
import { commitTicker, appendAndMaybeCommit, type CommitEngineRepos } from "./commitEngine";
import { resetSellAllocation, getLotManagerSnapshot } from "./lotManager";
import { recordImportedRawTransactions } from "./importRecording";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

/**
 * Phase 1 regression suite for the production bug reported against the
 * legacy allocation architecture: allocating one Sell transaction
 * incorrectly changed unrelated Sell transactions, closed unrelated Buy
 * lots, and mismatched Holdings. Root cause: the canonical ledger's Ledger
 * Engine / Allocation Engine derived a real execution's PERMANENT identity
 * (LedgerEvent.eventId, and every SellAllocationDecision's `lotRef`/
 * `sellExecutionId` reference) from a recomputed VALUE hash
 * (ticker|side|date|shares|price) instead of the underlying RawTransaction's
 * own always-unique id. Two genuinely distinct real executions sharing that
 * value (e.g. two same-price same-day orders — routine for retail trading)
 * collided onto the identical identity, and every downstream consumer
 * (ledgerProjection's Trade/TradeAllocation rewrite, the Allocation Engine's
 * replay) silently conflated them. Fixed in ledgerRebuild.ts
 * (disambiguateCollidingKeys), allocationEngine.ts (id-based reference
 * resolution), and TradeService.ts/ledgerProjection.ts (facts and decisions
 * now reference real RawTransaction ids). These tests prove two
 * coincidentally-identical Sells/Buys never interfere with each other, and
 * that resetting one Sell's allocation never touches another.
 */

function fullRepos(cash = 10_000_000) {
  const base = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: cash })] });
  return { ...base, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() };
}
type FullRepos = ReturnType<typeof fullRepos>;

/** Backfilled facts are always auto-Verified (see verificationEngine.ts), giving deterministic terminal commits without needing corroborating evidence — the simplest way to reach a real projected state in a test. */
async function backfillBuy(repos: FullRepos, overrides: Partial<BuyExecutionPayload> = {}) {
  const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-01-05", ...overrides };
  return appendAndMaybeCommit(
    repos as CommitEngineRepos,
    createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: "p1", ticker: payload.ticker, payload })
  );
}

async function tradesFor(repos: FullRepos, ticker = "COMI") {
  return (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === ticker);
}
async function allocationsFor(repos: FullRepos, ticker = "COMI") {
  return (await repos.allocations.getByPortfolio("p1")).filter((a) => a.ticker === ticker);
}

describe("cross-transaction isolation — the identity-collision bug is fixed", () => {
  it("two Buy lots sharing an identical value (ticker/date/shares/price) stay two separate lots, not one merged/overwritten lot", async () => {
    const repos = fullRepos();
    // Distinct executionTime makes these provably two different real orders
    // to the OCR-corroboration heuristic (duplicateDetection.sameCandidateExecution) —
    // isolating this test to the identity-collision bug this suite targets,
    // not the separate (pre-existing, out of scope) question of how the
    // dedup heuristic should treat two same-price/date/shares orders that
    // ALSO share an identical or unknown execution time.
    await backfillBuy(repos, { shares: 100, price: 45.5, executionDate: "2026-01-05", executionTime: "10:00" });
    await backfillBuy(repos, { shares: 100, price: 45.5, executionDate: "2026-01-05", executionTime: "14:30" }); // identical value, genuinely different order

    const trades = await tradesFor(repos);
    expect(trades).toHaveLength(2); // BEFORE the fix: the second buy silently overwrote the first — only one row survived.
    expect(trades.reduce((sum, t) => sum + t.shares, 0)).toBe(200);
    expect(trades.every((t) => t.remainingShares === t.shares)).toBe(true);
  });

  it("allocating one Sell only affects the selected Sell and its selected Buy lot — an unrelated Sell sharing the identical value is untouched", async () => {
    const repos = fullRepos();
    const { trade: lotA } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-01", executionTime: "10:00" });
    const { trade: lotB } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-02", executionTime: "10:00" });

    // Two independent sell orders that happen to share the exact same date/shares/price.
    const sellInput = (tradeId: string): RecordSellInput => ({
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId, shares: 100, exitPrice: 50 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });
    const sellA = await recordSell(repos, sellInput(lotA.id));
    const sellB = await recordSell(repos, sellInput(lotB.id));
    expect(sellA.allocations[0].tradeId).toBe(lotA.id);
    expect(sellB.allocations[0].tradeId).toBe(lotB.id);

    // Force a full rebuild — where the pre-fix bug actually manifested (the
    // projection step that rewrites the Trade/TradeAllocation rows the UI reads).
    await commitTicker(repos, "p1", "COMI");

    const trades = await tradesFor(repos);
    expect(trades).toHaveLength(2);
    const rebuiltA = trades.find((t) => t.id === lotA.id)!;
    const rebuiltB = trades.find((t) => t.id === lotB.id)!;
    expect(rebuiltA.remainingShares).toBe(0); // fully closed by ITS OWN sell
    expect(rebuiltB.remainingShares).toBe(0); // fully closed by ITS OWN sell — not left open, not double-closed

    const allocations = await allocationsFor(repos);
    expect(allocations).toHaveLength(2); // both sells' allocations survived the rebuild independently
    expect(allocations.find((a) => a.tradeId === lotA.id)).toBeDefined();
    expect(allocations.find((a) => a.tradeId === lotB.id)).toBeDefined();
  });

  it("Reset Allocation on one Sell removes ONLY that Sell's allocation events — an unrelated Sell with the identical value keeps its own", async () => {
    const repos = fullRepos();
    const { trade: lotA } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-01", executionTime: "10:00" });
    const { trade: lotB } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-02", executionTime: "10:00" });

    const sellInput = (tradeId: string): RecordSellInput => ({
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId, shares: 100, exitPrice: 50 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });
    await recordSell(repos, sellInput(lotA.id));
    await recordSell(repos, sellInput(lotB.id));
    await commitTicker(repos, "p1", "COMI");
    expect(await allocationsFor(repos)).toHaveLength(2);

    // "Reset Allocation" on sell A only, via the Lot Manager's own reset action.
    const snapshotBeforeReset = await getLotManagerSnapshot(repos, "p1", "COMI");
    const sellAId = snapshotBeforeReset.sells.find((s) => s.allocations.some((a) => a.buyLotId === lotA.id))!.id;
    expect(sellAId).toBeDefined();
    await resetSellAllocation(repos, "p1", "COMI", sellAId);

    const trades = await tradesFor(repos);
    const rebuiltA = trades.find((t) => t.id === lotA.id)!;
    const rebuiltB = trades.find((t) => t.id === lotB.id)!;
    expect(rebuiltA.remainingShares).toBe(100); // reset — fully back to unallocated
    expect(rebuiltB.remainingShares).toBe(0); // completely untouched by the other sell's reset

    const allocations = await allocationsFor(repos);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].tradeId).toBe(lotB.id);
  });

  it("no automatic lot closing: two Buy lots with identical value are never silently merged even across repeated commits (deterministic rebuild)", async () => {
    const repos = fullRepos();
    await backfillBuy(repos, { shares: 60, price: 45.5, executionDate: "2026-01-05", executionTime: "09:15" });
    await backfillBuy(repos, { shares: 60, price: 45.5, executionDate: "2026-01-05", executionTime: "13:45" });

    const snapshot = async () => {
      const trades = (await tradesFor(repos)).map((t) => ({ id: t.id, shares: t.shares, remainingShares: t.remainingShares })).sort((a, b) => a.id.localeCompare(b.id));
      return trades;
    };

    const first = await snapshot();
    expect(first).toHaveLength(2);
    await commitTicker(repos, "p1", "COMI");
    await commitTicker(repos, "p1", "COMI");
    const after = await snapshot();
    expect(after).toEqual(first); // rebuild reproduces identical results — no drift, no re-merge
  });

  it("inventory consistency: remaining shares always equal Buy quantity minus the SUM of that lot's own allocation events, never affected by a same-value sibling", async () => {
    const repos = fullRepos();
    const { trade: lotA } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-01", executionTime: "10:00" });
    const { trade: lotB } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-02", executionTime: "10:00" });

    // Partial sell against lotA only; lotB left fully open despite sharing lotA's exact value.
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: lotA.id, shares: 30, exitPrice: 50 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });
    await commitTicker(repos, "p1", "COMI");

    const trades = await tradesFor(repos);
    const rebuiltA = trades.find((t) => t.id === lotA.id)!;
    const rebuiltB = trades.find((t) => t.id === lotB.id)!;
    expect(rebuiltA.remainingShares).toBe(70); // 100 - 30
    expect(rebuiltB.remainingShares).toBe(100); // untouched — no allocation ever referenced it
  });
});

/**
 * Phase 2 regression suite for a DIFFERENT identity-collision code path than
 * Phase 1 above: Phase 1's tests all use recordBuy/backfillBuy with no
 * pre-existing extraction-time fact, which makes ensureBuyFact mint a fresh
 * "manual"/"backfill" sourced fact — routed by generateLedgerEvents straight
 * to toDirectEvent (eventId = txn.id, sourceTransactionIds = [txn.id]),
 * never through canonicalizeTradeEntries at all. That path was never
 * vulnerable to this bug.
 *
 * Real, reported bug (ABUK, with before/after screenshots): a ticker
 * imported from an official broker Excel export — extraction-time facts
 * already exist (source "official-broker-excel"), so Confirm's recordBuy
 * ADOPTS them via ensureBuyFact rather than minting manual ones. Every
 * adopted fact routes through canonicalizeTradeEntries (ledgerRebuild.ts),
 * whose sourceUploadIds construction grouped strictly by
 * pendingCandidateSignature (ticker|side|date|shares — time-blind). Two
 * genuinely distinct real buys sharing that signature (two 49-share ABUK
 * buys at E£42.40 on 2023-02-01, 10:32AM and 10:34AM — an ordinary pattern,
 * splitting an order into same-price fills minutes apart) had their real
 * fact ids unioned into ONE shared sourceUploadIds/sourceTransactionIds set.
 * allocationEngine.indexEventsByReference then indexed that shared set as an
 * alias map from "either real id" to "whichever lot is processed first" —
 * so a Sell allocation whose `lotRef` resolveLotRef had correctly resolved
 * to the SECOND lot's own real fact id still misattributed against the
 * FIRST lot, corrupting the ticker's Smart-Allocate share count exactly as
 * reported ("Calculated 27" before Smart Allocate, "Calculated 76" — Needs
 * broker screenshot — immediately after). Fixed by making
 * canonicalizeTradeEntries' sourceUploadIds construction time-aware (via the
 * same timesConflict helper sameCandidateExecution/
 * suggestDuplicatePendingCandidateKeysToDelete already use for this exact
 * signature elsewhere), without touching indexEventsByReference or
 * resolveLotRef at all — see docs/ROADMAP.md.
 */
describe("cross-transaction isolation, phase 2 — two document-sourced (official-broker-excel) buys sharing a time-blind signature", () => {
  async function importedCandidate(repos: FullRepos, key: string, candidate: ParsedTradeCandidate) {
    await recordImportedRawTransactions(repos as CommitEngineRepos, {
      sourceUploadId: "upload-1",
      candidates: [{ key, candidate }],
      verifications: [],
      dividends: [],
      orderEvidences: [],
      cancelledOrders: [],
    });
  }

  it("Smart Allocate closes each twin lot against its OWN sell — remaining shares stay correct for both, matching the real reported numbers", async () => {
    const repos = fullRepos();
    const twin1032: ParsedTradeCandidate = { ticker: "ABUK", side: "BUY", shares: 49, price: 42.4, date: "2026-02-01", time: "10:32AM", source: "official-broker-excel" };
    const twin1034: ParsedTradeCandidate = { ticker: "ABUK", side: "BUY", shares: 49, price: 42.4, date: "2026-02-01", time: "10:34AM", source: "official-broker-excel" };
    await importedCandidate(repos, "cand-1032", twin1032);
    await importedCandidate(repos, "cand-1034", twin1034);

    // Confirm: recordBuy ADOPTS the pre-existing extraction-time facts (via
    // ensureBuyFact's time tie-break), exactly like commitTickerGroupLocked.
    const { trade: trade1032 } = await recordBuy(repos, { portfolioId: "p1", ticker: "ABUK", shares: 49, entryPrice: 42.4, executionDate: "2026-02-01", executionTime: "10:32AM" });
    const { trade: trade1034 } = await recordBuy(repos, { portfolioId: "p1", ticker: "ABUK", shares: 49, entryPrice: 42.4, executionDate: "2026-02-01", executionTime: "10:34AM" });

    // Smart Allocate, oldest-lot-first: a 49-share sell exactly closes the
    // 10:32 lot, then a second 49-share sell exactly closes the 10:34 lot —
    // mirroring smartAllocateSell's own FIFO-by-(date,time) selection.
    await recordSell(repos, {
      portfolioId: "p1", ticker: "ABUK",
      allocations: [{ tradeId: trade1032.id, shares: 49, exitPrice: 45 }],
      executionDate: "2026-03-01", executionTime: "09:00", source: "official-broker-excel",
    });
    await recordSell(repos, {
      portfolioId: "p1", ticker: "ABUK",
      allocations: [{ tradeId: trade1034.id, shares: 49, exitPrice: 46 }],
      executionDate: "2026-03-02", executionTime: "09:00", source: "official-broker-excel",
    });

    await commitTicker(repos, "p1", "ABUK");

    const trades = await tradesFor(repos, "ABUK");
    expect(trades).toHaveLength(2);
    const rebuilt1032 = trades.find((t) => t.executionTime === "10:32AM")!;
    const rebuilt1034 = trades.find((t) => t.executionTime === "10:34AM")!;
    // BEFORE the fix: both allocations resolved to the SAME lot (whichever
    // was indexed first) — one lot ended up double-closed (negative/zero
    // remaining beyond its own sell) and the other stayed fully open despite
    // its own sell existing, inflating the ticker's calculated remaining
    // shares exactly like the real ABUK report (27 -> 76 after Smart Allocate).
    expect(rebuilt1032.remainingShares).toBe(0); // closed by its OWN sell
    expect(rebuilt1034.remainingShares).toBe(0); // closed by its OWN sell — not left untouched

    const allocations = await allocationsFor(repos, "ABUK");
    expect(allocations).toHaveLength(2);
    expect(allocations.find((a) => a.tradeId === trade1032.id)?.sharesClosed).toBe(49);
    expect(allocations.find((a) => a.tradeId === trade1034.id)?.sharesClosed).toBe(49);
  });
});

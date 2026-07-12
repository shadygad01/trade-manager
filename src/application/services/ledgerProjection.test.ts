import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { recordBuy, recordSell, deleteTrade } from "./TradeService";
import { commitTicker, appendAndMaybeCommit, assignPortfolio, retractRawTransaction, type CommitEngineRepos } from "./commitEngine";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import { resolveLotRef } from "./ledgerProjection";
import { createTrade } from "@domain/entities/Trade";

/**
 * Phase 9.8 — legacy-ledger projection. These tests exercise the full loop
 * the phase exists for: facts reach a terminal verdict → commitTicker →
 * ensureLegacyFactsExist + projectLegacyTicker rewrite the Trade/
 * TradeAllocation rows the UI reads, with remainingShares recomputed from
 * the replayed allocations, never carried forward.
 */

function fullRepos(cash = 1_000_000) {
  const base = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: cash })] });
  return { ...base, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() };
}
type FullRepos = ReturnType<typeof fullRepos>;

async function appendVerifiedBuy(repos: FullRepos, overrides: Partial<BuyExecutionPayload> = {}) {
  const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...overrides };
  return appendAndMaybeCommit(
    repos,
    createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: "p1", ticker: payload.ticker, payload })
  );
}

describe("ledgerProjection — the legacy ledger auto-corrects when better historical facts commit", () => {
  it("HEADLINE: a missing historical Buy discovered by a later import materializes as a real Trade row, no manual entry, no reset", async () => {
    const repos = fullRepos();

    // Session 1 — incomplete history: only the sell side plus one buy is known.
    await appendVerifiedBuy(repos, { shares: 60, executionDate: "2026-01-10" });
    // Ticker not terminal yet in any interesting way — backfill facts are
    // auto-Verified, so a commit already fired; the ledger shows one lot.
    let trades = (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI");
    expect(trades).toHaveLength(1);
    expect(trades[0].shares).toBe(60);

    // Session 2 — the older, previously missing purchase document arrives.
    await appendVerifiedBuy(repos, { shares: 40, executionDate: "2025-12-01", price: 40 });

    trades = (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI");
    expect(trades).toHaveLength(2);
    expect(trades.reduce((s, t) => s + t.shares, 0)).toBe(100);
    // remainingShares recomputed from the rebuilt ledger, not carried over.
    expect(trades.every((t) => t.remainingShares === t.shares)).toBe(true);
  });

  it("HEADLINE: a duplicate Buy previously committed to the legacy ledger is auto-removed once the fact log's rebuild rejects it", async () => {
    const repos = fullRepos();
    // Two legacy trades exist from a double-import mistake; only facts for
    // them will decide. Seed the legacy rows via recordBuy (which now also
    // writes their facts), prices within sibling-duplicate tolerance.
    const { trade: real } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.8, executionDate: "2026-02-01", executionTime: "10:00",
    });
    const { trade: dup } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-02-01", executionTime: "10:00",
    });
    expect((await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI")).toHaveLength(2);

    // A broker "My Position" screenshot arrives: 100 units. The ticker is
    // now a MISMATCH (200 pending vs 100 verified) — deliberately NOT
    // terminal, because a suspected duplicate's shares keep counting until
    // the user discards it (the system never auto-deletes evidence; same
    // rule the legacy Import page has always enforced). Nothing may change
    // yet.
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({
        kind: "PositionVerificationCapture",
        source: "position-verification",
        portfolioId: "p1",
        ticker: "COMI",
        payload: { ticker: "COMI", units: 100, capturedAt: "2026-02-10T00:00" },
      })
    );
    await commitTicker(repos, "p1", "COMI");
    expect((await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI")).toHaveLength(2);

    // The user discards the duplicate READ (one evidence-level decision —
    // the same retraction ImportPage's Discard action emits since Phase
    // 9.7). The ticker becomes terminal (100 = 100, survivor Verified) and
    // the ledger fixes itself: no manual trade deletion, no reset.
    await retractRawTransaction(repos, dup.id);

    const remaining = (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(real.id); // surviving read keeps its identity
    expect(await repos.trades.getById(dup.id)).toBeUndefined();
  });

  it("manual Sell allocation survives a full rebuild as an immutable fact — remainingShares recomputed, same answer (ADR-002 preserved)", async () => {
    const repos = fullRepos();
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-05", executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 40, exitPrice: 50 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });
    const before = await repos.trades.getById(trade.id);
    expect(before?.remainingShares).toBe(60);

    // Force a full from-scratch rebuild of the ticker.
    await commitTicker(repos, "p1", "COMI");

    const after = await repos.trades.getById(trade.id);
    expect(after).toBeDefined();
    expect(after?.remainingShares).toBe(60); // recomputed from the replayed SellAllocationDecision, not carried over
    const allocations = (await repos.allocations.getByPortfolio("p1")).filter((a) => a.ticker === "COMI");
    expect(allocations).toHaveLength(1);
    expect(allocations[0].sharesClosed).toBe(40);
    expect(allocations[0].tradeId).toBe(trade.id);
  });

  it("gap-backfill: a legacy trade recorded before any fact writer existed gets a fact appended on first commit and is never deleted by projection", async () => {
    const legacyOnly = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1_000_000 })] });
    const { trade } = await recordBuy(legacyOnly, {
      portfolioId: "p1", ticker: "COMI", shares: 75, entryPrice: 30, executionDate: "2026-01-05", executionTime: "10:00", notes: "hand-entered", strategyTags: ["swing"],
    });

    // The raw log appears later (the app upgraded) — with a new, unrelated verified fact for the same ticker.
    const repos = { ...legacyOnly, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() };
    await appendVerifiedBuy(repos, { shares: 25, executionDate: "2026-02-01" });

    const trades = (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI");
    expect(trades).toHaveLength(2); // legacy row preserved via its gap-backfilled fact, new row projected
    const preserved = trades.find((t) => t.id === trade.id);
    expect(preserved).toBeDefined();
    expect(preserved?.notes).toBe("hand-entered"); // annotations survive — id-stable update, not delete-and-recreate
    expect(preserved?.strategyTags).toEqual(["swing"]);

    const facts = await repos.rawTransactions.getAll();
    const gapFact = facts.find((t) => t.kind === "BuyExecution" && t.source === "backfill" && (t.payload as BuyExecutionPayload).shares === 75);
    expect(gapFact).toBeDefined();
    expect(gapFact?.id).toBe(trade.id); // fact-to-trade correlation is exact
  });

  it("gap-backfill never resurrects an explicitly retracted execution — deleting a trade sticks across later commits", async () => {
    const repos = fullRepos();
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-05", executionTime: "10:00",
    });
    await deleteTrade(repos, trade.id);
    expect(await repos.trades.getById(trade.id)).toBeUndefined();

    // A later, unrelated verified fact commits the same ticker again.
    await appendVerifiedBuy(repos, { shares: 10, executionDate: "2026-02-01" });

    const trades = (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI");
    expect(trades).toHaveLength(1); // only the new fact's lot — the deleted trade stays deleted
    expect(trades[0].shares).toBe(10);
  });

  it("projection never runs on a non-terminal ticker: a Needs-Review fact leaves legacy rows completely untouched", async () => {
    const repos = fullRepos();
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "HRHO", shares: 50, entryPrice: 20, executionDate: "2026-01-05", executionTime: "10:00",
    });
    // recordBuy's own fact is source "manual" → a lone uncorroborated buy is
    // Needs Review → no commit ever fires → projection never touches the row.
    const commitRepos: CommitEngineRepos = repos;
    await commitTicker(commitRepos, "p1", "HRHO"); // even a forced commit must not project a non-terminal set

    const after = await repos.trades.getById(trade.id);
    expect(after).toBeDefined();
    expect(after?.remainingShares).toBe(50);
  });

  it("projection never touches portfolio.cash — a corrected ledger changes lots, not money", async () => {
    const repos = fullRepos(10_000);
    const before = (await repos.portfolios.getById("p1"))!.cash;

    await appendVerifiedBuy(repos, { shares: 40, executionDate: "2026-01-10", price: 100 });

    const after = (await repos.portfolios.getById("p1"))!.cash;
    expect(after).toBe(before); // the projected lot appeared with zero cash side effect — cash stays the user's explicitly managed figure
    expect((await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI")).toHaveLength(1);
  });

  it("re-imports converge: committing the same ticker repeatedly is idempotent — no duplicate facts, trades, or allocations", async () => {
    const repos = fullRepos();
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-05", executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 100, exitPrice: 50 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    const snapshot = async () => ({
      facts: (await repos.rawTransactions.getAll()).length,
      trades: (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI").length,
      allocations: (await repos.allocations.getByPortfolio("p1")).filter((a) => a.ticker === "COMI").length,
    });

    await commitTicker(repos, "p1", "COMI");
    const first = await snapshot();
    await commitTicker(repos, "p1", "COMI");
    await commitTicker(repos, "p1", "COMI");
    expect(await snapshot()).toEqual(first);
    expect(first.trades).toBe(1);
    expect(first.allocations).toBe(1);
  });

  it("recordSell writes the SellExecution + SellAllocationDecision facts with real-id references the Allocation Engine actually replays", async () => {
    const repos = fullRepos();
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-01-05", executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 100, exitPrice: 50 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    const facts = await repos.rawTransactions.getAll();
    const sellFact = facts.find((t) => t.kind === "SellExecution");
    const decision = facts.find((t) => t.kind === "SellAllocationDecision");
    expect(sellFact).toBeDefined();
    expect(decision).toBeDefined();
    const decisionPayload = decision!.payload as { sellExecutionId: string; allocations: { lotRef: string; shares: number }[] };
    // References the SellExecution/BuyExecution facts' own real, always-unique
    // ids — never a recomputed value hash two distinct trades could share
    // (see TradeService.ensureSellFacts/ledgerProjection.resolveLotRef).
    expect(decisionPayload.sellExecutionId).toBe(sellFact!.id);
    expect(decisionPayload.allocations).toEqual([{ lotRef: trade.id, shares: 100 }]);

    // Closed position (buy == sell) with no independent corroboration is no
    // longer auto-verified (see importVerification.ts's closed-position
    // fix) — this test is about allocation-replay plumbing, not verification
    // policy, so a corroborating fact (a broker position capture confirming
    // zero units held) is added directly to reach the same terminal,
    // committable state the test is actually exercising.
    await repos.rawTransactions.append(
      createRawTransaction({
        kind: "PositionVerificationCapture",
        source: "position-verification",
        ticker: "COMI",
        payload: { ticker: "COMI", units: 0, capturedAt: "2026-02-02T00:00" },
      })
    );

    // Proof the references resolve: the committed cache contains the replayed allocation.
    await assignPortfolio(repos, "COMI", "p1");
    await commitTicker(repos, "p1", "COMI");
    const cacheAllocations = await repos.committedLedger.getAllocations("p1", "COMI");
    expect(cacheAllocations).toHaveLength(1);
    expect(cacheAllocations[0].shares).toBe(100);
  });
});

describe("resolveLotRef — real bug found via a real user's broker Excel replayed deterministically (no concurrency involved)", () => {
  // Real, reproduced case: two genuinely distinct real Buys sharing every
  // field except execution time (ABUK, 49 shares @ E£42.40, 01 Feb 2023,
  // 10:32AM and 10:34AM — an order split into two same-price fills minutes
  // apart, a routine, legitimate real-world pattern). `ensureBuyFact`
  // ADOPTS each one's own pre-existing official-broker-excel extraction
  // fact rather than minting a fresh one (the whole point of the Excel
  // trust policy) — but adoption assigns the fact's portfolio WITHOUT ever
  // renaming the fact's id to match the freshly-generated `trade.id` (see
  // `ensureBuyFact`'s `else` branch, TradeService.ts). `resolveLotRef`'s old
  // fast path only ever checked `t.id === trade.id`, which can never match
  // for an adopted fact, so it fell straight through to the fully
  // time-blind `tradeCanonicalKey` fallback — identical for both lots.
  it("disambiguates two same-value adopted lots by execution time instead of colliding on the time-blind canonical key", () => {
    const portfolioId = "p1";
    const ticker = "ABUK";
    const sharedPayload = { ticker, shares: 49, price: 42.4, executionDate: "2023-02-01" };

    // The two extraction-time facts recordImportedRawTransactions wrote —
    // real ids, distinct only by executionTime, exactly as adopted (their
    // own id is never renamed to any Trade's id).
    const fact1032 = createRawTransaction({
      id: "fact-1032am", kind: "BuyExecution", source: "official-broker-excel", portfolioId, ticker,
      payload: { ...sharedPayload, executionTime: "10:32AM" },
    });
    const fact1034 = createRawTransaction({
      id: "fact-1034am", kind: "BuyExecution", source: "official-broker-excel", portfolioId, ticker,
      payload: { ...sharedPayload, executionTime: "10:34AM" },
    });
    const all = [{ ...fact1032, seq: 1 }, { ...fact1034, seq: 2 }];

    // Two Trades, each with their OWN freshly-generated id (recordBuy's own
    // generateId()) — deliberately NEITHER equals either fact's id, exactly
    // the shape adoption produces.
    const trade1032 = createTrade({
      id: "trade-A", portfolioId, ticker, shares: 49, entryPrice: 42.4,
      executionDate: "2023-02-01", executionTime: "10:32AM",
    });
    const trade1034 = createTrade({
      id: "trade-B", portfolioId, ticker, shares: 49, entryPrice: 42.4,
      executionDate: "2023-02-01", executionTime: "10:34AM",
    });

    const ref1032 = resolveLotRef(all, trade1032);
    const ref1034 = resolveLotRef(all, trade1034);

    // Each Trade resolves to ITS OWN real fact id — never each other's, and
    // never the shared, ambiguous time-blind canonical key string.
    expect(ref1032).toBe("fact-1032am");
    expect(ref1034).toBe("fact-1034am");
    expect(ref1032).not.toBe(ref1034);
  });

  it("still falls back to the plain canonical key when no fact exists at all (pre-migration/legacy data — unchanged behavior)", () => {
    const trade = createTrade({
      id: "trade-legacy", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 10,
      executionDate: "2026-01-01", executionTime: "10:00AM",
    });
    expect(resolveLotRef([], trade)).toBe("COMI|BUY|2026-01-01|100|10");
  });
});

import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { recordBuy } from "./TradeService";
import { assignPortfolio, type CommitEngineRepos } from "./commitEngine";
import { isTickerFullyOfficialBrokerExcelSourced } from "./reconciliation";
import { runSerialized } from "./serialize";
import type { AppRepositories } from "./types";

/**
 * Real, live-reproduced bug found via a real Chromium/real-IndexedDB run
 * against an actual broker "Your Orders" Excel export (38 Buy rows, several
 * Sell rows for one ticker): `ImportPage.tsx`'s `setTickerPortfolio` — the
 * ticker's own portfolio `<select>` dropdown handler — calls the ticker-wide
 * `assignPortfolio(repos, ticker, portfolioId)` fire-and-forget, NOT routed
 * through `serialize.ts`'s per-(portfolio, ticker) `runSerialized` queue
 * every other write path that can trigger `commitEngine.commitTicker` for a
 * ticker already joins (see the "Forensic architectural audit" ROADMAP
 * entry's own call-site inventory table — this specific call site, a
 * distinct one from `commitTickerGroupLocked`'s own already-serialized
 * trailing sweep, was never in that table).
 *
 * Picking a portfolio from Import's own per-ticker dropdown is an entirely
 * ordinary action for any multi-portfolio user (required whenever
 * `resolvedPortfolioId` can't implicitly resolve, i.e. a new ticker with
 * more than one portfolio open) — not a contrived edge case, and commonly
 * happens right around Confirm/Smart-Allocate time.
 *
 * Live-reproduced mechanism: the unserialized sweep assigns each
 * still-unassigned fact one at a time; each individual assignment can
 * reactively make the ticker's currently-assigned subset look "terminal"
 * (`shouldCommit`) and trigger its own `commitTicker` — while a concurrent,
 * PROPERLY serialized Buy-confirm loop (`commitTickerGroupLocked`, held
 * inside ONE `runSerialized` lock for its whole sequential Buy loop) is
 * still mid-flight. `projectLegacyTicker`, running on the sweep's
 * transiently-partial state, materializes a Trade straight from the raw
 * fact via a VALUE-derived key (`generateLedgerEvents`'s `eventId` for any
 * non-"manual"/"backfill" source) — not the real fact's own id — producing
 * a stray extra Trade for a fact the properly-serialized Buy-confirm loop
 * is also about to (correctly) turn into a Trade of its own, under a
 * different id. Reproduced live: a genuine Dexie `ConstraintError` from two
 * concurrent `ensureLegacyFactsExist` calls racing to backfill the same
 * value, plus a spurious `source: "backfill"` fact appearing alongside the
 * genuine `official-broker-excel` one.
 *
 * Fix (`ImportPage.tsx`'s `setTickerPortfolio`): the `assignPortfolio` call
 * now goes through the identical `runSerialized(`${portfolioId}|${ticker}`,
 * ...)` queue `commitTickerGroup`/`smartAllocateSell`/`SellAllocationForm`
 * already use — left fire-and-forget (the handler itself isn't async, it's
 * a `<select>`'s `onChange`), but joining the SAME queue is what matters:
 * any subsequent same-ticker write correctly queues behind it instead of
 * racing it.
 *
 * This test exercises the underlying primitives directly (`assignPortfolio`,
 * `recordBuy`, `runSerialized`) rather than rendering `ImportPage`, matching
 * this codebase's own established pattern for this bug family (see
 * `commitTickerGroupVsSmartAllocateRace.test.ts`) — the race is fully
 * expressed at this layer.
 */
describe("ImportPage's per-ticker portfolio dropdown (setTickerPortfolio) vs. a concurrent Buy-confirm loop, same (portfolio, ticker)", () => {
  const portfolioId = "p1";
  const ticker = "ABUK";

  function seedRepos() {
    const base = createFakeRepositories({ portfolios: [createPortfolio({ id: portfolioId, name: "SMC SCHOOL", kind: "Trading", initialCash: 10_000_000 })] });
    const repos = {
      ...base,
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    } as AppRepositories & CommitEngineRepos;
    return repos;
  }

  // 5 Buy candidates' own extraction-time facts, UNASSIGNED — exactly what
  // recordImportedRawTransactions writes at upload time, before the user has
  // picked a portfolio for the ticker from Import's own dropdown.
  const buyDefs = Array.from({ length: 5 }, (_, i) => ({
    shares: 10 + i,
    price: 40 + i * 0.5,
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    time: "10:0" + i + "AM",
  }));

  async function seedUnassignedBuyFacts(repos: AppRepositories & CommitEngineRepos) {
    for (const b of buyDefs) {
      await repos.rawTransactions.append(
        createRawTransaction({
          id: crypto.randomUUID(),
          kind: "BuyExecution",
          source: "official-broker-excel",
          confidence: "high",
          ticker,
          payload: { ticker, shares: b.shares, price: b.price, executionDate: b.date, executionTime: b.time } satisfies BuyExecutionPayload,
        }),
      );
    }
  }

  it("reproduces the real bug: an UNSERIALIZED assignPortfolio sweep racing the Buy-confirm loop corrupts the ticker's facts", async () => {
    const repos = seedRepos();
    await seedUnassignedBuyFacts(repos);
    const key = `${portfolioId}|${ticker}`;

    // The pre-fix shape: commitTickerGroupLocked's whole sequential Buy loop
    // held inside ONE runSerialized lock (matching the real function), while
    // setTickerPortfolio's sweep runs OUTSIDE any lock at all — started
    // concurrently, never awaited first, exactly like the buggy fire-and-
    // forget call site did.
    const buyConfirmLocked = runSerialized(key, async () => {
      for (const b of buyDefs) {
        await recordBuy(repos, {
          portfolioId,
          ticker,
          shares: b.shares,
          entryPrice: b.price,
          executionDate: b.date,
          executionTime: b.time,
        });
      }
    });
    const unserializedSweep = assignPortfolio(repos, ticker, portfolioId);

    await Promise.all([buyConfirmLocked, unserializedSweep]);

    const allFacts = await repos.rawTransactions.getAll();
    const liveBuys = allFacts.filter((f) => f.kind === "BuyExecution");
    const backfillOrManual = liveBuys.filter((f) => f.source !== "official-broker-excel");
    const trades = await repos.trades.getByPortfolio(portfolioId);

    // The corruption signature actually observed live: a phantom Trade
    // materialized by projectLegacyTicker straight from the raw fact's own
    // VALUE-derived canonical key (generateLedgerEvents' eventId for any
    // non-"manual"/"backfill" source) — id "TICKER|BUY|date|shares|price" —
    // instead of recordBuy's own generateId() UUID, silently REPLACING the
    // real Trade row `commitTickerGroupLocked`'s own recordBuy call would
    // otherwise have produced for that exact buy. Every genuine Trade this
    // app creates gets an opaque generated id; a canonical-key-shaped id is
    // never legitimate on a live Trade row.
    const canonicalKeyIdPattern = new RegExp(`^${ticker}\\|BUY\\|`);
    const hasPhantomValueKeyedTrade = trades.some((t) => canonicalKeyIdPattern.test(t.id));
    const dupTradeGroups = new Map<string, number>();
    for (const t of trades) {
      const k = `${t.shares}@${t.entryPrice}`;
      dupTradeGroups.set(k, (dupTradeGroups.get(k) ?? 0) + 1);
    }
    const hasDuplicateTrade = [...dupTradeGroups.values()].some((n) => n > 1);
    const isCorrupted =
      backfillOrManual.length > 0 ||
      hasDuplicateTrade ||
      hasPhantomValueKeyedTrade ||
      !isTickerFullyOfficialBrokerExcelSourced(allFacts, ticker);

    expect(isCorrupted).toBe(true);
  });

  it("fix: routing setTickerPortfolio's assignPortfolio through the SAME runSerialized queue prevents the corruption", async () => {
    const repos = seedRepos();
    await seedUnassignedBuyFacts(repos);
    const key = `${portfolioId}|${ticker}`;

    const buyConfirmLocked = runSerialized(key, async () => {
      for (const b of buyDefs) {
        await recordBuy(repos, {
          portfolioId,
          ticker,
          shares: b.shares,
          entryPrice: b.price,
          executionDate: b.date,
          executionTime: b.time,
        });
      }
    });
    // The fixed shape: the dropdown handler's sweep now joins the identical
    // queue — started concurrently (no await on buyConfirmLocked first,
    // exactly mirroring a real user picking the dropdown while Confirm is
    // still processing), but it now queues behind/interleaves safely instead
    // of racing.
    const serializedSweep = runSerialized(key, () => assignPortfolio(repos, ticker, portfolioId));

    await Promise.all([buyConfirmLocked, serializedSweep]);

    const allFacts = await repos.rawTransactions.getAll();
    const liveBuys = allFacts.filter((f) => f.kind === "BuyExecution");
    expect(liveBuys).toHaveLength(buyDefs.length);
    expect(liveBuys.every((f) => f.source === "official-broker-excel")).toBe(true);
    expect(isTickerFullyOfficialBrokerExcelSourced(allFacts, ticker)).toBe(true);

    const trades = await repos.trades.getByPortfolio(portfolioId);
    expect(trades).toHaveLength(buyDefs.length);
    const totalShares = trades.reduce((sum, t) => sum + t.shares, 0);
    expect(totalShares).toBe(buyDefs.reduce((sum, b) => sum + b.shares, 0));

    // No phantom value-keyed Trade id (see the sibling "reproduces the real
    // bug" test's own doc comment for why that id shape is the corruption
    // signature) — every Trade here is the genuine one recordBuy created.
    const canonicalKeyIdPattern = new RegExp(`^${ticker}\\|BUY\\|`);
    expect(trades.some((t) => canonicalKeyIdPattern.test(t.id))).toBe(false);
  });
});

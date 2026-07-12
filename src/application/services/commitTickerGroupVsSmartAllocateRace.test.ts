import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createRawTransaction } from "@domain/entities/RawTransaction";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { recordSell } from "./TradeService";
import { assignPortfolio, type CommitEngineRepos } from "./commitEngine";
import { isTickerFullyOfficialBrokerExcelSourced } from "./reconciliation";
import { runSerialized } from "./serialize";
import { generateId } from "@domain/value-objects/id";
import type { AppRepositories } from "./types";

/**
 * Real user report (ABUK, portfolio "SMC SCHOOL"): after Reset + re-upload
 * of the official broker Excel, confirming the Buy rows and then
 * Smart-Allocating the Sell rows (a completely ordinary "confirm buys, then
 * allocate sells" flow — not an artificially fast click pattern) still left
 * the ticker showing "Needs broker screenshot" afterward.
 *
 * Root cause: ImportPage's `commitTickerGroup` (Buy-confirm) ends with a
 * ticker-wide `assignPortfolio(repos, ticker, portfolioId)` sweep — "assign
 * every still-unassigned live fact for this ticker" — fired fire-and-forget
 * (not awaited, and NOT going through `serialize.ts`'s per-(portfolio,
 * ticker) queue that `smartAllocateSell`/`SellAllocationForm` already use).
 * That sweep also touches the Sell candidates' own extraction-time facts
 * (unassigned until their own recordSell call runs) and reactively fires
 * commitEngine's own commitTicker for the ticker — the SAME commit pathway a
 * concurrent Smart Allocate call's `recordSell` also triggers. Racing
 * `assignPortfolio`'s commit against a Smart-Allocate-triggered commit for
 * the identical (portfolio, ticker) lets one call's `projectLegacyTicker`
 * read a transiently-incomplete decision set and silently drop the other
 * call's just-written TradeAllocation as "stale" — `ensureLegacyFactsExist`'s
 * gap-backfill then re-mints a replacement SellExecution/decision pair
 * sourced "backfill" (rank 0, same tier as "manual"), permanently losing
 * that sell's official-broker-excel provenance and reproducing "Needs
 * broker screenshot" even though every real document was Excel-sourced.
 *
 * Fix (ImportPage.tsx): `commitTickerGroup` now runs its ENTIRE body
 * (including the trailing assignPortfolio sweep, now awaited instead of
 * fire-and-forget) inside the identical `runSerialized(`${portfolioId}|
 * ${ticker}`, ...)` queue `smartAllocateSell` already uses — the two can no
 * longer run concurrently for the same ticker, closing the exact gap this
 * codebase's own "Serialize Sell allocation per (portfolio, ticker)" fix
 * (PR #100) had flagged and deliberately deferred ("the same class of fix
 * could reasonably extend to Buy commits... not attempted here").
 *
 * This test exercises the underlying primitives directly (assignPortfolio,
 * recordSell, runSerialized) rather than rendering ImportPage, since the
 * race is fully expressed at this layer and a service-level reproduction is
 * deterministic to drive (no jsdom/testing-library timing to fight). Verified
 * this test fails (source ends up "backfill" on at least one Sell fact,
 * `isTickerFullyOfficialBrokerExcelSourced` false) when `assignPortfolio` is
 * called OUTSIDE the shared `runSerialized` queue — i.e. the exact shape of
 * the pre-fix `commitTickerGroup` — and passes once it's routed through the
 * same queue, matching the real fix.
 */
describe("commitTickerGroup's Buy-confirm assignPortfolio sweep vs. concurrent Smart Allocate Sells, same (portfolio, ticker)", () => {
  it("never loses Excel provenance when the Buy-confirm portfolio-assignment sweep is serialized against concurrent Sell allocations", async () => {
    const portfolioId = "p1";
    const base = createFakeRepositories({ portfolios: [createPortfolio({ id: portfolioId, name: "SMC SCHOOL", kind: "Trading", initialCash: 10_000_000 })] });
    const repos = {
      ...base,
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    } as AppRepositories & CommitEngineRepos;

    const ticker = "ABUK";
    // Buys already committed (Trade + assigned BuyExecution fact) — the
    // state commitTickerGroup's own recordBuy loop leaves behind by the time
    // its trailing assignPortfolio sweep runs.
    const buyDefs = [
      { shares: 10, price: 40, date: "2026-01-01", time: "09:00AM" },
      { shares: 10, price: 40.5, date: "2026-01-05", time: "09:10AM" },
      { shares: 10, price: 41, date: "2026-01-10", time: "09:20AM" },
    ];
    for (const b of buyDefs) {
      const tradeId = generateId();
      await repos.trades.save({
        id: tradeId,
        portfolioId,
        ticker,
        companyName: "Abu Qir Fertilizers",
        sector: undefined,
        shares: b.shares,
        entryPrice: b.price,
        fees: 0,
        taxes: 0,
        executionDate: b.date,
        executionTime: b.time,
        remainingShares: b.shares,
        strategyTags: [],
        createdAt: new Date().toISOString(),
      });
      await repos.rawTransactions.append(
        createRawTransaction({
          id: tradeId,
          kind: "BuyExecution",
          source: "official-broker-excel",
          portfolioId,
          ticker,
          confidence: "high",
          payload: { ticker, shares: b.shares, price: b.price, executionDate: b.date, executionTime: b.time },
        }),
      );
    }

    // 8 Sell candidates' own extraction-time facts, UNASSIGNED — exactly
    // what recordImportedRawTransactions writes at upload time, before
    // Import has picked a portfolio for the ticker.
    const sellDefs = Array.from({ length: 8 }, (_, i) => ({
      shares: 3,
      price: 42 + i * 0.1,
      date: `2026-02-${String(i + 1).padStart(2, "0")}`,
      time: "10:3" + i + "AM",
    }));
    for (const s of sellDefs) {
      await repos.rawTransactions.append(
        createRawTransaction({
          id: generateId(),
          kind: "SellExecution",
          source: "official-broker-excel",
          confidence: "high",
          ticker,
          payload: { ticker, shares: s.shares, price: s.price, executionDate: s.date, executionTime: s.time },
        }),
      );
    }

    const key = `${portfolioId}|${ticker}`;

    // The fixed shape: commitTickerGroup's trailing sweep goes through the
    // SAME serialize.ts queue smartAllocateSell already uses, awaited (not
    // fire-and-forget) — so it can never interleave with a concurrent
    // Smart Allocate call for this ticker.
    const assignPromise = runSerialized(key, () => assignPortfolio(repos, ticker, portfolioId));

    // Started concurrently (no await on assignPromise first) — mirrors a
    // user clicking Smart Allocate on every Sell row right after Confirm,
    // without waiting for the Buy-confirm's own trailing sweep to finish.
    const sellPromises = sellDefs.map((s, i) =>
      runSerialized(key, async () => {
        const allTrades = await repos.trades.getByPortfolio(portfolioId);
        const openLots = allTrades
          .filter((t) => t.ticker === ticker && t.remainingShares > 0)
          .sort((a, b) => a.executionDate.localeCompare(b.executionDate));
        let remaining = s.shares;
        const lines: { tradeId: string; shares: number }[] = [];
        for (const lot of openLots) {
          if (remaining <= 0) break;
          const take = Math.min(lot.remainingShares, remaining);
          if (take <= 0) continue;
          lines.push({ tradeId: lot.id, shares: take });
          remaining -= take;
        }
        if (remaining > 0) throw new Error(`not enough open shares for sell ${i}`);
        return recordSell(repos, {
          portfolioId,
          ticker,
          allocations: lines.map((l) => ({ tradeId: l.tradeId, shares: l.shares, exitPrice: s.price })),
          executionDate: s.date,
          executionTime: s.time,
          source: "official-broker-excel",
        });
      }),
    );

    await Promise.all([assignPromise, ...sellPromises]);

    const allFacts = await repos.rawTransactions.getAll();
    const liveBuySell = allFacts.filter((f) => f.kind === "BuyExecution" || f.kind === "SellExecution");
    expect(liveBuySell.every((f) => f.source === "official-broker-excel")).toBe(true);
    expect(isTickerFullyOfficialBrokerExcelSourced(allFacts, ticker)).toBe(true);

    const sellFacts = liveBuySell.filter((f) => f.kind === "SellExecution");
    expect(sellFacts).toHaveLength(8);
    const totalSold = sellFacts.reduce((sum, f) => sum + (f.payload as { shares: number }).shares, 0);
    expect(totalSold).toBe(24);
  });
});

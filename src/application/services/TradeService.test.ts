import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import {
  recordBuy,
  recordSell,
  computePositions,
  moveTrade,
  deleteTrade,
  renameTickerEverywhere,
  correctTradeExecutionDate,
  findTickersSplitAcrossPortfolios,
  consolidateTicker,
  findMisnamedTickers,
} from "./TradeService";
import { commitTicker, assignPortfolio, type CommitEngineRepos } from "./commitEngine";
import { createRawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import { isTickerFullyOfficialBrokerExcelSourced } from "./reconciliation";

/** The migration dual-write is opt-in per repos bundle — plain createFakeRepositories() output doesn't satisfy it, matching the app's real repos singleton (which always does). */
function withMigrationRepos(repos: ReturnType<typeof createFakeRepositories>): ReturnType<typeof createFakeRepositories> & CommitEngineRepos {
  return { ...repos, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() };
}

function seedPortfolio(cash: number) {
  return createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: cash });
}

describe("recordBuy", () => {
  it("creates a trade, deducts cash, and appends a Buy timeline event", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });

    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "comi.ca",
      shares: 100,
      entryPrice: 50,
      fees: 20,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    expect(trade.ticker).toBe("COMI");
    expect(trade.remainingShares).toBe(100);

    const portfolio = await repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBeCloseTo(10_000 - (100 * 50 + 20));

    const events = await repos.timeline.getByPortfolio("p1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("Buy");
    expect(events[0].relatedTradeIds).toEqual([trade.id]);
  });

  it("persists a broker-assigned transaction number onto the trade when the source document carried one", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "HRHO",
      shares: 39,
      entryPrice: 26.98,
      executionDate: "2026-06-24",
      executionTime: "10:30",
      transactionNumber: "N000248458443",
    });
    expect(trade.transactionNumber).toBe("N000248458443");
  });

  it("leaves transactionNumber undefined for a manually-entered buy", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    expect(trade.transactionNumber).toBeUndefined();
  });

  it("auto-assigns sector from the known-ticker lookup when none is given", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    expect(trade.sector).toBe("Banking");
  });

  it("leaves sector undefined for a ticker outside the known-sector map", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "ZZZZ",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    expect(trade.sector).toBeUndefined();
  });

  it("honors an explicit sector override instead of the known-ticker default", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      sector: "Custom Sector",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    expect(trade.sector).toBe("Custom Sector");
  });

  it("allows a buy that exceeds portfolio cash, letting cash go negative", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100)] });

    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    expect(trade.shares).toBe(100);
    const portfolio = await repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBeCloseTo(100 - 100 * 50);
  });

  it("throws for an unknown portfolio", async () => {
    const repos = createFakeRepositories();
    await expect(
      recordBuy(repos, {
        portfolioId: "missing",
        ticker: "COMI",
        shares: 1,
        entryPrice: 1,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      })
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a buy dated before the 2026-01-01 tracking start", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await expect(
      recordBuy(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        shares: 10,
        entryPrice: 50,
        executionDate: "2025-12-31",
        executionTime: "10:30",
      })
    ).rejects.toThrow(/2026-01-01/);
  });
});

describe("deleteTrade", () => {
  it("removes an unallocated trade, refunds its cost, and removes its Buy event", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      fees: 5,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await deleteTrade(repos, trade.id);

    expect(await repos.trades.getById(trade.id)).toBeUndefined();
    const portfolio = await repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBeCloseTo(10_000);
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events.some((e) => e.type === "Buy" && e.relatedTradeIds?.includes(trade.id))).toBe(false);
  });

  it("refuses to delete a trade that has shares closed against it", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 4, exitPrice: 55 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    await expect(deleteTrade(repos, trade.id)).rejects.toThrow(/shares closed against it/i);
    expect(await repos.trades.getById(trade.id)).toBeDefined();
  });

  it("rejects an unknown trade id", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await expect(deleteTrade(repos, "nope")).rejects.toThrow(/not found/i);
  });

  describe("migration dual-write", () => {
    it("retracts EVERY live matching RawTransaction so a re-commit can't resurrect the deleted trade — including the fact recordBuy itself now writes (Phase 9.8)", async () => {
      const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(10_000)] }));
      const { trade } = await recordBuy(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        shares: 10,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      });
      // A second, duplicate fact for the same execution (as an earlier
      // backfill would have written) — deleteTrade must retract BOTH, or the
      // survivor would re-project the deleted trade on the next commit.
      const payload: BuyExecutionPayload = { ticker: "COMI", shares: 10, price: 50, executionDate: "2026-01-05", executionTime: "10:30" };
      const raw = await repos.rawTransactions.append(
        createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: "p1", ticker: "COMI", payload }),
      );
      await commitTicker(repos, "p1", "COMI");
      expect(await repos.committedLedger.getLedgerEvents("p1", "COMI")).toHaveLength(1);

      await deleteTrade(repos, trade.id);

      const retractions = (await repos.rawTransactions.getAll()).filter((t) => t.kind === "Retraction");
      expect(retractions).toHaveLength(2);
      expect(new Set(retractions.map((r) => (r.payload as { targetId: string }).targetId))).toEqual(new Set([trade.id, raw.id]));
      // The retraction's own commit trigger already cleared the cache.
      expect(await repos.committedLedger.getLedgerEvents("p1", "COMI")).toEqual([]);
      // And the legacy projection converged to the same answer: the trade stays deleted.
      expect(await repos.trades.getById(trade.id)).toBeUndefined();
      expect((await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === "COMI")).toEqual([]);
    });

    it("is a harmless no-op when no matching RawTransaction exists (a trade recorded before any fact writer existed)", async () => {
      // The trade is created against a repos bundle WITHOUT the raw log (so
      // recordBuy's own Phase 9.8 fact writer stays dormant), then deleted
      // against one WITH it — the exact shape of a trade recorded before the
      // dual-write shipped.
      const legacyOnly = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
      const { trade } = await recordBuy(legacyOnly, {
        portfolioId: "p1",
        ticker: "COMI",
        shares: 10,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      });

      const repos = withMigrationRepos(legacyOnly);
      await expect(deleteTrade(repos, trade.id)).resolves.toBeUndefined();
      expect((await repos.rawTransactions.getAll())).toHaveLength(0);
    });

    it("plain AppRepositories (no rawTransactions/committedLedger) still deletes the trade normally", async () => {
      const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
      const { trade } = await recordBuy(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        shares: 10,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      });

      await deleteTrade(repos, trade.id);
      expect(await repos.trades.getById(trade.id)).toBeUndefined();
    });
  });
});

describe("correctTradeExecutionDate", () => {
  it("moves the trade's date and its Buy timeline event together, touching nothing else", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-01",
      executionTime: "10:30",
    });

    await correctTradeExecutionDate(repos, trade.id, "2026-02-10");

    const updated = await repos.trades.getById(trade.id);
    expect(updated?.executionDate).toBe("2026-02-10");
    expect(updated?.shares).toBe(100);
    expect(updated?.entryPrice).toBe(50);

    const events = await repos.timeline.getByPortfolio("p1");
    const buyEvent = events.find((e) => e.type === "Buy" && e.relatedTradeIds?.includes(trade.id));
    expect(buyEvent?.timestamp).toBe("2026-02-10T10:30");
  });

  it("rejects a date before the tracking floor or in the future", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    });

    await expect(correctTradeExecutionDate(repos, trade.id, "2025-12-31")).rejects.toThrow(/not tracked/);
    await expect(correctTradeExecutionDate(repos, trade.id, "2100-01-01")).rejects.toThrow(/future/);
  });

  it("refuses a buy date after a sell that already closed shares from the lot", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 40, exitPrice: 60 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    await expect(correctTradeExecutionDate(repos, trade.id, "2026-03-01")).rejects.toThrow(/can't be after/);
    await correctTradeExecutionDate(repos, trade.id, "2026-01-20");
    expect((await repos.trades.getById(trade.id))?.executionDate).toBe("2026-01-20");
  });
});

describe("renameTickerEverywhere", () => {
  it("renames Trade.ticker/companyName/sector and its Buy TimelineEvent", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "ZZZZ",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    expect(trade.sector).toBeUndefined();

    const result = await renameTickerEverywhere(repos, "ZZZZ", "COMI");
    expect(result.tradesUpdated).toBe(1);

    const updated = await repos.trades.getById(trade.id);
    expect(updated?.ticker).toBe("COMI");
    expect(updated?.sector).toBe("Banking");
    expect(updated?.companyName).toBe("COMMERCIAL INTERNATIONAL BANK");

    const events = await repos.timeline.getByPortfolio("p1");
    const buyEvent = events.find((e) => e.type === "Buy" && e.relatedTradeIds?.includes(trade.id));
    expect(buyEvent?.ticker).toBe("COMI");
  });

  it("renames TradeAllocation.ticker for a closed lot", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "ZZZZ",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "ZZZZ",
      allocations: [{ tradeId: trade.id, shares: 4, exitPrice: 55 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    const result = await renameTickerEverywhere(repos, "ZZZZ", "COMI");
    expect(result.allocationsUpdated).toBe(1);

    const allocations = await repos.allocations.getByPortfolio("p1");
    expect(allocations[0].ticker).toBe("COMI");
  });

  it("renames a PositionVerification's ticker", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await repos.verifications.save({
      id: "v1",
      portfolioId: "p1",
      ticker: "ZZZZ",
      units: 10,
      capturedAt: "2026-01-01T00:00",
      source: "screenshot",
    });

    const result = await renameTickerEverywhere(repos, "ZZZZ", "COMI");
    expect(result.verificationsUpdated).toBe(1);

    const [verification] = await repos.verifications.getByPortfolio("p1");
    expect(verification.ticker).toBe("COMI");
  });

  it("clears a trade's sector rather than leaving it stale when the new ticker doesn't resolve", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    expect(trade.sector).toBe("Banking");

    await renameTickerEverywhere(repos, "COMI", "ZZZZ");
    const updated = await repos.trades.getById(trade.id);
    expect(updated?.sector).toBeUndefined();
  });

  it("is a no-op when the new ticker is the same as the old one", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const result = await renameTickerEverywhere(repos, "COMI", "comi");
    expect(result).toEqual({ tradesUpdated: 0, allocationsUpdated: 0, timelineEventsUpdated: 0, verificationsUpdated: 0 });
  });

  describe("migration dual-write", () => {
    it("corrects the matching RawTransaction's ticker too, so it doesn't stay orphaned under the old, now-corrected-away ticker", async () => {
      const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(10_000)] }));
      await recordBuy(repos, {
        portfolioId: "p1",
        ticker: "ZZZZ",
        shares: 10,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      });
      // Mirrors what an earlier import/backfill would already have written
      // (source csv, per commitEngine.test.ts's own convention for an
      // unassigned raw transaction).
      const payload: BuyExecutionPayload = { ticker: "ZZZZ", shares: 10, price: 50, executionDate: "2026-01-05", executionTime: "10:30" };
      await repos.rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source: "csv", ticker: "ZZZZ", payload }));

      await renameTickerEverywhere(repos, "ZZZZ", "COMI");

      const all = await repos.rawTransactions.getAll();
      // Two live ZZZZ facts exist by the time the rename runs — the one
      // recordBuy itself now writes (Phase 9.8) plus the csv mirror above —
      // and the rename must correct BOTH, or one would stay orphaned.
      expect(all.filter((t) => t.kind === "Correction")).toHaveLength(2);
      expect(all.filter((t) => t.kind === "BuyExecution")[0].ticker).toBe("ZZZZ"); // immutable — the original field never changes

      // The old ticker no longer resolves this row at all — only the new one does.
      await assignPortfolio(repos, "ZZZZ", "p1");
      expect((await repos.rawTransactions.getAll()).filter((t) => t.kind === "PortfolioAssignment")).toHaveLength(0);
      await assignPortfolio(repos, "COMI", "p1");
      expect((await repos.rawTransactions.getAll()).filter((t) => t.kind === "PortfolioAssignment")).toHaveLength(1);
    });

    it("plain AppRepositories (no rawTransactions/committedLedger) still renames normally", async () => {
      const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
      await recordBuy(repos, {
        portfolioId: "p1",
        ticker: "ZZZZ",
        shares: 10,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      });

      const result = await renameTickerEverywhere(repos, "ZZZZ", "COMI");
      expect(result.tradesUpdated).toBe(1);
    });
  });
});

describe("recordSell", () => {
  it("fully closes a single trade and emits a Sell event with realized P/L", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      fees: 20,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    const { realizedPnl, allocations } = await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 100, exitPrice: 60, fees: 10 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    expect(allocations).toHaveLength(1);
    expect(realizedPnl.toNumber()).toBeCloseTo(60 * 100 - 10 - (50 * 100 + 20));

    const updatedTrade = await repos.trades.getById(trade.id);
    expect(updatedTrade?.remainingShares).toBe(0);

    const events = await repos.timeline.getByPortfolio("p1");
    const sellEvent = events.find((e) => e.type === "Sell" || e.type === "PartialSell");
    expect(sellEvent?.type).toBe("Sell");

    const portfolio = await repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBeCloseTo(10_000 - (100 * 50 + 20) + (100 * 60 - 10));
  });

  it("persists a broker-assigned transaction number onto every allocation row from one sell order", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const buy1 = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 30,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    const buy2 = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 15,
      entryPrice: 48,
      executionDate: "2026-01-06",
      executionTime: "10:30",
    });

    const { allocations } = await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [
        { tradeId: buy1.trade.id, shares: 30, exitPrice: 60 },
        { tradeId: buy2.trade.id, shares: 15, exitPrice: 60 },
      ],
      executionDate: "2026-02-01",
      executionTime: "11:00",
      transactionNumber: "N000000000099",
    });

    expect(allocations.every((a) => a.transactionNumber === "N000000000099")).toBe(true);
  });

  // CLHO regression: verifying and allocating a sell recorded from the
  // official broker Excel export used to always write its SellExecution
  // RawTransaction fact with source "manual", hardcoded — regardless of the
  // real originating document — which silently broke
  // isTickerFullyOfficialBrokerExcelSourced's "every live fact for this
  // ticker is Excel-sourced" check the moment ANY sell was allocated,
  // reintroducing "Closed — needs corroborating evidence" for a ticker that
  // should never need it. Root-caused to ensureSellFacts (TradeService.ts)
  // rather than any UI code.
  it("stamps the SellExecution fact with the caller's real source instead of hardcoding 'manual'", async () => {
    const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(10_000)] }));
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "CLHO",
      shares: 3000,
      entryPrice: 0.38,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    });

    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "CLHO",
      allocations: [{ tradeId: trade.id, shares: 3000, exitPrice: 0.5 }],
      executionDate: "2026-01-10",
      executionTime: "10:00",
      source: "official-broker-excel",
    });

    const facts = await repos.rawTransactions.getAll();
    const sellFact = facts.find((f) => f.kind === "SellExecution");
    expect(sellFact?.source).toBe("official-broker-excel");
  });

  it("still defaults the SellExecution fact's source to 'manual' when the caller provides none — a genuinely user-typed sell", async () => {
    const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(10_000)] }));
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 100, exitPrice: 60 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    const facts = await repos.rawTransactions.getAll();
    const sellFact = facts.find((f) => f.kind === "SellExecution");
    expect(sellFact?.source).toBe("manual");
  });

  // The actual architectural fix, exercised end-to-end exactly like a real
  // Import → Verify → Allocate lifecycle: a SellExecution fact already
  // exists (written at extraction time, before the user ever opens the
  // allocation modal — see recordImportedRawTransactions), correctly
  // sourced. recordSell is called with NO explicit `source` at all (the
  // shape PortfolioDetailPage's PendingExecution-confirmed sells use, and
  // any future caller that never learns about the `source` field) — the
  // fix must still work by ADOPTING the pre-existing fact, not by relying
  // on every caller remembering to thread a source through.
  it("adopts an already-existing SellExecution fact (written at extraction time) instead of minting a duplicate 'manual' one — works even when the caller passes no source at all", async () => {
    const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(10_000)] }));

    // Simulates recordImportedRawTransactions' extraction-time write: the
    // Buy candidate is already a live fact before recordBuy ever runs, so
    // ensureBuyFact's own live-match check adopts it instead of writing its
    // own "manual" one — this is what lets the ticker's Buy side start out
    // fully Excel-sourced.
    await repos.rawTransactions.append(
      createRawTransaction({
        id: "extracted-buy-1",
        kind: "BuyExecution",
        source: "official-broker-excel",
        portfolioId: "p1",
        ticker: "CLHO",
        payload: { ticker: "CLHO", shares: 3000, price: 0.38, executionDate: "2026-01-05", executionTime: "10:00" },
      }),
    );
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "CLHO",
      shares: 3000,
      entryPrice: 0.38,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    });

    // Simulates recordImportedRawTransactions' extraction-time write: the
    // Sell candidate is already a live fact before any allocation happens,
    // correctly sourced.
    await repos.rawTransactions.append(
      createRawTransaction({
        id: "extracted-sell-1",
        kind: "SellExecution",
        source: "official-broker-excel",
        portfolioId: "p1",
        ticker: "CLHO",
        payload: { ticker: "CLHO", shares: 3000, price: 0.5, executionDate: "2026-01-10", executionTime: "10:00" },
      }),
    );

    // No `source` passed here at all — proving the fix doesn't depend on it.
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "CLHO",
      allocations: [{ tradeId: trade.id, shares: 3000, exitPrice: 0.5 }],
      executionDate: "2026-01-10",
      executionTime: "10:00",
    });

    const facts = await repos.rawTransactions.getAll();
    const sellFacts = facts.filter((f) => f.kind === "SellExecution");
    // Exactly one SellExecution fact for this sell — the pre-existing one,
    // adopted, never duplicated.
    expect(sellFacts).toHaveLength(1);
    expect(sellFacts[0].id).toBe("extracted-sell-1");
    expect(sellFacts[0].source).toBe("official-broker-excel");

    const decision = facts.find((f) => f.kind === "SellAllocationDecision");
    expect((decision?.payload as { sellExecutionId: string }).sellExecutionId).toBe("extracted-sell-1");

    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "CLHO")).toBe(true);
  });

  it("adopts an already-existing BuyExecution fact even when it was extracted under a ticker later renamed via a Correction fact", async () => {
    const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(10_000)] }));

    // Extraction-time write under an OCR-misread ticker name.
    await repos.rawTransactions.append(
      createRawTransaction({
        id: "extracted-buy-1",
        kind: "BuyExecution",
        source: "official-broker-excel",
        portfolioId: "p1",
        ticker: "CLHOA",
        payload: { ticker: "CLHOA", shares: 3000, price: 0.38, executionDate: "2026-01-05", executionTime: "10:00" },
      }),
    );
    // A Correction fixes the ticker name (e.g. via renameTickerEverywhere)
    // BEFORE the user ever confirms the buy — the fact's own `.ticker` field
    // stays "CLHOA" forever; only a live Correction records the rename.
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId: "extracted-buy-1", patch: { ticker: "CLHO" } } }),
    );

    // recordBuy is called under the CORRECTED name — ensureBuyFact must
    // still recognize "extracted-buy-1" as the live match and adopt it,
    // not read its immutable, stale `.ticker` field directly and miss it.
    await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "CLHO",
      shares: 3000,
      entryPrice: 0.38,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    });

    const facts = await repos.rawTransactions.getAll();
    const buyFacts = facts.filter((f) => f.kind === "BuyExecution");
    expect(buyFacts).toHaveLength(1);
    expect(buyFacts[0].id).toBe("extracted-buy-1");
    expect(buyFacts[0].source).toBe("official-broker-excel");

    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "CLHO")).toBe(true);
  });

  it("never merges two genuinely different sells that coincidentally share the same ticker/date/shares/price — each still gets its own fact", async () => {
    const repos = withMigrationRepos(createFakeRepositories({ portfolios: [seedPortfolio(100_000)] }));
    const buy1 = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    });
    const buy2 = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 48,
      executionDate: "2026-01-06",
      executionTime: "10:00",
    });

    const commonSell = {
      portfolioId: "p1",
      ticker: "COMI",
      executionDate: "2026-02-01",
      executionTime: "11:00",
      source: "official-broker-excel" as const,
    };
    await recordSell(repos, { ...commonSell, allocations: [{ tradeId: buy1.trade.id, shares: 100, exitPrice: 60 }] });
    await recordSell(repos, { ...commonSell, allocations: [{ tradeId: buy2.trade.id, shares: 100, exitPrice: 60 }] });

    const facts = await repos.rawTransactions.getAll();
    const sellFacts = facts.filter((f) => f.kind === "SellExecution");
    expect(sellFacts).toHaveLength(2);
    const decisions = facts.filter((f) => f.kind === "SellAllocationDecision");
    const claimedIds = new Set(decisions.map((d) => (d.payload as { sellExecutionId: string }).sellExecutionId));
    // Each decision claims a DIFFERENT SellExecution fact — neither sell's
    // allocation was orphaned by the other.
    expect(claimedIds.size).toBe(2);
  });

  it("emits PartialSell when a trade is only partially closed", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 40, exitPrice: 60 }],
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    const updatedTrade = await repos.trades.getById(trade.id);
    expect(updatedTrade?.remainingShares).toBe(60);

    const events = await repos.timeline.getByPortfolio("p1");
    const sellEvent = events.find((e) => e.type === "Sell" || e.type === "PartialSell");
    expect(sellEvent?.type).toBe("PartialSell");
  });

  it("emits PartialSell when a sell spans multiple trades under one sellGroupId, even if all close fully", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(20_000)] });
    const first = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 40,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });
    const second = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 42,
      executionDate: "2026-01-02",
      executionTime: "10:00",
    });

    const { allocations } = await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [
        { tradeId: first.trade.id, shares: 50, exitPrice: 50 },
        { tradeId: second.trade.id, shares: 50, exitPrice: 50 },
      ],
      executionDate: "2026-03-01",
      executionTime: "12:00",
    });

    expect(new Set(allocations.map((a) => a.sellGroupId)).size).toBe(1);
    const events = await repos.timeline.getByPortfolio("p1");
    const sellEvent = events.find((e) => e.type === "Sell" || e.type === "PartialSell");
    expect(sellEvent?.type).toBe("PartialSell");
    expect(sellEvent?.relatedTradeIds).toEqual([first.trade.id, second.trade.id]);
  });

  it("throws rather than silently capping when requested shares exceed remaining shares", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await expect(
      recordSell(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        allocations: [{ tradeId: trade.id, shares: 999, exitPrice: 60 }],
        executionDate: "2026-02-01",
        executionTime: "11:00",
      })
    ).rejects.toThrow(/only 10 remain/i);
  });

  it("throws when the ticker does not match the trade", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await expect(
      recordSell(repos, {
        portfolioId: "p1",
        ticker: "HRHO",
        allocations: [{ tradeId: trade.id, shares: 1, exitPrice: 60 }],
        executionDate: "2026-02-01",
        executionTime: "11:00",
      })
    ).rejects.toThrow(/ticker mismatch/i);
  });

  it("rejects a sell dated before the 2026-01-01 tracking start", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await expect(
      recordSell(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        allocations: [{ tradeId: trade.id, shares: 10, exitPrice: 60 }],
        executionDate: "2025-06-01",
        executionTime: "11:00",
      })
    ).rejects.toThrow(/2026-01-01/);
  });
});

describe("computePositions", () => {
  it("aggregates open trades per ticker and leaves market fields undefined without a price", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100_000)] });
    await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      fees: 10,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });
    await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 55,
      executionDate: "2026-01-10",
      executionTime: "10:00",
    });

    const positions = await computePositions(repos, "p1", {});
    expect(positions).toHaveLength(1);
    const [comi] = positions;
    expect(comi.totalShares).toBe(150);
    expect(comi.costBasis).toBeCloseTo(100 * 50 + 10 + 50 * 55);
    expect(comi.currentPrice).toBeUndefined();
    expect(comi.marketValue).toBeUndefined();
    expect(comi.unrealizedPnl).toBeUndefined();
  });

  it("computes unrealized P/L when a price is available and excludes fully closed trades", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 100, exitPrice: 60 }],
      executionDate: "2026-02-01",
      executionTime: "10:00",
    });

    const positions = await computePositions(repos, "p1", { COMI: 65 });
    expect(positions).toHaveLength(0);
  });

  it("only aggregates the still-open remainder after a partial sell", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 40, exitPrice: 60 }],
      executionDate: "2026-02-01",
      executionTime: "10:00",
    });

    const positions = await computePositions(repos, "p1", { COMI: 65 });
    expect(positions).toHaveLength(1);
    expect(positions[0].totalShares).toBe(60);
    expect(positions[0].marketValue).toBeCloseTo(60 * 65);
    expect(positions[0].unrealizedPnl).toBeCloseTo(60 * 65 - 60 * 50);
  });

  it("includes taxes in cost basis, not just fees", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100_000)] });
    await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      fees: 20,
      taxes: 30,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });

    const positions = await computePositions(repos, "p1", {});
    expect(positions[0].costBasis).toBeCloseTo(100 * 50 + 20 + 30);
  });
});

describe("moveTrade", () => {
  it("moves an unsold buy's portfolioId and refunds/charges the cost between portfolios", async () => {
    const repos = createFakeRepositories({
      portfolios: [seedPortfolio(10_000), createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 1_000 })],
    });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 5,
      fees: 10,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    const result = await moveTrade(repos, trade.id, "p2");
    expect(result.movedTradeIds).toEqual([trade.id]);

    const movedTrade = await repos.trades.getById(trade.id);
    expect(movedTrade?.portfolioId).toBe("p2");

    const p1 = await repos.portfolios.getById("p1");
    const p2 = await repos.portfolios.getById("p2");
    expect(p1?.cash).toBeCloseTo(10_000 - (100 * 5 + 10) + (100 * 5 + 10));
    expect(p2?.cash).toBeCloseTo(1_000 - (100 * 5 + 10));

    const p1Events = await repos.timeline.getByPortfolio("p1");
    const p2Events = await repos.timeline.getByPortfolio("p2");
    expect(p1Events).toHaveLength(0);
    expect(p2Events).toHaveLength(1);
    expect(p2Events[0].type).toBe("Buy");
  });

  it("moves every lot in a shared multi-trade sellGroup together, not just the requested one", async () => {
    const repos = createFakeRepositories({
      portfolios: [seedPortfolio(20_000), createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 20_000 })],
    });
    const first = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 40,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });
    const second = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 42,
      executionDate: "2026-01-02",
      executionTime: "10:00",
    });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [
        { tradeId: first.trade.id, shares: 50, exitPrice: 50 },
        { tradeId: second.trade.id, shares: 50, exitPrice: 50 },
      ],
      executionDate: "2026-03-01",
      executionTime: "12:00",
    });

    const result = await moveTrade(repos, first.trade.id, "p2");
    expect(new Set(result.movedTradeIds)).toEqual(new Set([first.trade.id, second.trade.id]));

    expect((await repos.trades.getById(first.trade.id))?.portfolioId).toBe("p2");
    expect((await repos.trades.getById(second.trade.id))?.portfolioId).toBe("p2");

    const p1Allocations = await repos.allocations.getByPortfolio("p1");
    const p2Allocations = await repos.allocations.getByPortfolio("p2");
    expect(p1Allocations).toHaveLength(0);
    expect(p2Allocations).toHaveLength(2);

    const p1Events = await repos.timeline.getByPortfolio("p1");
    const p2Events = await repos.timeline.getByPortfolio("p2");
    expect(p1Events).toHaveLength(0);
    expect(p2Events).toHaveLength(3); // 2 buys + 1 sell
  });

  it("allows the move even when the target portfolio can't cover the net cost, letting cash go negative", async () => {
    const repos = createFakeRepositories({
      portfolios: [seedPortfolio(10_000), createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 10 })],
    });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    await moveTrade(repos, trade.id, "p2");

    const target = await repos.portfolios.getById("p2");
    expect(target?.cash).toBeCloseTo(10 - 100 * 50);
  });

  it("is a no-op when the target is the same as the current portfolio", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      shares: 10,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    const result = await moveTrade(repos, trade.id, "p1");
    expect(result.movedTradeIds).toEqual([trade.id]);
    expect((await repos.portfolios.getById("p1"))?.cash).toBeCloseTo(10_000 - 500);
  });

  it("throws for an unknown trade", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await expect(moveTrade(repos, "missing", "p1")).rejects.toThrow(/not found/i);
  });
});

describe("findTickersSplitAcrossPortfolios", () => {
  it("flags a ticker held (nonzero remaining shares) in more than one portfolio", async () => {
    const repos = createFakeRepositories({
      portfolios: [seedPortfolio(10_000), createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 10_000 })],
    });
    await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, entryPrice: 40, executionDate: "2026-01-05", executionTime: "10:00" });
    await recordBuy(repos, { portfolioId: "p2", ticker: "COMI", shares: 30, entryPrice: 42, executionDate: "2026-01-06", executionTime: "10:00" });
    await recordBuy(repos, { portfolioId: "p1", ticker: "HRHO", shares: 20, entryPrice: 15, executionDate: "2026-01-05", executionTime: "10:00" });

    const trades = await repos.trades.getAll();
    const splits = findTickersSplitAcrossPortfolios(trades);

    expect(splits).toHaveLength(1);
    expect(splits[0].ticker).toBe("COMI");
    expect(new Map(splits[0].portfolios.map((p) => [p.portfolioId, p.shares]))).toEqual(
      new Map([
        ["p1", 50],
        ["p2", 30],
      ])
    );
  });

  it("does not flag a ticker that's fully closed in one of the two portfolios", async () => {
    const repos = createFakeRepositories({
      portfolios: [seedPortfolio(10_000), createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 10_000 })],
    });
    const { trade } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, entryPrice: 40, executionDate: "2026-01-05", executionTime: "10:00" });
    await recordSell(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      allocations: [{ tradeId: trade.id, shares: 50, exitPrice: 45 }],
      executionDate: "2026-02-01",
      executionTime: "10:00",
    });
    await recordBuy(repos, { portfolioId: "p2", ticker: "COMI", shares: 30, entryPrice: 42, executionDate: "2026-01-06", executionTime: "10:00" });

    const trades = await repos.trades.getAll();
    expect(findTickersSplitAcrossPortfolios(trades)).toHaveLength(0);
  });
});

describe("findMisnamedTickers", () => {
  it("flags a ticker string that's really a known company's raw name (the MASR/Medinet Masr Housing case)", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "MEDINET MASR HOUSING",
      shares: 72,
      entryPrice: 4.21,
      executionDate: "2026-01-06",
      executionTime: "10:00",
    });
    await recordBuy(repos, { portfolioId: "p1", ticker: "HRHO", shares: 20, entryPrice: 15, executionDate: "2026-01-05", executionTime: "10:00" });

    const trades = await repos.trades.getAll();
    const misnamed = findMisnamedTickers(trades);

    expect(misnamed).toHaveLength(1);
    expect(misnamed[0]).toEqual({ wrongTicker: "MEDINET MASR HOUSING", realTicker: "MASR", shares: 72 });
  });

  it("does not flag a ticker that's already its real symbol", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await recordBuy(repos, { portfolioId: "p1", ticker: "MASR", shares: 72, entryPrice: 4.21, executionDate: "2026-01-06", executionTime: "10:00" });
    await recordBuy(repos, { portfolioId: "p1", ticker: "HRHO", shares: 20, entryPrice: 15, executionDate: "2026-01-05", executionTime: "10:00" });

    const trades = await repos.trades.getAll();
    expect(findMisnamedTickers(trades)).toHaveLength(0);
  });

  it("does not flag an unrecognized ticker with no known real symbol to rename to", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await recordBuy(repos, { portfolioId: "p1", ticker: "SOME UNKNOWN COMPANY", shares: 10, entryPrice: 5, executionDate: "2026-01-05", executionTime: "10:00" });

    const trades = await repos.trades.getAll();
    expect(findMisnamedTickers(trades)).toHaveLength(0);
  });
});

describe("consolidateTicker", () => {
  it("moves every trade and verification for a ticker into the target portfolio", async () => {
    const repos = createFakeRepositories({
      portfolios: [seedPortfolio(10_000), createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 10_000 })],
    });
    const first = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, entryPrice: 40, executionDate: "2026-01-05", executionTime: "10:00" });
    const second = await recordBuy(repos, { portfolioId: "p2", ticker: "COMI", shares: 30, entryPrice: 42, executionDate: "2026-01-06", executionTime: "10:00" });
    await repos.verifications.save({ id: "v1", portfolioId: "p2", ticker: "COMI", units: 80, capturedAt: "2026-06-01T00:00", source: "screenshot" });

    const result = await consolidateTicker(repos, "COMI", "p1");

    expect(new Set(result.movedTradeIds)).toEqual(new Set([second.trade.id]));
    expect(result.movedVerificationIds).toEqual(["v1"]);

    const allTrades = await repos.trades.getAll();
    expect(allTrades.every((t) => t.portfolioId === "p1")).toBe(true);
    expect((await repos.trades.getById(first.trade.id))?.portfolioId).toBe("p1");
    expect((await repos.trades.getById(second.trade.id))?.portfolioId).toBe("p1");

    const verifications = await repos.verifications.getAll();
    expect(verifications[0].portfolioId).toBe("p1");
  });

  it("is a no-op for trades/verifications already in the target portfolio", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, entryPrice: 40, executionDate: "2026-01-05", executionTime: "10:00" });

    const result = await consolidateTicker(repos, "COMI", "p1");
    expect(result.movedTradeIds).toEqual([]);
    expect(result.movedVerificationIds).toEqual([]);
  });
});

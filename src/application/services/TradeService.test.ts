import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import { recordBuy, recordSell, computePositions, moveTrade } from "./TradeService";
import { InsufficientCashError } from "./errors";

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

  it("rejects a buy when portfolio cash is insufficient", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100)] });

    await expect(
      recordBuy(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        shares: 100,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      })
    ).rejects.toThrow(/insufficient cash/i);
  });

  it("rejects with a structured InsufficientCashError carrying the exact shortfall", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(100)] });

    try {
      await recordBuy(repos, {
        portfolioId: "p1",
        ticker: "COMI",
        shares: 10,
        entryPrice: 50,
        executionDate: "2026-01-05",
        executionTime: "10:30",
      });
      expect.unreachable("recordBuy should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientCashError);
      const err = e as InsufficientCashError;
      expect(err.portfolioId).toBe("p1");
      expect(err.required).toBeCloseTo(500);
      expect(err.available).toBeCloseTo(100);
    }
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

  it("rejects the move when the target portfolio can't cover the net cost", async () => {
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

    await expect(moveTrade(repos, trade.id, "p2")).rejects.toThrow(/insufficient cash/i);
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

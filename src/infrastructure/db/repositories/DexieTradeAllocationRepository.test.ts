import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieTradeAllocationRepository } from "./DexieTradeAllocationRepository";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";

describe("DexieTradeAllocationRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieTradeAllocationRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieTradeAllocationRepository(db);
  });

  it("saves an allocation and retrieves it by trade", async () => {
    const allocation = createTradeAllocation({
      id: "alloc-1",
      sellGroupId: "sell-1",
      portfolioId: "portfolio-1",
      tradeId: "trade-1",
      ticker: "COMI",
      sharesClosed: 30,
      exitPrice: 55,
      executionDate: "2026-02-01",
      executionTime: "12:00",
    });

    await repo.save(allocation);

    const byTrade = await repo.getByTrade("trade-1");
    expect(byTrade).toEqual([allocation]);
  });

  it("lists allocations scoped to a portfolio, spanning multiple trades sharing a sellGroupId", async () => {
    const shared = {
      sellGroupId: "sell-group-1",
      portfolioId: "portfolio-1",
      ticker: "COMI",
      exitPrice: 55,
      executionDate: "2026-02-01",
      executionTime: "12:00",
    } as const;

    await repo.save(
      createTradeAllocation({ id: "alloc-1", tradeId: "trade-1", sharesClosed: 20, ...shared })
    );
    await repo.save(
      createTradeAllocation({ id: "alloc-2", tradeId: "trade-2", sharesClosed: 10, ...shared })
    );
    await repo.save(
      createTradeAllocation({
        id: "alloc-3",
        sellGroupId: "sell-group-2",
        portfolioId: "portfolio-2",
        tradeId: "trade-3",
        ticker: "HRHO",
        sharesClosed: 5,
        exitPrice: 20,
        executionDate: "2026-02-02",
        executionTime: "09:30",
      })
    );

    const portfolio1Allocations = await repo.getByPortfolio("portfolio-1");
    expect(portfolio1Allocations).toHaveLength(2);
    expect(portfolio1Allocations.every((a) => a.sellGroupId === "sell-group-1")).toBe(true);
  });

  it("lists every allocation across all portfolios via getAll", async () => {
    await repo.save(
      createTradeAllocation({
        id: "alloc-1",
        sellGroupId: "sell-1",
        portfolioId: "portfolio-1",
        tradeId: "trade-1",
        ticker: "COMI",
        sharesClosed: 20,
        exitPrice: 55,
        executionDate: "2026-02-01",
        executionTime: "12:00",
      })
    );
    await repo.save(
      createTradeAllocation({
        id: "alloc-2",
        sellGroupId: "sell-2",
        portfolioId: "portfolio-2",
        tradeId: "trade-2",
        ticker: "HRHO",
        sharesClosed: 5,
        exitPrice: 20,
        executionDate: "2026-02-02",
        executionTime: "09:30",
      })
    );

    const all = await repo.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.id).sort()).toEqual(["alloc-1", "alloc-2"]);
  });

  it("deletes an allocation", async () => {
    const allocation = createTradeAllocation({
      id: "alloc-1",
      sellGroupId: "sell-1",
      portfolioId: "portfolio-1",
      tradeId: "trade-1",
      ticker: "COMI",
      sharesClosed: 30,
      exitPrice: 55,
      executionDate: "2026-02-01",
      executionTime: "12:00",
    });
    await repo.save(allocation);

    await repo.delete("alloc-1");

    expect(await repo.getByTrade("trade-1")).toEqual([]);
  });
});

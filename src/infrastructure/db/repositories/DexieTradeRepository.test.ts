import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieTradeRepository } from "./DexieTradeRepository";
import { createTrade } from "@domain/entities/Trade";

describe("DexieTradeRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieTradeRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieTradeRepository(db);
  });

  it("saves and retrieves a trade by id", async () => {
    const trade = createTrade({
      id: "trade-1",
      portfolioId: "portfolio-1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-01",
      executionTime: "10:00",
    });

    await repo.save(trade);
    const fetched = await repo.getById("trade-1");

    expect(fetched).toEqual(trade);
  });

  it("returns undefined for a missing trade", async () => {
    expect(await repo.getById("missing")).toBeUndefined();
  });

  it("lists trades scoped to a portfolio", async () => {
    await repo.save(
      createTrade({
        id: "trade-1",
        portfolioId: "portfolio-1",
        ticker: "COMI",
        shares: 100,
        entryPrice: 50,
        executionDate: "2026-01-01",
        executionTime: "10:00",
      })
    );
    await repo.save(
      createTrade({
        id: "trade-2",
        portfolioId: "portfolio-2",
        ticker: "HRHO",
        shares: 10,
        entryPrice: 20,
        executionDate: "2026-01-02",
        executionTime: "11:00",
      })
    );

    const portfolio1Trades = await repo.getByPortfolio("portfolio-1");
    expect(portfolio1Trades).toHaveLength(1);
    expect(portfolio1Trades[0].id).toBe("trade-1");

    const allTrades = await repo.getAll();
    expect(allTrades).toHaveLength(2);
  });

  it("updates only remainingShares via saveRemainingShares, leaving other fields untouched", async () => {
    const trade = createTrade({
      id: "trade-1",
      portfolioId: "portfolio-1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-01",
      executionTime: "10:00",
      notes: "original notes",
    });
    await repo.save(trade);

    await repo.saveRemainingShares("trade-1", 40);

    const updated = await repo.getById("trade-1");
    expect(updated?.remainingShares).toBe(40);
    expect(updated?.notes).toBe("original notes");
    expect(updated?.shares).toBe(100);
  });

  it("deletes a trade", async () => {
    await repo.save(
      createTrade({
        id: "trade-1",
        portfolioId: "portfolio-1",
        ticker: "COMI",
        shares: 100,
        entryPrice: 50,
        executionDate: "2026-01-01",
        executionTime: "10:00",
      })
    );

    await repo.delete("trade-1");

    expect(await repo.getById("trade-1")).toBeUndefined();
  });
});

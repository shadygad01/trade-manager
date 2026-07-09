import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieRawTransactionRepository } from "./DexieRawTransactionRepository";
import { createRawTransaction } from "@domain/entities/RawTransaction";
import type { BuyExecutionPayload } from "@domain/entities/RawTransaction";

function buyPayload(overrides: Partial<BuyExecutionPayload> = {}): BuyExecutionPayload {
  return {
    ticker: "COMI",
    shares: 100,
    price: 45.5,
    executionDate: "2026-02-01",
    ...overrides,
  };
}

describe("DexieRawTransactionRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieRawTransactionRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieRawTransactionRepository(db);
  });

  it("assigns sequential seq numbers starting at 1, in append order", async () => {
    const first = await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload: buyPayload() })
    );
    const second = await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "HRHO", payload: buyPayload({ ticker: "HRHO" }) })
    );

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it("getById returns the appended transaction with its assigned seq", async () => {
    const appended = await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload: buyPayload() })
    );

    const found = await repo.getById(appended.id);
    expect(found).toEqual(appended);
  });

  it("getByPortfolio only returns transactions assigned to that portfolio, excluding unassigned ones", async () => {
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: "p1", ticker: "COMI", payload: buyPayload() })
    );
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "HRHO", payload: buyPayload({ ticker: "HRHO" }) })
    );

    const forPortfolio = await repo.getByPortfolio("p1");
    expect(forPortfolio).toHaveLength(1);
    expect(forPortfolio[0].ticker).toBe("COMI");
  });

  it("getByTicker filters across portfolios", async () => {
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: "p1", ticker: "COMI", payload: buyPayload() })
    );
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: "p2", ticker: "COMI", payload: buyPayload() })
    );
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "HRHO", payload: buyPayload({ ticker: "HRHO" }) })
    );

    const comi = await repo.getByTicker("COMI");
    expect(comi).toHaveLength(2);
  });

  it("getAll returns every transaction regardless of portfolio assignment", async () => {
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload: buyPayload() })
    );
    await repo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "HRHO", payload: buyPayload({ ticker: "HRHO" }) })
    );

    expect(await repo.getAll()).toHaveLength(2);
  });

  it("every appended row is written with status unverified and no seq supplied by the caller", async () => {
    const built = createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload: buyPayload() });
    expect("seq" in built).toBe(false);

    const appended = await repo.append(built);
    expect(appended.status).toBe("unverified");
    expect(typeof appended.seq).toBe("number");
  });

  it("has no update or delete method — immutability is enforced by the interface shape, not convention", () => {
    expect((repo as unknown as { update?: unknown }).update).toBeUndefined();
    expect((repo as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  it("upgrades an existing v1 database without losing any existing data, and the new table is immediately usable", async () => {
    const dbName = `test-upgrade-${crypto.randomUUID()}`;

    // Simulate a real user's browser database, created before this migration existed.
    const v1 = new Dexie(dbName);
    v1.version(1).stores({
      portfolios: "&id, kind, archivedAt",
      trades: "&id, portfolioId, ticker, [portfolioId+ticker], executionDate",
      tradeAllocations: "&id, portfolioId, tradeId, ticker, sellGroupId, [portfolioId+ticker]",
      timelineEvents: "&id, portfolioId, type, ticker, timestamp",
      journalEntries: "&id, tradeId, portfolioId",
      verifications: "&id, portfolioId, ticker, [portfolioId+ticker], capturedAt",
      uploads: "&id, portfolioId, fileHash, [portfolioId+fileHash], status",
    });
    await v1.open();
    await v1.table("portfolios").add({
      id: "p1",
      name: "Existing Portfolio",
      kind: "Investment",
      currency: "EGP",
      cash: 1000,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await v1.table("trades").add({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 40,
      fees: 0,
      taxes: 0,
      executionDate: "2026-01-15",
      executionTime: "10:00",
      remainingShares: 50,
      strategyTags: [],
      createdAt: "2026-01-15T10:00:00.000Z",
    });
    v1.close();

    // Open the same underlying database through the real (v1 -> v2) schema.
    const upgraded = new PortfolioOsDatabase(dbName);
    await upgraded.open();

    const portfolios = await upgraded.portfolios.toArray();
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0].id).toBe("p1");

    const trades = await upgraded.trades.toArray();
    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe("t1");

    const upgradedRepo = new DexieRawTransactionRepository(upgraded);
    const created = await upgradedRepo.append(
      createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: "p1", ticker: "COMI", payload: buyPayload() })
    );
    expect(created.seq).toBe(1);
    expect(await upgradedRepo.getAll()).toHaveLength(1);

    upgraded.close();
  });
});

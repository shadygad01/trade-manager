import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "./db";
import { purgeTickerData, purgeAllData, allTables } from "./purge";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createTrade } from "@domain/entities/Trade";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { createRawTransaction } from "@domain/entities/RawTransaction";
import { createPendingExecution } from "@domain/entities/PendingExecution";

function buyCandidate(ticker: string) {
  return { ticker, side: "BUY" as const, shares: 100, price: 50, date: "2026-01-05" };
}

async function seed(db: PortfolioOsDatabase) {
  await db.portfolios.put(createPortfolio({ id: "p1", name: "Main", kind: "Investment", initialCash: 10_000 }));
  await db.trades.put(
    createTrade({ id: "t-comi", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 50, executionDate: "2026-01-05", executionTime: "10:00" }),
  );
  await db.trades.put(
    createTrade({ id: "t-swdy", portfolioId: "p1", ticker: "SWDY", shares: 40, entryPrice: 30, executionDate: "2026-01-06", executionTime: "10:00" }),
  );
  await db.timelineEvents.put(
    createTimelineEvent({ id: "e-comi", portfolioId: "p1", type: "Buy", timestamp: "2026-01-05T10:00:00Z", ticker: "COMI", amount: -5000 }),
  );
  await db.timelineEvents.put(
    createTimelineEvent({ id: "e-swdy", portfolioId: "p1", type: "Buy", timestamp: "2026-01-06T10:00:00Z", ticker: "SWDY", amount: -1200 }),
  );
  await db.verifications.put({ id: "v-comi", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-01-07", source: "screenshot" });
  await db.uploads.put({
    id: "u-comi",
    fileName: "comi.png",
    fileHash: "hash-comi",
    contentType: "image/png",
    status: "parsed",
    candidates: [buyCandidate("COMI")],
    createdAt: "2026-01-05T10:00:00Z",
  });
  await db.uploads.put({
    id: "u-swdy",
    fileName: "swdy.png",
    fileHash: "hash-swdy",
    contentType: "image/png",
    status: "parsed",
    candidates: [buyCandidate("SWDY")],
    createdAt: "2026-01-06T10:00:00Z",
  });
  await db.rawTransactions.put({
    ...createRawTransaction({
      id: "r-comi",
      kind: "BuyExecution",
      source: "statement",
      ticker: "COMI",
      payload: { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-01-05" },
    }),
    seq: 1,
  });
  await db.rawTransactions.put({
    ...createRawTransaction({ id: "r-retract", kind: "Retraction", source: "manual", payload: { targetId: "r-comi" } }),
    seq: 2,
  });
  await db.rawTransactions.put({
    ...createRawTransaction({
      id: "r-swdy",
      kind: "BuyExecution",
      source: "statement",
      ticker: "SWDY",
      payload: { ticker: "SWDY", shares: 40, price: 30, executionDate: "2026-01-06" },
    }),
    seq: 3,
  });
  await db.ledgerCache.put({ id: "p1|comi-ev", portfolioId: "p1", ticker: "COMI", event: {} as never });
  await db.ledgerCache.put({ id: "p1|swdy-ev", portfolioId: "p1", ticker: "SWDY", event: {} as never });
  await db.pendingExecutions.put(
    createPendingExecution({ id: "pe-comi", portfolioId: "p1", ticker: "COMI", side: "BUY", originalShares: 31, originalPrice: 50, executionDate: "2026-01-05", brokerStatus: "Partially filled" }),
  );
  await db.pendingExecutions.put(
    createPendingExecution({ id: "pe-swdy", portfolioId: "p1", ticker: "SWDY", side: "BUY", originalShares: 40, originalPrice: 30, executionDate: "2026-01-06", brokerStatus: "Partially filled" }),
  );
}

describe("purgeTickerData", () => {
  let db: PortfolioOsDatabase;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    await seed(db);
  });

  it("removes every record of the ticker and nothing of any other ticker", async () => {
    await purgeTickerData("COMI", db);

    expect(await db.trades.get("t-comi")).toBeUndefined();
    expect(await db.timelineEvents.get("e-comi")).toBeUndefined();
    expect(await db.verifications.get("v-comi")).toBeUndefined();
    expect(await db.uploads.get("u-comi")).toBeUndefined();
    expect(await db.rawTransactions.get("r-comi")).toBeUndefined();
    expect(await db.ledgerCache.get("p1|comi-ev")).toBeUndefined();
    expect(await db.pendingExecutions.get("pe-comi")).toBeUndefined();

    expect(await db.trades.get("t-swdy")).toBeDefined();
    expect(await db.timelineEvents.get("e-swdy")).toBeDefined();
    expect(await db.uploads.get("u-swdy")).toBeDefined();
    expect(await db.rawTransactions.get("r-swdy")).toBeDefined();
    expect(await db.ledgerCache.get("p1|swdy-ev")).toBeDefined();
    expect(await db.pendingExecutions.get("pe-swdy")).toBeDefined();
  });

  it("purges retraction rows that pointed at the ticker's raw transactions", async () => {
    await purgeTickerData("COMI", db);
    expect(await db.rawTransactions.get("r-retract")).toBeUndefined();
  });

  it("reverses the ticker's net cash impact on the portfolio", async () => {
    await purgeTickerData("COMI", db);
    const portfolio = await db.portfolios.get("p1");
    expect(portfolio?.cash).toBe(15_000);
  });

  it("keeps portfolios whose only activity was other tickers untouched otherwise", async () => {
    await purgeTickerData("SWDY", db);
    const portfolio = await db.portfolios.get("p1");
    expect(portfolio?.cash).toBe(11_200);
    expect(await db.trades.get("t-comi")).toBeDefined();
  });
});

describe("purgeAllData", () => {
  it("empties every table, portfolios included", async () => {
    const db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    await seed(db);

    await purgeAllData(db);

    expect(await db.portfolios.count()).toBe(0);
    expect(await db.trades.count()).toBe(0);
    expect(await db.timelineEvents.count()).toBe(0);
    expect(await db.verifications.count()).toBe(0);
    expect(await db.uploads.count()).toBe(0);
    expect(await db.rawTransactions.count()).toBe(0);
    expect(await db.ledgerCache.count()).toBe(0);
    expect(await db.allocationsCache.count()).toBe(0);
    expect(await db.pendingExecutions.count()).toBe(0);
  });
});

/**
 * A new Dexie table can be added to db.ts's schema without being added to
 * purge.ts's own `allTables` enumeration — already happened once for real
 * (`pendingExecutions`, see docs/ROADMAP.md's "Reset All Data audit" entry),
 * leaving orphaned rows behind after a "Reset" that looked complete. This
 * test reads the live schema (Dexie's own `db.tables`, populated from
 * whichever `.stores()` call registered the latest version) and fails the
 * moment the two lists diverge in either direction, instead of waiting for
 * a user to notice leftover data after the next new table ships.
 */
describe("purge.ts's table list vs. the live Dexie schema", () => {
  it("purges every table the schema actually defines — no more, no less", async () => {
    const db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    await db.open();

    const schemaTableNames = new Set(db.tables.map((t) => t.name));
    const purgedTableNames = new Set(allTables(db).map((t) => t.name));

    expect(purgedTableNames).toEqual(schemaTableNames);
  });
});

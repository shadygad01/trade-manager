import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import { recordBuy, recordSell } from "@application/services/TradeService";
import { recordCashAdjustment, recordDividend } from "@application/services/PortfolioService";
import { createJournalEntry } from "@domain/entities/JournalEntry";
import { generateId } from "@domain/value-objects/id";
import {
  exportLedger,
  importLedger,
  parseLedgerSnapshot,
  LEDGER_SNAPSHOT_VERSION,
  UnsupportedSnapshotVersionError,
  InvalidSnapshotError,
} from "./BackupService";

async function seedFullLedger() {
  const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 10_000 })] });
  await recordCashAdjustment(repos, "p1", 500, "top-up");
  const { trade } = await recordBuy(repos, {
    portfolioId: "p1",
    ticker: "COMI",
    shares: 100,
    entryPrice: 10,
    executionDate: "2026-01-01",
    executionTime: "10:00",
  });
  await recordSell(repos, {
    portfolioId: "p1",
    ticker: "COMI",
    allocations: [{ tradeId: trade.id, shares: 40, exitPrice: 15 }],
    executionDate: "2026-02-01",
    executionTime: "10:00",
  });
  await recordDividend(repos, "p1", { ticker: "COMI", amount: 25 });
  await repos.journal.save(createJournalEntry({ id: generateId(), tradeId: trade.id, portfolioId: "p1", entryReason: "breakout" }));
  await repos.verifications.save({ id: generateId(), portfolioId: "p1", ticker: "COMI", units: 60, capturedAt: new Date().toISOString(), source: "manual" });
  return repos;
}

describe("exportLedger", () => {
  it("captures every portfolio, trade, allocation, timeline event, journal entry and verification", async () => {
    const repos = await seedFullLedger();
    const snapshot = await exportLedger(repos);

    expect(snapshot.schemaVersion).toBe(LEDGER_SNAPSHOT_VERSION);
    expect(snapshot.portfolios).toHaveLength(1);
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.allocations).toHaveLength(1);
    expect(snapshot.timelineEvents.length).toBeGreaterThanOrEqual(4); // cash adjustment, buy, sell, dividend
    expect(snapshot.journalEntries).toHaveLength(1);
    expect(snapshot.verifications).toHaveLength(1);
  });
});

describe("importLedger", () => {
  it("round-trips: export then import into a fresh set of repos reproduces the same ledger", async () => {
    const source = await seedFullLedger();
    const snapshot = await exportLedger(source);

    const target = createFakeRepositories();
    await importLedger(target, snapshot);

    expect(await target.portfolios.getAll()).toEqual(snapshot.portfolios);
    expect(await target.trades.getAll()).toEqual(snapshot.trades);
    expect(await target.allocations.getAll()).toEqual(snapshot.allocations);
    expect(await target.timeline.getAll()).toEqual(snapshot.timelineEvents);
    expect(await target.journal.getAll()).toEqual(snapshot.journalEntries);
    expect(await target.verifications.getAll()).toEqual(snapshot.verifications);
  });

  it("fully replaces existing data rather than merging with it", async () => {
    const target = createFakeRepositories({ portfolios: [createPortfolio({ id: "stale", name: "Old", kind: "Trading", initialCash: 1 })] });
    const source = await seedFullLedger();
    const snapshot = await exportLedger(source);

    await importLedger(target, snapshot);

    const portfolios = await target.portfolios.getAll();
    expect(portfolios.map((p) => p.id)).toEqual(["p1"]);
  });

  it("rejects a snapshot from a newer, unsupported schema version", async () => {
    const target = createFakeRepositories();
    const snapshot = await exportLedger(await seedFullLedger());
    await expect(importLedger(target, { ...snapshot, schemaVersion: LEDGER_SNAPSHOT_VERSION + 1 })).rejects.toThrow(
      UnsupportedSnapshotVersionError
    );
  });
});

describe("parseLedgerSnapshot", () => {
  it("parses a valid exported snapshot back from its JSON string", async () => {
    const snapshot = await exportLedger(await seedFullLedger());
    const parsed = parseLedgerSnapshot(JSON.stringify(snapshot));
    expect(parsed).toEqual(snapshot);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseLedgerSnapshot("not json")).toThrow(InvalidSnapshotError);
  });

  it("rejects a well-formed JSON object that isn't a ledger snapshot", () => {
    expect(() => parseLedgerSnapshot(JSON.stringify({ hello: "world" }))).toThrow(InvalidSnapshotError);
  });

  it("rejects a snapshot from a newer schema version", async () => {
    const snapshot = await exportLedger(await seedFullLedger());
    const future = { ...snapshot, schemaVersion: LEDGER_SNAPSHOT_VERSION + 1 };
    expect(() => parseLedgerSnapshot(JSON.stringify(future))).toThrow(UnsupportedSnapshotVersionError);
  });
});

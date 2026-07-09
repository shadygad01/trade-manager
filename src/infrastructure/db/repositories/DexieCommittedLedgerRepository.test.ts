import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieCommittedLedgerRepository } from "./DexieCommittedLedgerRepository";
import type { LedgerEvent } from "@domain/entities/LedgerEvent";
import type { Allocation } from "@domain/entities/Allocation";

function lotEvent(overrides: Partial<Extract<LedgerEvent, { type: "LotOpened" }>> = {}): LedgerEvent {
  return {
    type: "LotOpened",
    eventId: "lot-1",
    executionDate: "2026-01-01",
    ticker: "COMI",
    shares: 100,
    price: 40,
    sourceTransactionIds: ["raw-1"],
    ...overrides,
  };
}

function allocation(overrides: Partial<Allocation> = {}): Allocation {
  return {
    id: "alloc-1",
    sellEventId: "sell-1",
    lotEventId: "lot-1",
    shares: 40,
    price: 50,
    fees: 0,
    taxes: 0,
    executionDate: "2026-02-01",
    ...overrides,
  };
}

describe("DexieCommittedLedgerRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieCommittedLedgerRepository;

  beforeEach(() => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieCommittedLedgerRepository(db);
  });

  it("commitTicker writes events and allocations, both readable back for the same (portfolioId, ticker)", async () => {
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [lotEvent()], allocations: [allocation()] });

    expect(await repo.getLedgerEvents("p1", "COMI")).toEqual([lotEvent()]);
    expect(await repo.getAllocations("p1", "COMI")).toEqual([allocation()]);
  });

  it("a second commitTicker call fully replaces the first — no leftover rows from the prior commit", async () => {
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [lotEvent({ eventId: "old-lot" })], allocations: [] });
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [lotEvent({ eventId: "new-lot" })], allocations: [] });

    const events = await repo.getLedgerEvents("p1", "COMI");
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("new-lot");
  });

  it("committing to an empty set clears a ticker's cache entirely (a fully-rejected batch resolves to nothing)", async () => {
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [lotEvent()], allocations: [allocation()] });
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [], allocations: [] });

    expect(await repo.getLedgerEvents("p1", "COMI")).toEqual([]);
    expect(await repo.getAllocations("p1", "COMI")).toEqual([]);
  });

  it("commits to two different tickers in the same portfolio without cross-contamination", async () => {
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [lotEvent({ ticker: "COMI" })], allocations: [] });
    await repo.commitTicker({ portfolioId: "p1", ticker: "HRHO", events: [lotEvent({ eventId: "lot-2", ticker: "HRHO" })], allocations: [] });

    expect(await repo.getLedgerEvents("p1", "COMI")).toHaveLength(1);
    expect(await repo.getLedgerEvents("p1", "HRHO")).toHaveLength(1);
  });

  it("commits to the same ticker in two different portfolios without cross-contamination, even with colliding eventIds", async () => {
    // Two different portfolios can coincidentally hold economically
    // identical trades — same eventId, genuinely different real positions.
    await repo.commitTicker({ portfolioId: "p1", ticker: "COMI", events: [lotEvent({ eventId: "same-id" })], allocations: [] });
    await repo.commitTicker({ portfolioId: "p2", ticker: "COMI", events: [lotEvent({ eventId: "same-id", shares: 999 })], allocations: [] });

    const p1Events = await repo.getLedgerEvents("p1", "COMI");
    const p2Events = await repo.getLedgerEvents("p2", "COMI");
    expect(p1Events[0].shares).toBe(100);
    expect(p2Events[0].shares).toBe(999);
  });

  it("getLedgerEvents/getAllocations return empty arrays for a ticker that was never committed", async () => {
    expect(await repo.getLedgerEvents("p1", "NOPE")).toEqual([]);
    expect(await repo.getAllocations("p1", "NOPE")).toEqual([]);
  });
});

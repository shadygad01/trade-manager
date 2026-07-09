import { describe, expect, it } from "vitest";
import { computeHoldings } from "./holdingsEngine";
import type { LedgerEvent, LotOpenedEvent, SellRecordedEvent } from "./ledgerEngine";
import type { Allocation } from "./allocationEngine";

function lot(overrides: Partial<LotOpenedEvent> = {}): LotOpenedEvent {
  return {
    type: "LotOpened",
    eventId: "lot-1",
    executionDate: "2026-01-01",
    ticker: "COMI",
    shares: 100,
    price: 40,
    fees: 0,
    taxes: 0,
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

describe("holdingsEngine.computeHoldings", () => {
  it("a lot with nothing sold against it is fully open", () => {
    const holdings = computeHoldings([lot({ shares: 100 })], [], {});
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ ticker: "COMI", totalShares: 100, costBasis: 4000, avgCost: 40 });
    expect(holdings[0].openLots[0].remainingShares).toBe(100);
  });

  it("subtracts allocated shares from the lot's remaining balance", () => {
    const holdings = computeHoldings([lot({ shares: 100 })], [allocation({ shares: 40 })], {});
    expect(holdings[0].totalShares).toBe(60);
    expect(holdings[0].openLots[0].remainingShares).toBe(60);
  });

  it("a fully closed lot (allocations consume every share) disappears from holdings entirely", () => {
    const holdings = computeHoldings([lot({ shares: 100 })], [allocation({ shares: 100 })], {});
    expect(holdings).toEqual([]);
  });

  it("pro-rates cost basis by remaining/original shares, including fees/taxes, exactly like TradeService.computePositions", () => {
    const holdings = computeHoldings([lot({ shares: 100, price: 40, fees: 10, taxes: 5 })], [allocation({ shares: 25 })], {});
    // Full cost basis = 100*40 + 10 + 5 = 4015; remaining 75/100 of it = 3011.25
    expect(holdings[0].totalShares).toBe(75);
    expect(holdings[0].costBasis).toBeCloseTo(3011.25);
    expect(holdings[0].avgCost).toBeCloseTo(3011.25 / 75);
  });

  it("computes market value and unrealized P/L when a price is available, and omits them when it isn't", () => {
    const withPrice = computeHoldings([lot({ shares: 100, price: 40 })], [], { COMI: 55 });
    expect(withPrice[0].marketValue).toBe(5500);
    expect(withPrice[0].unrealizedPnl).toBeCloseTo(1500);
    expect(withPrice[0].unrealizedPnlPct).toBeCloseTo(37.5);

    const withoutPrice = computeHoldings([lot({ shares: 100, price: 40 })], [], {});
    expect(withoutPrice[0].marketValue).toBeUndefined();
    expect(withoutPrice[0].unrealizedPnl).toBeUndefined();
    expect(withoutPrice[0].unrealizedPnlPct).toBeUndefined();
  });

  it("aggregates multiple open lots of the same ticker into one holding", () => {
    const events: LedgerEvent[] = [lot({ eventId: "lot-a", shares: 50, price: 40 }), lot({ eventId: "lot-b", shares: 50, price: 44 })];
    const holdings = computeHoldings(events, [], {});
    expect(holdings).toHaveLength(1);
    expect(holdings[0].totalShares).toBe(100);
    expect(holdings[0].openLots).toHaveLength(2);
  });

  it("keeps different tickers as separate holdings", () => {
    const events: LedgerEvent[] = [lot({ eventId: "lot-a", ticker: "COMI" }), lot({ eventId: "lot-b", ticker: "HRHO" })];
    const holdings = computeHoldings(events, [], {});
    expect(holdings.map((h) => h.ticker).sort()).toEqual(["COMI", "HRHO"]);
  });

  it("ignores SellRecorded events — only LotOpened events become holdings", () => {
    const sellOnly: SellRecordedEvent = { type: "SellRecorded", eventId: "sell-1", executionDate: "2026-02-01", ticker: "COMI", shares: 100, price: 50, sourceTransactionIds: [] };
    expect(computeHoldings([sellOnly], [], {})).toEqual([]);
  });

  it("no lots produces no holdings", () => {
    expect(computeHoldings([], [], {})).toEqual([]);
  });
});

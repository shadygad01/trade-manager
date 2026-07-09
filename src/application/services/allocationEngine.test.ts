import { describe, expect, it } from "vitest";
import { generateAllocations } from "./allocationEngine";
import { createRawTransaction, type RawTransaction, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import type { LedgerEvent, LotOpenedEvent, SellRecordedEvent } from "./ledgerEngine";

function lot(overrides: Partial<LotOpenedEvent> = {}): LotOpenedEvent {
  return {
    type: "LotOpened",
    eventId: "lot-1",
    executionDate: "2026-01-01",
    ticker: "COMI",
    shares: 100,
    price: 40,
    fees: 10,
    taxes: 0,
    sourceTransactionIds: ["raw-buy-1"],
    ...overrides,
  };
}

function sellEvent(overrides: Partial<SellRecordedEvent> = {}): SellRecordedEvent {
  return {
    type: "SellRecorded",
    eventId: "sell-1",
    executionDate: "2026-02-01",
    ticker: "COMI",
    shares: 100,
    price: 50,
    fees: 20,
    taxes: 0,
    sourceTransactionIds: ["raw-sell-1"],
    ...overrides,
  };
}

function decision(payload: SellAllocationDecisionPayload, id?: string): RawTransaction {
  return {
    ...createRawTransaction({ id, kind: "SellAllocationDecision", source: "manual", payload }),
    seq: 1,
  };
}

describe("allocationEngine.generateAllocations", () => {
  it("allocates a sell fully closing one lot", () => {
    const events: LedgerEvent[] = [lot(), sellEvent()];
    const d = decision({ sellExecutionId: "sell-1", allocations: [{ lotRef: "lot-1", shares: 100 }] });

    const allocations = generateAllocations(events, [d]);
    expect(allocations).toEqual([
      { id: "sell-1|lot-1", sellEventId: "sell-1", lotEventId: "lot-1", shares: 100, price: 50, fees: 20, taxes: 0, executionDate: "2026-02-01", executionTime: undefined, transactionNumber: undefined },
    ]);
  });

  it("splits one sell across two lots exactly as the user decided — no FIFO inference", () => {
    const events: LedgerEvent[] = [
      lot({ eventId: "lot-a", shares: 30 }),
      lot({ eventId: "lot-b", shares: 70 }),
      sellEvent({ shares: 100 }),
    ];
    const d = decision({
      sellExecutionId: "sell-1",
      allocations: [
        { lotRef: "lot-b", shares: 70 }, // deliberately closes the SECOND lot's shares first, proving no lot-order inference
        { lotRef: "lot-a", shares: 30 },
      ],
    });

    const allocations = generateAllocations(events, [d]);
    expect(allocations.map((a) => ({ lot: a.lotEventId, shares: a.shares }))).toEqual([
      { lot: "lot-b", shares: 70 },
      { lot: "lot-a", shares: 30 },
    ]);
  });

  it("prorates the sell order's fees/taxes across a split allocation by share count", () => {
    const events: LedgerEvent[] = [
      lot({ eventId: "lot-a", shares: 25 }),
      lot({ eventId: "lot-b", shares: 75 }),
      sellEvent({ shares: 100, fees: 40, taxes: 20 }),
    ];
    const d = decision({
      sellExecutionId: "sell-1",
      allocations: [
        { lotRef: "lot-a", shares: 25 },
        { lotRef: "lot-b", shares: 75 },
      ],
    });

    const allocations = generateAllocations(events, [d]);
    const a = allocations.find((x) => x.lotEventId === "lot-a")!;
    const b = allocations.find((x) => x.lotEventId === "lot-b")!;
    expect(a.fees).toBeCloseTo(10); // 25% of 40
    expect(a.taxes).toBeCloseTo(5); // 25% of 20
    expect(b.fees).toBeCloseTo(30); // 75% of 40
    expect(b.taxes).toBeCloseTo(15); // 75% of 20
  });

  it("excludes a decision whose referenced sell no longer exists (retracted/never verified) instead of crashing", () => {
    const events: LedgerEvent[] = [lot()];
    const d = decision({ sellExecutionId: "sell-does-not-exist", allocations: [{ lotRef: "lot-1", shares: 100 }] });

    expect(generateAllocations(events, [d])).toEqual([]);
  });

  it("excludes an allocation line whose lot no longer exists, without dropping the decision's other lines", () => {
    const events: LedgerEvent[] = [lot({ eventId: "lot-a", shares: 100 }), sellEvent({ shares: 100 })];
    const d = decision({
      sellExecutionId: "sell-1",
      allocations: [
        { lotRef: "lot-missing", shares: 20 },
        { lotRef: "lot-a", shares: 80 },
      ],
    });

    const allocations = generateAllocations(events, [d]);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].lotEventId).toBe("lot-a");
  });

  it("excludes an allocation that would overshoot the lot's remaining balance", () => {
    const events: LedgerEvent[] = [lot({ eventId: "lot-a", shares: 50 }), sellEvent({ shares: 100 })];
    const d = decision({ sellExecutionId: "sell-1", allocations: [{ lotRef: "lot-a", shares: 80 }] });

    expect(generateAllocations(events, [d])).toEqual([]);
  });

  it("replays decisions chronologically by the sell's real execution date, not by which decision was recorded first", () => {
    const events: LedgerEvent[] = [
      lot({ eventId: "lot-a", shares: 60 }),
      sellEvent({ eventId: "sell-early", executionDate: "2026-01-15", shares: 60 }),
      sellEvent({ eventId: "sell-late", executionDate: "2026-03-01", shares: 60 }),
    ];
    // The LATE sell's decision is recorded first (lower seq) but must still
    // replay AFTER the early sell chronologically, or it would wrongly claim
    // the lot's full balance before the earlier sell gets a chance to.
    const lateDecision = decision({ sellExecutionId: "sell-late", allocations: [{ lotRef: "lot-a", shares: 60 }] }, "d-late");
    const earlyDecision = decision({ sellExecutionId: "sell-early", allocations: [{ lotRef: "lot-a", shares: 60 }] }, "d-early");

    const allocations = generateAllocations(events, [lateDecision, earlyDecision]);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].sellEventId).toBe("sell-early");
  });

  it("no decisions produces no allocations", () => {
    expect(generateAllocations([lot(), sellEvent()], [])).toEqual([]);
  });
});

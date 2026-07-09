import { describe, expect, it } from "vitest";
import { generateLedgerEvents } from "./ledgerEngine";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload } from "@domain/entities/RawTransaction";

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", ticker: payload.ticker, payload }), seq: 1 };
}

function sell(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "manual", ticker: payload.ticker, payload }), seq: 2 };
}

describe("ledgerEngine.generateLedgerEvents", () => {
  it("one buy transaction produces one LotOpened event", () => {
    const events = generateLedgerEvents([buy({ id: "b1" })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "LotOpened", ticker: "COMI", shares: 100, price: 45.5 });
    expect(events[0].sourceTransactionIds).toEqual(["b1"]);
  });

  it("collapses two corroborating raw transactions (same execution, different document types) into one LotOpened event", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement", price: 45.5 });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice", price: 45.6 });
    const events = generateLedgerEvents([statementRead, invoiceRead]);

    expect(events).toHaveLength(1);
    expect(events[0].sourceTransactionIds.sort()).toEqual(["invoice-1", "stmt-1"]);
  });

  it("produces both a LotOpened and a SellRecorded event for a buy+sell pair", () => {
    const events = generateLedgerEvents([buy({ id: "b1" }), sell({ id: "s1" })]);
    expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);
  });

  it("orders events oldest -> newest by real execution date, not by which was appended first", () => {
    const late = buy({ id: "late", executionDate: "2026-03-01" });
    const early = buy({ id: "early", executionDate: "2026-01-01", shares: 50 });
    // appended in "late, early" order — the output must still be chronological
    const events = generateLedgerEvents([late, early]);

    expect(events.map((e) => e.sourceTransactionIds[0])).toEqual(["early", "late"]);
  });

  it("deterministic eventId: the same execution always canonicalizes to the same id regardless of call order", () => {
    const a = generateLedgerEvents([buy({ id: "x1" })]);
    const b = generateLedgerEvents([buy({ id: "x2" })]); // different raw transaction id, identical economic facts
    expect(a[0].eventId).toBe(b[0].eventId);
  });

  it("a raw transaction with no matching sibling stays its own event, unaffected by an unrelated ticker", () => {
    const events = generateLedgerEvents([buy({ id: "b1", ticker: "COMI" }), buy({ id: "b2", ticker: "HRHO", price: 20 })]);
    expect(events).toHaveLength(2);
  });

  it("ignores non-Buy/Sell raw transaction kinds entirely", () => {
    const verification = createRawTransaction({
      kind: "PositionVerificationCapture",
      source: "position-verification",
      ticker: "COMI",
      payload: { ticker: "COMI", units: 100, capturedAt: "2026-02-10T00:00" },
    });
    const events = generateLedgerEvents([buy({ id: "b1" }), { ...verification, seq: 3 }]);
    expect(events).toHaveLength(1);
  });

  it("empty input produces no events", () => {
    expect(generateLedgerEvents([])).toEqual([]);
  });
});

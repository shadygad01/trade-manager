import { describe, expect, it } from "vitest";
import { buildCanonicalTransactions } from "./canonicalTransaction";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import type { VerifyAllParams } from "./verificationEngine";
import type { PositionAggregate } from "./TradeService";

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "SKPC", shares: 20, price: 14.51, executionDate: "2026-01-20", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", ticker: payload.ticker, payload }), seq: 1 };
}

function emptyPosition(ticker = "SKPC"): PositionAggregate {
  return { ticker, totalShares: 0, costBasis: 0, avgCost: 0, openTrades: [] };
}

describe("canonicalTransaction.buildCanonicalTransactions", () => {
  it("merges two documents describing the same execution into ONE canonical transaction, never two", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement", fees: 2 });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice", fees: 4.09 });
    const params: VerifyAllParams = { transactions: [statementRead, invoiceRead], positions: [emptyPosition()] };

    const transactions = buildCanonicalTransactions("SKPC", params);

    expect(transactions).toHaveLength(1);
    expect(transactions[0].evidenceSources.sort()).toEqual(["invoice-1", "stmt-1"]);
    expect(transactions[0].evidenceCount).toBe(2);
  });

  it("takes fees/taxes from the highest-authority contributing document (Invoice over Statement), not just the first one seen", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement", fees: 2, taxes: 0 });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice", fees: 4.09, taxes: 0.04 });
    const params: VerifyAllParams = { transactions: [statementRead, invoiceRead], positions: [emptyPosition()] };

    const [txn] = buildCanonicalTransactions("SKPC", params);

    expect(txn.fees).toBe(4.09);
    expect(txn.taxes).toBe(0.04);
  });

  it("two genuinely different executions (different shares) never merge into one", () => {
    const first = buy({ id: "b1", shares: 20, executionDate: "2026-01-20" });
    const second = buy({ id: "b2", shares: 30, executionDate: "2026-01-13" });
    const params: VerifyAllParams = { transactions: [first, second], positions: [emptyPosition()] };

    const transactions = buildCanonicalTransactions("SKPC", params);

    expect(transactions).toHaveLength(2);
    expect(transactions.map((t) => t.evidenceCount)).toEqual([1, 1]);
    // sorted by date
    expect(transactions[0].date).toBe("2026-01-13");
  });

  it("carries currentStatus/evidenceCount/corroboratingEdges consistent with the underlying verification result", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement" });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice" });
    const params: VerifyAllParams = { transactions: [statementRead, invoiceRead], positions: [emptyPosition()] };

    const [txn] = buildCanonicalTransactions("SKPC", params);

    expect(txn.currentStatus).toBe("Verified");
    expect(txn.corroboratingEdges.length).toBeGreaterThan(0);
    expect(txn.contradictingEdges).toEqual([]);
  });
});

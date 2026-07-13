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

  it("real bug shape (ABUK): two genuinely distinct same-day/same-price buys with DIFFERENT execution times never merge into one canonical transaction, even sharing the same canonicalKey", () => {
    // canonicalKey is time-blind (ticker/side/date/shares/price) — before the
    // fix, buildCanonicalTransactions grouped purely by it and would fold
    // these two real, distinct 49-share executions into ONE CanonicalTransaction,
    // combining both real RawTransaction ids into one evidenceSources list and
    // hiding that there are actually two separate executions here.
    const twin1032 = buy({ id: "cand-1032", source: "official-broker-excel", ticker: "ABUK", shares: 49, price: 42.4, executionTime: "10:32AM" });
    const twin1034 = buy({ id: "cand-1034", source: "official-broker-excel", ticker: "ABUK", shares: 49, price: 42.4, executionTime: "10:34AM" });
    const params: VerifyAllParams = { transactions: [twin1032, twin1034], positions: [emptyPosition("ABUK")] };

    const transactions = buildCanonicalTransactions("ABUK", params);

    expect(transactions).toHaveLength(2);
    expect(transactions.map((t) => t.evidenceCount)).toEqual([1, 1]);
    const allEvidenceSources = transactions.flatMap((t) => t.evidenceSources);
    expect(allEvidenceSources.sort()).toEqual(["cand-1032", "cand-1034"]);
    // No transaction's evidence claims the OTHER real id as its own.
    expect(transactions[0].evidenceSources).not.toContain(transactions[1].evidenceSources[0]);
  });

  it("still merges same-signature buys when one side simply has no recorded time at all (the routine cross-document corroboration case)", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement", shares: 49, price: 42.4 });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice", shares: 49, price: 42.4, executionTime: "10:32AM" });
    const params: VerifyAllParams = { transactions: [statementRead, invoiceRead], positions: [emptyPosition()] };

    const transactions = buildCanonicalTransactions("SKPC", params);

    expect(transactions).toHaveLength(1);
    expect(transactions[0].evidenceSources.sort()).toEqual(["invoice-1", "stmt-1"]);
  });
});

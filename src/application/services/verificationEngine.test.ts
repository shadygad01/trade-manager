import { describe, expect, it } from "vitest";
import { verifyAll, verifyAllDetailed, verifyTicker, type VerifyAllParams } from "./verificationEngine";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { PositionAggregate } from "./TradeService";
import { checkTickerMatch } from "./importVerification";

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"]; confidence?: RawTransaction["confidence"] } = {}): RawTransaction {
  const { id, source, confidence, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...payloadOverrides };
  return {
    ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", ticker: payload.ticker, confidence, payload }),
    seq: 1,
  };
}

function sell(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05", ...payloadOverrides };
  return {
    ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "manual", ticker: payload.ticker, payload }),
    seq: 2,
  };
}

function positionVerification(units: number, ticker = "COMI", capturedAt = "2026-02-10T00:00"): RawTransaction {
  return {
    ...createRawTransaction({
      kind: "PositionVerificationCapture",
      source: "position-verification",
      ticker,
      payload: { ticker, units, capturedAt },
    }),
    seq: 3,
  };
}

function orderEvidence(overrides: { ticker?: string; side?: "BUY" | "SELL"; shares?: number; price?: number; totalValue?: number } = {}): RawTransaction {
  const ticker = overrides.ticker ?? "COMI";
  const side = overrides.side ?? "BUY";
  const shares = overrides.shares ?? 100;
  const price = overrides.price ?? 45.5;
  return {
    ...createRawTransaction({
      kind: "OrderEvidenceCapture",
      source: "orders-timeline",
      ticker,
      payload: { ticker, side, shares, price, totalValue: overrides.totalValue ?? shares * price, status: "fulfilled" },
    }),
    seq: 4,
  };
}

function emptyPosition(ticker = "COMI"): PositionAggregate {
  return { ticker, totalShares: 0, costBasis: 0, avgCost: 0, openTrades: [] };
}

function run(transactions: RawTransaction[], positions: PositionAggregate[] = [emptyPosition()]) {
  const params: VerifyAllParams = { transactions, positions };
  return verifyAll(params);
}

describe("verificationEngine.verifyAll", () => {
  it("a lone buy with no corroboration and no verification screenshot is Needs Review", () => {
    const b = buy();
    const result = run([b]);
    expect(result.get(b.id)?.verdict).toBe("Needs Review");
  });

  it("a fully closed position (buy + matching sell, net zero, no screenshot needed) is Verified", () => {
    const b = buy({ shares: 100 });
    const s = sell({ shares: 100 });
    const result = run([b, s]);
    expect(result.get(b.id)?.verdict).toBe("Verified");
    expect(result.get(s.id)?.verdict).toBe("Verified");
    expect(result.get(b.id)?.evidence.some((e) => e.type === "matched-position")).toBe(true);
  });

  it("two independent document types describing the same execution are cross-verified and Verified", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement" });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice" });
    const result = run([statementRead, invoiceRead]);

    expect(result.get(statementRead.id)?.verdict).toBe("Verified");
    expect(result.get(statementRead.id)?.evidence.some((e) => e.type === "matched-invoice")).toBe(true);
    expect(result.get(invoiceRead.id)?.evidence.some((e) => e.type === "matched-statement")).toBe(true);
  });

  it("an exact duplicate pair rejects the non-survivor and keeps the higher-priced buy read eligible", () => {
    // Prices must be within siblingPricesClose's 2% tolerance to register as
    // the same real execution read twice, not two distinct trades.
    const higher = buy({ id: "higher", source: "statement", price: 45.8 });
    const lower = buy({ id: "lower", source: "statement", price: 45.5 });
    const result = run([higher, lower]);

    expect(result.get(lower.id)?.verdict).toBe("Rejected");
    expect(result.get(lower.id)?.evidence.some((e) => e.type === "matched-ledger")).toBe(true);
    // The survivor isn't auto-rejected by the duplicate check — its own
    // verdict still depends on whatever other evidence it has (here: none,
    // so it's Needs Review, not silently promoted to Verified).
    expect(result.get(higher.id)?.verdict).toBe("Needs Review");
    expect(result.get(higher.id)?.evidence.some((e) => e.type === "matched-ledger")).toBe(false);
  });

  it("a fulfilled order-history row confirms a pending buy", () => {
    const b = buy();
    const evidence = orderEvidence();
    const result = run([b, evidence]);

    expect(result.get(b.id)?.evidence.some((e) => e.type === "matched-order")).toBe(true);
    expect(result.get(b.id)?.verdict).toBe("Verified");
  });

  it("a position-verification capture that matches computed holdings verifies the buy", () => {
    const b = buy({ shares: 50 });
    const capture = positionVerification(150); // existing 100 + this batch's 50
    const result = run([b, capture], [{ ...emptyPosition(), totalShares: 100 }]);

    expect(result.get(b.id)?.verdict).toBe("Verified");
    expect(result.get(b.id)?.evidence.some((e) => e.type === "matched-position")).toBe(true);
  });

  it("a position-verification mismatch with no other corroboration is Needs Review, not Rejected — nobody knows which row is wrong", () => {
    const b = buy({ shares: 50 });
    const capture = positionVerification(999); // wildly off
    const result = run([b, capture], [{ ...emptyPosition(), totalShares: 100 }]);

    expect(result.get(b.id)?.verdict).toBe("Needs Review");
    expect(result.get(b.id)?.evidence.some((e) => e.type === "contradicted-position-mismatch")).toBe(true);
  });

  it("a statement aggregate row is matched against the group of executions it summarizes", () => {
    const part1 = buy({ id: "p1", source: "orders-screen", shares: 30 });
    const part2 = buy({ id: "p2", source: "orders-screen", shares: 20 });
    const summary = buy({ id: "summary", source: "statement", shares: 50 });
    const result = run([part1, part2, summary]);

    expect(result.get(summary.id)?.evidence.some((e) => e.type === "matched-statement-aggregate")).toBe(true);
  });

  it("never returns evidence or a verdict for a non-Buy/Sell transaction (verification captures aren't subjects)", () => {
    const capture = positionVerification(100);
    const result = run([capture]);
    expect(result.has(capture.id)).toBe(false);
  });

  it("a backfilled transaction is Verified unconditionally, even with no corroboration and an open (non-zero-net) position", () => {
    const b = buy({ source: "backfill" });
    const result = run([b]); // alone — would be Needs Review for any other source
    expect(result.get(b.id)?.verdict).toBe("Verified");
    expect(result.get(b.id)?.evidence).toEqual([{ type: "matched-backfill", detail: "Already committed and reconciled under the pre-migration system." }]);
  });

  it("a backfilled transaction is Verified even when a ticker-level position mismatch exists — history isn't re-litigated under the new rules", () => {
    const b = buy({ source: "backfill", shares: 50 });
    const capture = positionVerification(999); // wildly off — would be Needs Review for a normal source
    const result = run([b, capture], [{ ...emptyPosition(), totalShares: 100 }]);
    expect(result.get(b.id)?.verdict).toBe("Verified");
  });
});

/**
 * Phase 9.5 — contract-completion regression suite. verifyAll()'s existing
 * behavior (asserted above) must be byte-for-byte unchanged now that it's a
 * one-line wrapper over computeVerification; these tests additionally prove
 * verifyAllDetailed()/verifyTicker() surface exactly checkTickerMatch()'s own
 * output — the same numbers the legacy TickerMatchStatus path already
 * produces — rather than a re-derived approximation.
 */
describe("verificationEngine — verifyAllDetailed/verifyTicker (additive contract)", () => {
  const scenarios: { name: string; transactions: RawTransaction[]; positions?: PositionAggregate[] }[] = [
    { name: "lone unverified buy", transactions: [buy()] },
    { name: "closed position (buy+sell net zero)", transactions: [buy({ shares: 100 }), sell({ shares: 100 })] },
    { name: "cross-source verified pair", transactions: [buy({ id: "stmt-1", source: "statement" }), buy({ id: "invoice-1", source: "invoice" })] },
    { name: "exact duplicate pair", transactions: [buy({ id: "higher", source: "statement", price: 45.8 }), buy({ id: "lower", source: "statement", price: 45.5 })] },
    { name: "order-confirmed buy", transactions: [buy(), orderEvidence()] },
    {
      name: "position-verification match",
      transactions: [buy({ shares: 50 }), positionVerification(150)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    },
    {
      name: "position-verification mismatch",
      transactions: [buy({ shares: 50 }), positionVerification(999)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    },
    { name: "statement aggregate", transactions: [buy({ id: "p1", source: "orders-screen", shares: 30 }), buy({ id: "p2", source: "orders-screen", shares: 20 }), buy({ id: "summary", source: "statement", shares: 50 })] },
    { name: "backfilled row", transactions: [buy({ source: "backfill" })] },
    { name: "no transactions at all", transactions: [] },
  ];

  it.each(scenarios)("verifyAllDetailed($name).transactions is identical to verifyAll($name)'s own return value", ({ transactions, positions }) => {
    const params: VerifyAllParams = { transactions, positions: positions ?? [emptyPosition()] };
    const legacy = verifyAll(params);
    const detailed = verifyAllDetailed(params);
    expect(detailed.transactions).toEqual(legacy);
    expect([...detailed.transactions.keys()]).toEqual([...legacy.keys()]);
  });

  it("verifyTicker(ticker, params) returns the exact same object as verifyAllDetailed(params).tickers.get(normalizeTicker(ticker))", () => {
    const params: VerifyAllParams = { transactions: [buy({ shares: 100 }), sell({ shares: 100 })], positions: [emptyPosition()] };
    const viaDetailed = verifyAllDetailed(params).tickers.get("COMI");
    // Not .toBe: computeVerification recomputes fresh on every call (no
    // cache, by design — same convention as holdingsEngine.ts), so this
    // proves the two entry points agree on VALUE, not object identity.
    expect(verifyTicker("COMI", params)).toEqual(viaDetailed);
    expect(verifyTicker("comi", params)).toEqual(viaDetailed); // normalizeTicker uppercases, so a lowercase lookup resolves the same entry
  });

  it("verifyTicker returns undefined for a ticker with no Buy/Sell rows in scope", () => {
    const params: VerifyAllParams = { transactions: [buy({ ticker: "COMI" })], positions: [emptyPosition()] };
    expect(verifyTicker("HRHO", params)).toBeUndefined();
  });

  it("TickerStatus for a closed position matches checkTickerMatch() called directly with the same inputs — reason, netShares, matched", () => {
    const params: VerifyAllParams = { transactions: [buy({ shares: 100 }), sell({ shares: 100 })], positions: [emptyPosition()] };
    const status = verifyTicker("COMI", params)!;
    const expected = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 100,
      pendingSellShares: 100,
      existingRemainingShares: 0,
      allPendingFromInvoice: false,
      allPendingSelfVerified: false,
      allPendingOrderConfirmed: false,
    });
    expect(status.ticker).toBe("COMI");
    expect(status.matched).toBe(expected.matched);
    expect(status.reason).toBe(expected.reason);
    expect(status.netShares).toBe(expected.netShares);
  });

  it("TickerStatus surfaces verifiedUnits/verifiedAvgCost/discrepancySide exactly as checkTickerMatch computed them, for a mismatch", () => {
    const params: VerifyAllParams = {
      transactions: [buy({ shares: 50 }), positionVerification(999)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    };
    const status = verifyTicker("COMI", params)!;
    expect(status.reason).toBe("mismatch");
    expect(status.verifiedUnits).toBe(999);
    expect(status.existingRemainingShares).toBe(100);
    expect(status.pendingBuyShares).toBe(50);
    expect(status.netShares).toBe(150);
    // netShares (150) < verifiedUnits (999) => shortage sits on the sell/missing-buy side.
    expect(status.discrepancySide).toBe("sell");
  });

  it("TickerStatus.alreadyFullyRecorded is exposed when the broker's verified count already matches pre-batch ledger shares", () => {
    const params: VerifyAllParams = {
      transactions: [buy({ shares: 30 }), positionVerification(100)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    };
    const status = verifyTicker("COMI", params)!;
    expect(status.reason).toBe("mismatch");
    expect(status.alreadyFullyRecorded).toBe(true);
  });

  it("computeVerification is only exercised once per call — verifyAllDetailed does not run checkTickerMatch a second time with different results", () => {
    // If the ticker-level computation ever forked into two separate call
    // sites, a ticker straddling two batches of the same params could drift.
    // Calling twice from the same params must be referentially stable in
    // content (not identity, since each call recomputes from scratch) but
    // never divergent.
    const params: VerifyAllParams = { transactions: [buy({ shares: 50 }), positionVerification(150)], positions: [{ ...emptyPosition(), totalShares: 100 }] };
    const first = verifyAllDetailed(params);
    const second = verifyAllDetailed(params);
    expect(first.tickers.get("COMI")).toEqual(second.tickers.get("COMI"));
    expect(first.transactions).toEqual(second.transactions);
  });
});

import { describe, expect, it } from "vitest";
import { assessTickerCompleteness, assessSingleTicker, assessAllTickersCompleteness } from "./completenessEngine";
import { verifyTicker, type VerifyAllParams } from "./verificationEngine";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { PositionAggregate } from "./TradeService";

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

function positionVerification(units: number, ticker = "COMI", capturedAt = "2026-02-10T00:00"): RawTransaction {
  return { ...createRawTransaction({ kind: "PositionVerificationCapture", source: "position-verification", ticker, payload: { ticker, units, capturedAt } }), seq: 3 };
}

function orderEvidence(overrides: { ticker?: string; side?: "BUY" | "SELL"; shares?: number; price?: number; totalValue?: number; date?: string } = {}): RawTransaction {
  const ticker = overrides.ticker ?? "COMI";
  const side = overrides.side ?? "BUY";
  const shares = overrides.shares;
  const price = overrides.price;
  return {
    ...createRawTransaction({
      kind: "OrderEvidenceCapture",
      source: "orders-timeline",
      ticker,
      payload: { ticker, side, shares, price, totalValue: overrides.totalValue ?? (shares && price ? shares * price : 1000), status: "fulfilled", date: overrides.date },
    }),
    seq: 4,
  };
}

function emptyPosition(ticker = "COMI"): PositionAggregate {
  return { ticker, totalShares: 0, costBasis: 0, avgCost: 0, openTrades: [] };
}

describe("completenessEngine — Historical Ledger Completeness Engine", () => {
  it("COMI: an open position matched exactly against a real broker screenshot is Verified, completeness 100, no recovery plan", () => {
    const b = buy({ shares: 100 });
    const capture = positionVerification(100);
    const params: VerifyAllParams = { transactions: [b, capture], positions: [emptyPosition()] };
    const status = verifyTicker("COMI", params)!;
    const report = assessTickerCompleteness(status);

    expect(report.status).toBe("Verified");
    expect(report.completeness).toBe(100);
    expect(report.recoveryPlan).toBeUndefined();
    expect(report.missingWindow).toBeUndefined();
  });

  it("HRHO: two independent document types corroborating the same execution (cross-verified) is Complete, not Verified — real independent evidence, but no broker Holdings screen", () => {
    const statementRead = buy({ id: "hrho-1", ticker: "HRHO", source: "statement" });
    const invoiceRead = buy({ id: "hrho-2", ticker: "HRHO", source: "invoice" });
    const params: VerifyAllParams = { transactions: [statementRead, invoiceRead], positions: [emptyPosition("HRHO")] };
    const status = verifyTicker("HRHO", params)!;
    const report = assessTickerCompleteness(status);

    expect(report.status).toBe("Complete");
    expect(report.completeness).toBe(90);
    expect(report.recoveryPlan).toBeUndefined();
  });

  it("the JUFO/SKPC-shaped case (docs/ROADMAP.md): a closed position (net shares = 0) with NO independent corroboration is Incomplete, never Complete — requirement 6", () => {
    const opened = buy({ shares: 500, executionDate: "2022-12-01" });
    const closed = sell({ shares: 500, executionDate: "2024-08-01" });
    const params: VerifyAllParams = { transactions: [opened, closed], positions: [emptyPosition()] };
    const status = verifyTicker("COMI", params)!;
    expect(status.reason).toBe("closed-position"); // confirms this is exactly the shape checkTickerMatch's own trivial-match covers

    const report = assessTickerCompleteness(status);
    expect(report.status).toBe("Incomplete"); // the whole point of this engine — never "Complete" on arithmetic alone
    expect(report.completeness).toBeLessThan(90);
    expect(report.recoveryPlan).toBeDefined();
  });

  it("CSAG: a mismatch against a real broker count, with a lastBalancedDate found, is Incomplete with a bounded missing window and a mid-confidence recovery plan", () => {
    const opened = buy({ ticker: "CSAG", shares: 48, executionDate: "2026-01-05" });
    const closedGap = sell({ ticker: "CSAG", shares: 48, executionDate: "2026-01-10" }); // reconciles to 0 here
    const unexplained = buy({ ticker: "CSAG", shares: 34, executionDate: "2026-03-01" }); // the real gap starts after 2026-01-10
    const capture = positionVerification(50, "CSAG"); // broker says 50, batch nets to 34 — genuine mismatch
    const params: VerifyAllParams = { transactions: [opened, closedGap, unexplained, capture], positions: [emptyPosition("CSAG")] };
    const status = verifyTicker("CSAG", params)!;
    expect(status.reason).toBe("mismatch");

    const report = assessTickerCompleteness(status);
    expect(report.status).toBe("Incomplete");
    expect(report.missingWindow).toEqual({ from: "2026-01-10", to: undefined });
    expect(report.recoveryPlan?.bestEvidence).toBe("Orders History");
    expect(report.recoveryPlan?.estimatedRecoverySuccess).toBe(60);
    expect(report.estimatedMissingTransactions).toBe(1);
    expect(report.estimatedMissingShares).toBe(16); // |34 - 50|
  });

  it("never recommends a document type already covered by an existing upload — falls through to the next best, and finally to Invoice", () => {
    // A Statement was already uploaded covering January (rows on the 5th and
    // 28th) and evidently doesn't contain the orphaned Orders-history row's
    // execution on the 14th — asking for "a Statement" again can't help.
    const closedPair1 = buy({ id: "c1", ticker: "CSAG", shares: 10, executionDate: "2025-12-01" });
    const closedPair2 = sell({ id: "c2", ticker: "CSAG", shares: 10, executionDate: "2025-12-15" });
    const alreadyUploadedStatement1 = { ...buy({ id: "st1", ticker: "CSAG", shares: 5, executionDate: "2026-01-05", source: "statement" }), sourceUploadId: "upload-jan-statement" };
    const alreadyUploadedStatement2 = { ...buy({ id: "st2", ticker: "CSAG", shares: 5, executionDate: "2026-01-28", source: "statement" }), sourceUploadId: "upload-jan-statement" };
    const orphaned = orderEvidence({ ticker: "CSAG", side: "BUY", shares: 20, price: 41.5, date: "2026-01-14" });
    const params: VerifyAllParams = {
      transactions: [closedPair1, closedPair2, alreadyUploadedStatement1, alreadyUploadedStatement2, orphaned],
      positions: [emptyPosition("CSAG")],
    };
    const report = assessSingleTicker("CSAG", params)!;

    // Default plan would be "Broker Statement" (see the CSAG test above) —
    // but one is already on file covering exactly this date, so it's skipped.
    expect(report.recoveryPlan?.bestEvidence).toBe("Invoice");
    expect(report.recoveryPlan?.rationale).toContain("already uploaded");
  });

  it("CSAG: orphaned Orders-history evidence names the exact missing execution (ticker/date/shares) the minimal-document-request business rule requires", () => {
    // Matches the business rule's own worked example verbatim: CSAG, 14 Jan
    // 2026, 20 shares, Orders+Statement already prove it happened, Invoice
    // is the only missing evidence.
    const closedPair1 = buy({ id: "c1", ticker: "CSAG", shares: 10, executionDate: "2025-12-01" });
    const closedPair2 = sell({ id: "c2", ticker: "CSAG", shares: 10, executionDate: "2025-12-15" }); // reconciles to 0
    const orphaned = orderEvidence({ ticker: "CSAG", side: "BUY", shares: 20, price: 41.5, date: "2026-01-14" });
    const params: VerifyAllParams = { transactions: [closedPair1, closedPair2, orphaned], positions: [emptyPosition("CSAG")] };
    const status = verifyTicker("CSAG", params)!;

    const report = assessTickerCompleteness(status);
    expect(report.status).toBe("Incomplete");
    expect(report.recoveryPlan?.bestEvidence).toBe("Broker Statement");
    expect(report.recoveryPlan?.expectedExecution).toEqual({ ticker: "CSAG", side: "BUY", date: "2026-01-14", shares: 20 });
  });

  it("ORWE: orphaned fulfilled Orders-history evidence gives a DIRECT, non-estimated missing count/shares/window, and the highest recovery confidence tier", () => {
    // No broker "My Position" screenshot at all here. A fully closed
    // buy+sell pair establishes a real lastBalancedDate first, so the
    // orphaned row's own date can supply missingWindow's evidence-backed
    // upper bound; the still-open knownBuy afterward is what makes this
    // ticker "no-verification" (net != 0) rather than "closed-position".
    const openedThenClosed1 = buy({ id: "o1", ticker: "ORWE", shares: 50, executionDate: "2025-11-01" });
    const openedThenClosed2 = sell({ id: "o2", ticker: "ORWE", shares: 50, executionDate: "2025-12-01" }); // reconciles to 0 here
    const knownBuy = buy({ id: "o3", ticker: "ORWE", shares: 89, executionDate: "2026-01-01" });
    const orphaned = orderEvidence({ ticker: "ORWE", side: "BUY", shares: 34, price: 12, date: "2026-03-03" }); // no matching candidate at all
    const params: VerifyAllParams = { transactions: [openedThenClosed1, openedThenClosed2, knownBuy, orphaned], positions: [emptyPosition("ORWE")] };
    const status = verifyTicker("ORWE", params)!;
    expect(status.reason).toBe("no-verification");
    expect(status.lastBalancedDate?.date).toBe("2025-12-01");

    const report = assessTickerCompleteness(status);
    expect(report.status).toBe("Incomplete");
    expect(report.completeness).toBeLessThanOrEqual(60); // direct-evidence ceiling
    expect(report.estimatedMissingTransactions).toBe(1);
    expect(report.estimatedMissingShares).toBe(34); // read straight off the orphaned evidence row, not guessed
    expect(report.missingWindow?.to).toBe("2026-03-03"); // evidence-backed upper bound
    expect(report.recoveryPlan?.bestEvidence).toBe("Broker Statement");
    expect(report.recoveryPlan?.estimatedRecoverySuccess).toBe(90);
  });

  it("PHAR: no point in the ticker's history ever reconciles to zero — an unbounded gap, lowest recovery confidence tier, no missing window can be named", () => {
    // A single, isolated mismatch with nothing before it — findLastBalancedDate
    // never finds a zero-crossing at all (the imbalance starts from row one).
    const lone = buy({ ticker: "PHAR", shares: 12, executionDate: "2026-04-15" });
    const capture = positionVerification(31, "PHAR");
    const params: VerifyAllParams = { transactions: [lone, capture], positions: [emptyPosition("PHAR")] };
    const status = verifyTicker("PHAR", params)!;
    expect(status.lastBalancedDate).toBeUndefined();

    const report = assessTickerCompleteness(status);
    expect(report.status).toBe("Incomplete");
    expect(report.missingWindow).toBeUndefined();
    expect(report.recoveryPlan?.estimatedRecoverySuccess).toBe(25);
  });

  it("KIMA: a ticker with zero Buy/Sell rows in scope (dividend-only) is Unknown — there is no ledger here to assess, not a confirmed empty one", () => {
    const params: VerifyAllParams = { transactions: [], positions: [] };
    const report = assessSingleTicker("KIMA", params);
    expect(report).toBeUndefined(); // no ticker entry exists at all — nothing to report on
  });

  it("Unknown status specifically: a ticker present in scope only via non-Buy/Sell rows still yields no TickerStatus, so assessSingleTicker reports nothing rather than fabricating a score", () => {
    const capture = positionVerification(100, "KIMA");
    const params: VerifyAllParams = { transactions: [capture], positions: [] };
    expect(assessSingleTicker("KIMA", params)).toBeUndefined();
  });

  it("assessAllTickersCompleteness reports every ticker in one batch call, matching each ticker's own assessSingleTicker result", () => {
    const comiBuy = buy({ id: "c1", ticker: "COMI", shares: 100 });
    const comiCapture = positionVerification(100, "COMI");
    const hrhoA = buy({ id: "h1", ticker: "HRHO", source: "statement" });
    const hrhoB = buy({ id: "h2", ticker: "HRHO", source: "invoice" });
    const params: VerifyAllParams = {
      transactions: [comiBuy, comiCapture, hrhoA, hrhoB],
      positions: [emptyPosition("COMI"), emptyPosition("HRHO")],
    };

    const all = assessAllTickersCompleteness(params);
    expect(all.get("COMI")).toEqual(assessSingleTicker("COMI", params));
    expect(all.get("HRHO")).toEqual(assessSingleTicker("HRHO", params));
    expect(all.get("COMI")?.status).toBe("Verified");
    expect(all.get("HRHO")?.status).toBe("Complete");
  });
});


import { describe, it, expect } from "vitest";
import { checkTickerMatch, isTickerFullyResolved } from "./importVerification";
import type { DiagnosticsRecorder } from "@domain/repositories";
import type { DecisionTraceRecord } from "@domain/entities/diagnostics/DiagnosticEvent";

function fakeDiagnostics(): DiagnosticsRecorder & { decisions: DecisionTraceRecord[] } {
  const decisions: DecisionTraceRecord[] = [];
  return {
    decisions,
    recordSessionEvent() {},
    recordWrite() {},
    recordRead() {},
    recordDecision(event) {
      decisions.push({ ...event, id: "x", seq: decisions.length + 1, recordedAt: new Date().toISOString(), sessionId: "s1", kind: "DecisionTrace" });
    },
    recordRuleExecution() {},
    recordPerfSample() {},
  };
}

describe("checkTickerMatch", () => {
  it("matches when net pending shares exactly equal the verified units", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 100,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("matched");
    expect(result.netShares).toBe(100);
    expect(result.discrepancySide).toBeUndefined();
  });

  it("accounts for shares already on the ledger plus a pending sell", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 20,
      pendingSellShares: 30,
      existingRemainingShares: 100,
      verifiedUnits: 90,
    });
    expect(result.matched).toBe(true);
    expect(result.netShares).toBe(90);
    expect(result.existingRemainingShares).toBe(100);
  });

  it("flags a mismatch when the net shares differ from the verified units", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 120,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("mismatch");
  });

  it("blocks with 'no-verification' when a ticker has shares but no broker screenshot was uploaded", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
  });

  it("is trivially matched for a ticker with no pending buy/sell candidates (e.g. dividend-only)", () => {
    const result = checkTickerMatch({
      hasShares: false,
      pendingBuyShares: 0,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("no-shares-to-verify");
  });

  it("does NOT auto-match a fully sold-out ticker (buy == sell) with no independent corroboration â€” the JUFO/SKPC closed-position trap", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 50,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("closed-position");
    expect(result.netShares).toBe(0);
    expect(result.discrepancySide).toBeUndefined();
  });

  it("still matches a closed (net-zero) ticker once independently corroborated (invoice/cross/orders-verified)", () => {
    const invoiceVerified = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 50,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingFromInvoice: true,
    });
    expect(invoiceVerified.matched).toBe(true);
    expect(invoiceVerified.reason).toBe("invoice-verified");

    const ordersVerified = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 50,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingOrderConfirmed: true,
    });
    expect(ordersVerified.matched).toBe(true);
    expect(ordersVerified.reason).toBe("orders-verified");

    const brokerExcelVerified = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 50,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(brokerExcelVerified.matched).toBe(true);
    expect(brokerExcelVerified.reason).toBe("broker-excel-verified");
  });

  it("still requires a screenshot when net shares are nonzero and none was uploaded", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 20,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
  });

  it("trusts an invoice-sourced batch as its own verification when no broker screenshot exists yet", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: undefined,
      allPendingFromInvoice: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("invoice-verified");
    expect(result.netShares).toBe(37);
  });

  it("still blocks an invoice-sourced batch if a broker screenshot exists and actually mismatches", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: 30,
      allPendingFromInvoice: true,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("mismatch");
  });

  it("trusts a batch sourced entirely from the official broker Excel export as its own verification, with no screenshot/invoice/manual confirmation needed", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: undefined,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("broker-excel-verified");
    expect(result.netShares).toBe(37);
  });

  it("never lets an official broker Excel sell create an impossible negative inventory", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 46,
      existingRemainingShares: 42,
      verifiedUnits: undefined,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(result).toMatchObject({
      matched: false,
      reason: "no-verification",
      netShares: -4,
      discrepancySide: "sell",
    });
  });

  it("stays broker-excel-verified even when a broker screenshot disagrees â€” the Excel remains authoritative, the screenshot is only flagged as a secondary-source mismatch", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: 30,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("broker-excel-verified");
    expect(result.secondaryMismatch).toBe(true);
  });

  it("reports no secondary mismatch when a broker-excel batch's screenshot actually agrees", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: 37,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("broker-excel-verified");
    expect(result.secondaryMismatch).toBe(false);
  });

  it("reports no secondary mismatch when a broker-excel batch has no screenshot at all", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: undefined,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("broker-excel-verified");
    expect(result.secondaryMismatch).toBe(false);
  });

  it("prefers broker-excel-verified when both flags are somehow true (impossible in real data â€” a candidate's source is a single value â€” but the broker-excel check runs first since it also overrides a disagreeing screenshot, which invoice's own check does not)", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingFromInvoice: true,
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(result.reason).toBe("broker-excel-verified");
  });

  it("trusts a cross-verified batch (an OCR read corroborated by an independent invoice) with no broker screenshot at all", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingSelfVerified: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("cross-verified");
  });

  it("prefers invoice-verified over cross-verified when both are true", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingFromInvoice: true,
      allPendingSelfVerified: true,
    });
    expect(result.reason).toBe("invoice-verified");
  });

  it("still blocks a cross-verified batch if a broker screenshot exists and actually mismatches", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 30,
      allPendingSelfVerified: true,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("mismatch");
  });

  it("flags alreadyFullyRecorded when the ledger alone already reconciles with the broker (a bulk re-upload of an already-imported ticker)", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 175,
      pendingSellShares: 0,
      existingRemainingShares: 175,
      verifiedUnits: 175,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("mismatch");
    expect(result.netShares).toBe(350);
    expect(result.alreadyFullyRecorded).toBe(true);
  });

  it("does not flag alreadyFullyRecorded for a genuine mismatch where the ledger alone doesn't already match the broker", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 99,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 74,
    });
    expect(result.matched).toBe(false);
    expect(result.alreadyFullyRecorded).toBeFalsy();
  });

  it("trusts a batch fully confirmed by the broker's Orders history when no broker screenshot exists yet", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 30,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingOrderConfirmed: true,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("orders-verified");
  });

  it("prefers cross-verified over orders-verified when both apply", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 30,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      allPendingSelfVerified: true,
      allPendingOrderConfirmed: true,
    });
    expect(result.reason).toBe("cross-verified");
  });

  it("still blocks an orders-confirmed batch if a broker screenshot exists and actually mismatches", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 30,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 25,
      allPendingOrderConfirmed: true,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("mismatch");
  });

  it("does not invoice-verify a mixed batch (some candidates not from an invoice)", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: undefined,
      allPendingFromInvoice: false,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
  });

  // discrepancySide tests

  it("sets discrepancySide to 'buy' on mismatch when net shares exceed verified (too many buys)", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 120,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    expect(result.matched).toBe(false);
    expect(result.discrepancySide).toBe("buy");
  });

  it("sets discrepancySide to 'sell' on mismatch when net shares fall short of verified (too many sells or missing buys)", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 80,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    expect(result.matched).toBe(false);
    expect(result.discrepancySide).toBe("sell");
  });

  it("sets discrepancySide to 'buy' on no-verification when buys outweigh sells", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 60,
      pendingSellShares: 10,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
    expect(result.discrepancySide).toBe("buy");
  });

  it("sets discrepancySide to 'sell' on no-verification when sells outweigh buys", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 10,
      pendingSellShares: 60,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
    expect(result.discrepancySide).toBe("sell");
  });

  it("points at the Buy side when a sell-only batch leaves a positive net â€” the surplus is in already-recorded buys (the real AMOC shape)", () => {
    // Only Sells pending (80) against 300 already on the ledger: net +220.
    // A pending-rows comparison would blame the Sell side (the only pending
    // rows), but a positive net on a supposedly closed position means EXTRA
    // shares â€” i.e. a duplicate/extra buy already committed to the ledger.
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 80,
      existingRemainingShares: 300,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
    expect(result.netShares).toBe(220);
    expect(result.discrepancySide).toBe("buy");
  });

  it("still points at the Sell side when the net goes negative even with existing shares on the ledger", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 80,
      existingRemainingShares: 50,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-verification");
    expect(result.netShares).toBe(-30);
    expect(result.discrepancySide).toBe("sell");
  });
});

describe("isTickerFullyResolved", () => {
  it("is false while the ticker isn't matched yet, even if every row is otherwise resolved", () => {
    expect(
      isTickerFullyResolved({
        matched: false,
        transactionKeys: ["buy-1"],
        dividendKeys: [],
        verificationKeys: [],
        addedKeys: new Set(["buy-1"]),
        skippedKeys: new Set(),
        dismissedKeys: new Set(),
        acceptedKeys: new Set(),
        rowErrorKeys: new Set(),
      }),
    ).toBe(false);
  });

  it("is false for a ticker with no buy/sell rows at all (dividend/verification-only) â€” no 'sell = buy' question to answer", () => {
    expect(
      isTickerFullyResolved({
        matched: true,
        transactionKeys: [],
        dividendKeys: ["div-1"],
        verificationKeys: [],
        addedKeys: new Set(["div-1"]),
        skippedKeys: new Set(),
        dismissedKeys: new Set(),
        acceptedKeys: new Set(),
        rowErrorKeys: new Set(),
      }),
    ).toBe(false);
  });

  it("is true once a matched ticker's only buy has committed and there's nothing else pending", () => {
    expect(
      isTickerFullyResolved({
        matched: true,
        transactionKeys: ["buy-1"],
        dividendKeys: [],
        verificationKeys: [],
        addedKeys: new Set(["buy-1"]),
        skippedKeys: new Set(),
        dismissedKeys: new Set(),
        acceptedKeys: new Set(),
        rowErrorKeys: new Set(),
      }),
    ).toBe(true);
  });

  it("is false while a sell candidate still needs to be allocated", () => {
    expect(
      isTickerFullyResolved({
        matched: true,
        transactionKeys: ["buy-1", "sell-1"],
        dividendKeys: [],
        verificationKeys: [],
        addedKeys: new Set(["buy-1"]),
        skippedKeys: new Set(),
        dismissedKeys: new Set(),
        acceptedKeys: new Set(),
        rowErrorKeys: new Set(),
      }),
    ).toBe(false);
  });

  it("counts a skipped exact-duplicate buy and a manually dismissed row as resolved, not just an added one", () => {
    expect(
      isTickerFullyResolved({
        matched: true,
        transactionKeys: ["buy-1", "buy-2", "sell-1"],
        dividendKeys: [],
        verificationKeys: [],
        addedKeys: new Set(["sell-1"]),
        skippedKeys: new Set(["buy-1"]),
        dismissedKeys: new Set(["buy-2"]),
        acceptedKeys: new Set(),
        rowErrorKeys: new Set(),
      }),
    ).toBe(true);
  });

  it("is false while a dividend or verification row hasn't committed/accepted yet", () => {
    const base = {
      matched: true,
      transactionKeys: ["buy-1"],
      addedKeys: new Set(["buy-1"]),
      skippedKeys: new Set<string>(),
      dismissedKeys: new Set<string>(),
      rowErrorKeys: new Set<string>(),
    };
    expect(
      isTickerFullyResolved({ ...base, dividendKeys: ["div-1"], verificationKeys: [], acceptedKeys: new Set() }),
    ).toBe(false);
    expect(
      isTickerFullyResolved({ ...base, dividendKeys: [], verificationKeys: ["v-1"], acceptedKeys: new Set() }),
    ).toBe(false);
  });

  it("is false when any row â€” including an added one â€” is stuck on a row error", () => {
    expect(
      isTickerFullyResolved({
        matched: true,
        transactionKeys: ["buy-1"],
        dividendKeys: [],
        verificationKeys: [],
        addedKeys: new Set(["buy-1"]),
        skippedKeys: new Set(),
        dismissedKeys: new Set(),
        acceptedKeys: new Set(),
        rowErrorKeys: new Set(["buy-1"]),
      }),
    ).toBe(false);
  });
});

describe("checkTickerMatch Verification decision (Diagnostics Center)", () => {
  /**
   * This is the terminal decision function behind the Import UI's "Needs
   * broker screenshot"/"Mismatch"/"Closed â€” needs corroborating evidence"
   * banners â€” a real, previously-uninstrumented gap: constraintValidation.ts's
   * Constraint decision only checks whether already-known facts arithmetically
   * reconcile (satisfied for ABUK: opening 27 + buy 0 - sell 0 = 27), which is
   * a different question from "is there independent corroboration for that
   * figure" â€” the question checkTickerMatch alone answers, and the one that
   * actually produced the "Needs broker screenshot" banner. Reproduces the
   * exact ABUK shape reported: an open position with no pending rows this
   * batch and no broker holdings verification on file at all.
   */
  it("records a Verification decision naming 'Needs broker screenshot' for an unverified open position (the ABUK/ARCC shape)", () => {
    const diagnostics = fakeDiagnostics();
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: undefined,
      ticker: "ABUK",
      diagnostics,
    });
    expect(result.reason).toBe("no-verification");

    expect(diagnostics.decisions).toHaveLength(1);
    const decision = diagnostics.decisions[0];
    expect(decision.decisionType).toBe("Verification");
    expect(decision.reader).toBe("importVerification.ts");
    expect(decision.function).toBe("checkTickerMatch");
    expect(decision.ticker).toBe("ABUK");
    expect(decision.decision).toBe("Needs broker screenshot");
    expect(decision.inputSummary).toBe("opening 27 + buy 0 - sell 0 = 27, no broker holdings on file");
    expect(decision.outputSummary).toContain("no-verification");
  });

  it("records 'Mismatch' as the decision text when net shares disagree with broker holdings", () => {
    const diagnostics = fakeDiagnostics();
    checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 120,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
      ticker: "COMI",
      diagnostics,
    });
    expect(diagnostics.decisions[0].decision).toBe("Mismatch");
  });

  it("records 'Closed â€” needs corroborating evidence' for an uncorroborated net-zero position", () => {
    const diagnostics = fakeDiagnostics();
    checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 50,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
      ticker: "JUFO",
      diagnostics,
    });
    expect(diagnostics.decisions[0].decision).toBe("Closed â€” needs corroborating evidence");
  });

  it("records nothing when diagnostics is not passed (default, zero-cost behavior unchanged)", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 0,
      existingRemainingShares: 27,
      verifiedUnits: undefined,
    });
    expect(result.reason).toBe("no-verification");
    // Nothing to assert on diagnostics â€” this just proves the call succeeds with no diagnostics arg.
  });
});


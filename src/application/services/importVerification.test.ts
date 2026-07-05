import { describe, it, expect } from "vitest";
import { checkTickerMatch } from "./importVerification";

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

  it("is trivially matched for a fully sold-out ticker even with no broker screenshot", () => {
    const result = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 50,
      existingRemainingShares: 0,
      verifiedUnits: undefined,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("closed-position");
    expect(result.netShares).toBe(0);
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
});

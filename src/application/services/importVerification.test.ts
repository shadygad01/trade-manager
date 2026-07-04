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
});

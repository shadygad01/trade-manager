import { describe, it, expect } from "vitest";
import { createTrade, getTradeStatus } from "./Trade";

function trade(remainingShares: number) {
  const t = createTrade({
    id: "t1",
    portfolioId: "p1",
    ticker: "COMI",
    shares: 100,
    entryPrice: 50,
    executionDate: "2026-01-01",
    executionTime: "10:00",
  });
  return { ...t, remainingShares };
}

describe("getTradeStatus", () => {
  it("is open when untouched", () => {
    expect(getTradeStatus(trade(100))).toBe("open");
  });

  it("is partial when some shares are closed", () => {
    expect(getTradeStatus(trade(40))).toBe("partial");
  });

  it("is closed when fully exited", () => {
    expect(getTradeStatus(trade(0))).toBe("closed");
  });
});

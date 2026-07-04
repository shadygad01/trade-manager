import { describe, it, expect } from "vitest";
import { createTrade } from "./Trade";
import { createTradeAllocation, realizedPnlMicros } from "./TradeAllocation";

function buyTrade(overrides: Partial<{ fees: number; taxes: number }> = {}) {
  const trade = createTrade({
    id: "t1",
    portfolioId: "p1",
    ticker: "COMI",
    shares: 100,
    entryPrice: 50,
    fees: overrides.fees ?? 0,
    executionDate: "2026-01-01",
    executionTime: "10:00",
  });
  return { ...trade, taxes: overrides.taxes ?? 0 };
}

describe("realizedPnlMicros", () => {
  it("is zero-fee/tax profit when exit price exceeds entry price", () => {
    const trade = buyTrade();
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 100,
      exitPrice: 60,
      executionDate: "2026-02-01",
      executionTime: "10:00",
    });
    expect(realizedPnlMicros(allocation, trade) / 1_000_000).toBeCloseTo(100 * (60 - 50));
  });

  it("reduces realized P/L by both entry and exit fees+taxes", () => {
    const trade = buyTrade({ fees: 20, taxes: 30 });
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 100,
      exitPrice: 60,
      fees: 15,
      taxes: 25,
      executionDate: "2026-02-01",
      executionTime: "10:00",
    });
    // Cost basis: 100*50 + 20 + 30 = 5050. Net proceeds: 100*60 - 15 - 25 = 5960. P/L = 910.
    expect(realizedPnlMicros(allocation, trade) / 1_000_000).toBeCloseTo(910);
  });
});

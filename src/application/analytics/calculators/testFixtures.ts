import { createTrade, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, type TradeAllocation } from "@domain/entities/TradeAllocation";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makeTrade(overrides: Partial<Parameters<typeof createTrade>[0]> & { id?: string } = {}): Trade {
  return createTrade({
    id: overrides.id ?? nextId("trade"),
    portfolioId: overrides.portfolioId ?? "p1",
    ticker: overrides.ticker ?? "COMI",
    shares: overrides.shares ?? 100,
    entryPrice: overrides.entryPrice ?? 10,
    fees: overrides.fees ?? 0,
    executionDate: overrides.executionDate ?? "2026-01-01",
    executionTime: overrides.executionTime ?? "10:00",
    notes: overrides.notes,
    strategyTags: overrides.strategyTags,
  });
}

export function makeAllocation(
  overrides: Partial<Parameters<typeof createTradeAllocation>[0]> & { tradeId: string }
): TradeAllocation {
  return createTradeAllocation({
    id: overrides.id ?? nextId("alloc"),
    sellGroupId: overrides.sellGroupId ?? nextId("sellgroup"),
    portfolioId: overrides.portfolioId ?? "p1",
    tradeId: overrides.tradeId,
    ticker: overrides.ticker ?? "COMI",
    sharesClosed: overrides.sharesClosed ?? 10,
    exitPrice: overrides.exitPrice ?? 10,
    fees: overrides.fees ?? 0,
    executionDate: overrides.executionDate ?? "2026-02-01",
    executionTime: overrides.executionTime ?? "10:00",
    notes: overrides.notes,
    exitReason: overrides.exitReason,
  });
}

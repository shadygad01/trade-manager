import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { winRate } from "./winRate";
import { profitFactor } from "./profitFactor";
import { realizedPnlMicrosForAllocations } from "./shared";

export interface StrategyAttribution {
  tag: string;
  tradeCount: number;
  closedAllocationCount: number;
  winRate: number;
  profitFactor: number;
  totalRealizedPnl: number;
  avgRealizedPnl: number;
}

/**
 * A trade can carry more than one strategy tag (e.g. "Swing" + "Momentum"),
 * so its realized P/L counts toward every tag it's attributed to rather than
 * being split — the question this answers is "how does the Swing strategy
 * perform", not "how much P/L belongs exclusively to Swing".
 */
export function strategyAttribution(trades: Trade[], allocations: TradeAllocation[]): StrategyAttribution[] {
  const tagToTradeIds = new Map<string, Set<string>>();
  for (const trade of trades) {
    for (const tag of trade.strategyTags) {
      const set = tagToTradeIds.get(tag) ?? new Set<string>();
      set.add(trade.id);
      tagToTradeIds.set(tag, set);
    }
  }

  const results: StrategyAttribution[] = [];
  for (const [tag, tradeIds] of tagToTradeIds) {
    const taggedTrades = trades.filter((t) => tradeIds.has(t.id));
    const taggedAllocations = allocations.filter((a) => tradeIds.has(a.tradeId));
    const pnlMicros = realizedPnlMicrosForAllocations(taggedAllocations, taggedTrades);
    const totalRealizedPnl = pnlMicros.reduce((sum, p) => sum + p, 0) / 1_000_000;

    results.push({
      tag,
      tradeCount: tradeIds.size,
      closedAllocationCount: taggedAllocations.length,
      winRate: winRate(taggedAllocations, taggedTrades),
      profitFactor: profitFactor(taggedAllocations, taggedTrades),
      totalRealizedPnl,
      avgRealizedPnl: taggedAllocations.length > 0 ? totalRealizedPnl / taggedAllocations.length : 0,
    });
  }

  return results.sort((a, b) => b.totalRealizedPnl - a.totalRealizedPnl);
}

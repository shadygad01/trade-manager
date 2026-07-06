import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { JournalEntry } from "@domain/entities/JournalEntry";
import { winRate } from "./winRate";
import { profitFactor } from "./profitFactor";
import { realizedPnlMicrosForAllocations, costBasisMicrosForAllocations } from "./shared";

export interface StrategyAttribution {
  tag: string;
  tradeCount: number;
  closedAllocationCount: number;
  winRate: number;
  profitFactor: number;
  totalRealizedPnl: number;
  avgRealizedPnl: number;
  /** Total realized P/L across this tag's closed allocations, as % of their combined cost basis — the money-based fields above stay for ranking; this is what the UI displays. */
  totalRealizedReturnPct: number;
}

/**
 * A trade can carry more than one strategy tag (e.g. "Swing" + "Momentum"),
 * so its realized P/L counts toward every tag it's attributed to rather than
 * being split — the question this answers is "how does the Swing strategy
 * perform", not "how much P/L belongs exclusively to Swing".
 *
 * Tags come from two places that can disagree: `Trade.strategyTags` (set at
 * fill time) and `JournalEntry.strategyTags` (set or edited later, during
 * reflection). This attributes by the union of both — a tag added in the
 * Journal after the fact affects this table exactly like one set at buy
 * time, rather than being silently ignored.
 */
export function strategyAttribution(
  trades: Trade[],
  allocations: TradeAllocation[],
  journalEntries: JournalEntry[] = []
): StrategyAttribution[] {
  const journalTagsByTrade = new Map<string, string[]>();
  for (const entry of journalEntries) {
    journalTagsByTrade.set(entry.tradeId, entry.strategyTags);
  }

  const tagToTradeIds = new Map<string, Set<string>>();
  for (const trade of trades) {
    const tags = new Set([...trade.strategyTags, ...(journalTagsByTrade.get(trade.id) ?? [])]);
    for (const tag of tags) {
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
    const totalRealizedPnlMicros = pnlMicros.reduce((sum, p) => sum + p, 0);
    const totalRealizedPnl = totalRealizedPnlMicros / 1_000_000;
    const totalCostBasisMicros = costBasisMicrosForAllocations(taggedAllocations, taggedTrades).reduce(
      (sum, c) => sum + c,
      0
    );

    results.push({
      tag,
      tradeCount: tradeIds.size,
      closedAllocationCount: taggedAllocations.length,
      winRate: winRate(taggedAllocations, taggedTrades),
      profitFactor: profitFactor(taggedAllocations, taggedTrades),
      totalRealizedPnl,
      avgRealizedPnl: taggedAllocations.length > 0 ? totalRealizedPnl / taggedAllocations.length : 0,
      totalRealizedReturnPct: totalCostBasisMicros > 0 ? (totalRealizedPnlMicros / totalCostBasisMicros) * 100 : 0,
    });
  }

  return results.sort((a, b) => b.totalRealizedPnl - a.totalRealizedPnl);
}

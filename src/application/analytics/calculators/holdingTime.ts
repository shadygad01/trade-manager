import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Average days between a Trade's entry and the exit(s) that closed it, weighted by shares closed when a trade was exited in multiple pieces. */
export function holdingTime(allocations: TradeAllocation[], trades: Trade[]): number {
  const tradesById = new Map(trades.map((t) => [t.id, t]));
  let weightedDaysTotal = 0;
  let sharesTotal = 0;
  for (const allocation of allocations) {
    const trade = tradesById.get(allocation.tradeId);
    if (!trade) continue;
    const days = (Date.parse(allocation.executionDate) - Date.parse(trade.executionDate)) / MS_PER_DAY;
    weightedDaysTotal += days * allocation.sharesClosed;
    sharesTotal += allocation.sharesClosed;
  }
  return sharesTotal > 0 ? weightedDaysTotal / sharesTotal : 0;
}

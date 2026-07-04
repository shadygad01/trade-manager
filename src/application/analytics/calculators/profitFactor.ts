import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { realizedPnlMicrosForAllocations } from "./shared";

/** Gross profit / gross loss. Infinity when there are winners and no losers; 0 when there is nothing to divide (no data, or no winners at all). */
export function profitFactor(allocations: TradeAllocation[], trades: Trade[]): number {
  const pnls = realizedPnlMicrosForAllocations(allocations, trades);
  const grossProfit = pnls.filter((p) => p > 0).reduce((sum, p) => sum + p, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((sum, p) => sum + p, 0));
  if (grossLoss === 0) {
    return grossProfit > 0 ? Infinity : 0;
  }
  return grossProfit / grossLoss;
}

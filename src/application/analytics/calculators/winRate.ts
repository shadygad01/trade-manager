import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { realizedPnlMicrosForAllocations } from "./shared";

export function winRate(allocations: TradeAllocation[], trades: Trade[]): number {
  if (allocations.length === 0) return 0;
  const pnls = realizedPnlMicrosForAllocations(allocations, trades);
  const wins = pnls.filter((p) => p > 0).length;
  return (wins / pnls.length) * 100;
}

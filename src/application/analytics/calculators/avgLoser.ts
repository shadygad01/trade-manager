import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { realizedPnlMicrosForAllocations } from "./shared";

/** Average realized P/L across losing allocations only; negative (or 0 if there are none). */
export function avgLoser(allocations: TradeAllocation[], trades: Trade[]): number {
  const losers = realizedPnlMicrosForAllocations(allocations, trades).filter((p) => p < 0);
  if (losers.length === 0) return 0;
  const avgMicros = losers.reduce((sum, p) => sum + p, 0) / losers.length;
  return avgMicros / 1_000_000;
}

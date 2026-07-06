import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { realizedReturnPctForAllocations } from "./shared";

/** Average realized return, as % of cost basis, across losing allocations only; negative (or 0 if there are none). */
export function avgLoser(allocations: TradeAllocation[], trades: Trade[]): number {
  const losers = realizedReturnPctForAllocations(allocations, trades).filter((p) => p < 0);
  if (losers.length === 0) return 0;
  return losers.reduce((sum, p) => sum + p, 0) / losers.length;
}

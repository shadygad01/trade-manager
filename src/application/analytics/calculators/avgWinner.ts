import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { realizedReturnPctForAllocations } from "./shared";

/** Average realized return, as % of cost basis, across winning allocations only. */
export function avgWinner(allocations: TradeAllocation[], trades: Trade[]): number {
  const winners = realizedReturnPctForAllocations(allocations, trades).filter((p) => p > 0);
  if (winners.length === 0) return 0;
  return winners.reduce((sum, p) => sum + p, 0) / winners.length;
}

import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { realizedPnlMicrosForAllocations } from "./shared";

export function avgWinner(allocations: TradeAllocation[], trades: Trade[]): number {
  const winners = realizedPnlMicrosForAllocations(allocations, trades).filter((p) => p > 0);
  if (winners.length === 0) return 0;
  const avgMicros = winners.reduce((sum, p) => sum + p, 0) / winners.length;
  return avgMicros / 1_000_000;
}

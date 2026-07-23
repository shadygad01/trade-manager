import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import type { Trade } from "@domain/entities/Trade";
import { parseTimeToMinutes } from "./duplicateDetection";

/** A sell can only close a lot that already existed when the sell happened. */
export function isLotEligibleForSell(
  lot: Pick<Trade, "executionDate" | "executionTime">,
  sell: Pick<ParsedTradeCandidate, "date" | "time">,
): boolean {
  if (lot.executionDate !== sell.date) return lot.executionDate < sell.date;
  const lotMinutes = parseTimeToMinutes(lot.executionTime);
  const sellMinutes = sell.time ? parseTimeToMinutes(sell.time) : undefined;
  return lotMinutes === undefined || sellMinutes === undefined || lotMinutes <= sellMinutes;
}

/** Whether the verification gate has any real inventory left to evaluate. */
export function hasSharesToReconcile(pendingRowCount: number, existingRemainingShares: number): boolean {
  return pendingRowCount > 0 || Math.abs(existingRemainingShares) >= 1e-6;
}

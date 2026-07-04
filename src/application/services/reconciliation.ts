import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { PositionAggregate } from "./TradeService";

export interface PositionReconciliation {
  ticker: string;
  computedShares: number;
  verifiedUnits: number;
  verifiedAvgCost?: number;
  verificationCapturedAt: string;
  verificationSource: "screenshot" | "manual";
  /** Computed shares exceed the broker's verified units — a duplicate or misparsed trade is likely. */
  quantityMismatch: boolean;
  /** Computed shares fall short of the broker's verified units — the ledger is missing a trade. */
  quantityShortfall: boolean;
  /** A trade/allocation for this ticker was recorded after the screenshot was captured, so a gap is expected, not a bug — mismatch/shortfall are suppressed. */
  verificationStale: boolean;
}

function latestByTicker(verifications: PositionVerification[]): Map<string, PositionVerification> {
  const latest = new Map<string, PositionVerification>();
  for (const v of verifications) {
    const ticker = normalizeTicker(v.ticker);
    const existing = latest.get(ticker);
    if (!existing || v.capturedAt > existing.capturedAt) {
      latest.set(ticker, v);
    }
  }
  return latest;
}

/**
 * Ground-truth reconciliation: compares the trade-ledger-derived position for
 * each ticker against the most recent broker "My Position" screenshot for
 * that ticker. Never mutates the ledger — this only surfaces a discrepancy
 * for the user to investigate (e.g. a duplicate import, or a missing trade).
 */
export function reconcilePositions(
  positions: PositionAggregate[],
  verifications: PositionVerification[],
  trades: Trade[],
  allocations: TradeAllocation[]
): PositionReconciliation[] {
  const verificationByTicker = latestByTicker(verifications);
  const computedByTicker = new Map(positions.map((p) => [p.ticker, p.totalShares]));
  const tickers = new Set([...computedByTicker.keys(), ...verificationByTicker.keys()]);

  const results: PositionReconciliation[] = [];
  for (const ticker of tickers) {
    const verification = verificationByTicker.get(ticker);
    if (!verification) continue;

    const computedShares = computedByTicker.get(ticker) ?? 0;

    // Timestamps are plain "YYYY-MM-DDTHH:MM" / ISO strings, not Date objects
    // — string comparison is safe here because both are zero-padded and
    // share the same YYYY-MM-DD prefix ordering.
    const hasNewerActivity =
      trades.some(
        (t) => normalizeTicker(t.ticker) === ticker && `${t.executionDate}T${t.executionTime}` > verification.capturedAt
      ) ||
      allocations.some(
        (a) => normalizeTicker(a.ticker) === ticker && `${a.executionDate}T${a.executionTime}` > verification.capturedAt
      );

    results.push({
      ticker,
      computedShares,
      verifiedUnits: verification.units,
      verifiedAvgCost: verification.avgCost,
      verificationCapturedAt: verification.capturedAt,
      verificationSource: verification.source,
      quantityMismatch: !hasNewerActivity && computedShares > verification.units,
      quantityShortfall: !hasNewerActivity && computedShares < verification.units,
      verificationStale: hasNewerActivity,
    });
  }
  return results;
}

/**
 * When a ticker's computed share count exceeds the broker's verified units
 * (quantityMismatch), one of the open trades is almost always the extra fill
 * from a duplicate import. The same real trade parsed from two documents
 * tends to differ only by which one's price rounding won, so the
 * lower-priced read is the more likely duplicate to delete, leaving the
 * higher (more plausible, post-commission) price on the ledger. Only
 * considers trades with nothing sold against them yet — a partially/fully
 * closed trade can't be deleted outright.
 */
export function suggestDuplicateTradeId(openTrades: { id: string; entryPrice: number; shares: number; remainingShares: number }[]): string | undefined {
  const deletable = openTrades.filter((t) => t.remainingShares === t.shares);
  if (deletable.length === 0) return undefined;
  return deletable.reduce((lowest, t) => (t.entryPrice < lowest.entryPrice ? t : lowest)).id;
}

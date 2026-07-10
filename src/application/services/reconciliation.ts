import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { PositionAggregate } from "./TradeService";
import { checkTickerMatch } from "./importVerification";
import { suggestRemovalsToReconcile, MAX_RECONCILE_ROWS, type ReconcilableRow } from "./mismatchResolver";

export interface PositionReconciliation {
  ticker: string;
  /** The specific PositionVerification record this reconciliation is based on — lets the UI offer a direct delete for a stray/misfiled verification (see PortfolioDetailPage's "no recorded trades" banner). */
  verificationId: string;
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

/** The most recent PositionVerification per ticker — the same "which broker screenshot is ground truth" reduction reused by ledgerRebuild.ts's holdings diff. */
export function latestByTicker(verifications: PositionVerification[]): Map<string, PositionVerification> {
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
 *
 * The actual match/mismatch judgment is delegated to checkTickerMatch — the
 * same canonical function Import's live commit gate and the Evidence
 * Intelligence facade both use — instead of a second, independently
 * hand-rolled comparison. Everything already committed for this ticker is
 * treated as a single settled amount (existingRemainingShares =
 * computedShares, no separate "pending" batch — there is none once trades
 * are committed), so checkTickerMatch's netShares reduces to exactly
 * computedShares here. `verificationStale` — a real, additional concern
 * checkTickerMatch has no equivalent for (it always compares "as of right
 * now," with no notion of a screenshot predating trades recorded since) —
 * remains this module's own, layered on top: a mismatch a newer trade would
 * fully explain is suppressed rather than reported as a live discrepancy.
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

    const match = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 0,
      existingRemainingShares: computedShares,
      verifiedUnits: verification.units,
      verifiedAvgCost: verification.avgCost,
    });

    results.push({
      ticker,
      verificationId: verification.id,
      computedShares,
      verifiedUnits: verification.units,
      verifiedAvgCost: verification.avgCost,
      verificationCapturedAt: verification.capturedAt,
      verificationSource: verification.source,
      quantityMismatch: !hasNewerActivity && match.discrepancySide === "buy" && !match.matched,
      quantityShortfall: !hasNewerActivity && match.discrepancySide === "sell" && !match.matched,
      verificationStale: hasNewerActivity,
    });
  }
  return results;
}

/**
 * When a ticker's computed share count exceeds the broker's verified units
 * (quantityMismatch), one or more of the open trades is almost always an
 * extra fill from a duplicate import — the same statement re-uploaded more
 * than once produces more than one duplicate of the same real trade, not
 * just one. The same real trade parsed from two documents tends to differ
 * only by which one's price rounding won, so the lower-priced reads are the
 * more likely duplicates to delete, leaving the highest (most plausible,
 * post-commission) price on the ledger.
 *
 * Returns every trade needed to close the whole gap in one pass — not just
 * the single lowest-priced one — by removing lowest-priced deletable trades
 * (nothing sold against them yet) until computed shares reach the verified
 * count. Skips a trade that would remove more shares than the remaining gap
 * (which would turn the mismatch into a shortfall instead of resolving it)
 * and tries the next-lowest-priced one instead, so a caller can safely
 * delete every returned id without ever overshooting.
 */
export function suggestDuplicateTradeIds(params: {
  openTrades: { id: string; entryPrice: number; shares: number; remainingShares: number }[];
  computedShares: number;
  verifiedUnits: number;
  verifiedAvgCost?: number;
}): string[] {
  const deletable = [...params.openTrades].filter((t) => t.remainingShares === t.shares);

  // Prefer the canonical, avg-cost-ranked, alternatives-aware solver
  // (mismatchResolver.suggestRemovalsToReconcile — the same one Import's own
  // reconcile banner uses) only when it actually has a ranking signal to
  // exploit (a broker-verified avg cost) and its exhaustive-subset search
  // can cover every deletable trade. Without an avg cost, that solver has NO
  // price-preference signal at all and picks an arbitrary valid subset —
  // strictly worse than this module's own lowest-price-first heuristic,
  // which encodes a real, sound rule for exactly this common case (the same
  // real trade re-read from a duplicate document differs mostly in price
  // rounding; the lower reads are the more likely duplicates, leaving the
  // highest, most-plausible post-commission price on the ledger). So the
  // greedy heuristic remains primary whenever there's no avg cost to rank
  // by, and is also the fallback above MAX_RECONCILE_ROWS (2^n search),
  // where the canonical solver declines to run at all.
  if (params.verifiedAvgCost !== undefined && deletable.length > 0 && deletable.length <= MAX_RECONCILE_ROWS) {
    const rows: ReconcilableRow[] = deletable.map((t) => ({ key: t.id, side: "BUY", shares: t.shares, price: t.entryPrice }));
    const suggestion = suggestRemovalsToReconcile({
      rows,
      existingRemainingShares: 0,
      verifiedUnits: params.verifiedUnits,
      verifiedAvgCost: params.verifiedAvgCost,
    });
    if (suggestion) return suggestion.keysToRemove;
  }

  const sorted = [...deletable].sort((a, b) => a.entryPrice - b.entryPrice);
  const ids: string[] = [];
  let remaining = params.computedShares;
  for (const t of sorted) {
    if (remaining <= params.verifiedUnits) break;
    if (remaining - t.shares < params.verifiedUnits) continue;
    ids.push(t.id);
    remaining -= t.shares;
  }
  return ids;
}

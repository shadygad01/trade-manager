import type { Trade } from "@domain/entities/Trade";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { deleteTrade } from "./TradeService";
import type { CommitEngineRepos } from "./commitEngine";
import type { AppRepositories } from "./types";

/**
 * Real, reproduced bug (user-reported, traced by inspecting the Trades page
 * directly): re-uploading the same broker Excel export across separate
 * sessions committed the SAME real Buy execution as a brand-new `Trade` row
 * each time, instead of being recognized as a duplicate — every affected
 * lot ends up with two (or more) identical `Trade` rows sharing the exact
 * same ticker/date/time/shares/price. `duplicateMatch`/`findDuplicateBuyMatch`
 * (duplicateDetection.ts) is confirmed working correctly for TODAY's imports
 * (every re-upload in this session correctly reported "N duplicate
 * transaction(s) skipped and hidden") — these specific duplicates predate
 * that detection actually running against them, so this is a one-time
 * cleanup for existing residue, not a fix to the detection logic itself.
 *
 * The inflated `remainingShares` across every duplicate copy is exactly why
 * a genuinely fully-closed position (confirmed against the broker's own
 * order history) still shows shares open in Holdings: some duplicate PAIRS
 * had their Sell correctly applied to only ONE copy, leaving the other
 * copy's full share count permanently stuck open.
 */

export interface DuplicateTradeGroup {
  /** Grouping key fields, for display only. */
  ticker: string;
  executionDate: string;
  executionTime: string;
  shares: number;
  entryPrice: number;
  portfolioId: string;
  /** The trade(s) kept — never touched by this cleanup. */
  keep: Trade[];
  /** The trade(s) safe to delete — every one of these has `remainingShares === shares` (deleteTrade's own guard already refuses anything else), so deleting them can never corrupt realized P&L or orphan an allocation. */
  removable: Trade[];
  /** True when the group has more than one trade with DIFFERING remainingShares (e.g. two independently partial-sold copies) — genuinely ambiguous which one is the "real" one, so nothing in the group is touched. Surfaced for manual review instead. */
  ambiguous: boolean;
}

function groupKey(t: Trade): string {
  return `${t.portfolioId}|${normalizeTicker(t.ticker)}|${t.executionDate}|${t.executionTime}|${t.shares}|${t.entryPrice}`;
}

/**
 * Pure grouping/classification — never touches the database. Two trades are
 * considered exact duplicates only when EVERY ONE of ticker/portfolio/
 * execution date/execution time (to the minute)/shares/entry price agree —
 * the same identity `duplicateMatch`'s "exact" tier already uses at import
 * time, deliberately excluding `timesConflict`'s tolerance so a genuine
 * twin lot (two real fills at a different minute, the documented,
 * legitimate case this app's own ledger architecture already accounts for)
 * is never merged.
 */
export function findDuplicateTradeGroups(trades: Trade[]): DuplicateTradeGroup[] {
  const byKey = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = groupKey(t);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(t);
    else byKey.set(key, [t]);
  }

  const groups: DuplicateTradeGroup[] = [];
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    const touched = bucket.filter((t) => t.remainingShares !== t.shares);
    const untouched = bucket.filter((t) => t.remainingShares === t.shares);

    const distinctTouchedStates = new Set(touched.map((t) => t.remainingShares)).size;
    const ambiguous = distinctTouchedStates > 1;

    const first = bucket[0];
    if (ambiguous) {
      groups.push({
        ticker: normalizeTicker(first.ticker),
        executionDate: first.executionDate,
        executionTime: first.executionTime,
        shares: first.shares,
        entryPrice: first.entryPrice,
        portfolioId: first.portfolioId,
        keep: bucket,
        removable: [],
        ambiguous: true,
      });
      continue;
    }

    // Exactly zero or one distinct touched state: keep one representative
    // (the touched one if any trade in the group has real sell history,
    // otherwise the first untouched copy), remove every other untouched copy.
    const keep = touched.length > 0 ? [touched[0], ...touched.slice(1)] : [untouched[0]];
    const keepIds = new Set(keep.map((t) => t.id));
    const removable = untouched.filter((t) => !keepIds.has(t.id));
    if (removable.length === 0) continue;

    groups.push({
      ticker: normalizeTicker(first.ticker),
      executionDate: first.executionDate,
      executionTime: first.executionTime,
      shares: first.shares,
      entryPrice: first.entryPrice,
      portfolioId: first.portfolioId,
      keep,
      removable,
      ambiguous: false,
    });
  }

  return groups.sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.executionDate.localeCompare(b.executionDate),
  );
}

export interface DuplicateTradeCleanupReport {
  groupsFound: number;
  tradesDeleted: number;
  ambiguousGroups: DuplicateTradeGroup[];
  errors: { tradeId: string; error: string }[];
}

/**
 * Applies the cleanup `findDuplicateTradeGroups` identified — deletes every
 * `removable` trade via the real, unmodified `deleteTrade` (TradeService.ts),
 * reusing its own cash-refund/timeline/raw-transaction-retraction logic
 * exactly as-is rather than re-deriving it. `deleteTrade`'s own guard
 * (refuses anything with `remainingShares !== shares`) is a second,
 * independent safety net on top of this module's own classification — a
 * belt-and-suspenders design, not redundant caution: if this module's
 * classification ever had a bug that let a touched trade through, deleteTrade
 * would still refuse it rather than silently deleting real sell history.
 */
export async function cleanupDuplicateTrades(
  repos: AppRepositories & Partial<CommitEngineRepos>,
  groups: DuplicateTradeGroup[],
): Promise<DuplicateTradeCleanupReport> {
  let tradesDeleted = 0;
  const errors: { tradeId: string; error: string }[] = [];
  const ambiguousGroups = groups.filter((g) => g.ambiguous);

  for (const group of groups) {
    if (group.ambiguous) continue;
    for (const trade of group.removable) {
      try {
        await deleteTrade(repos, trade.id);
        tradesDeleted += 1;
      } catch (err) {
        errors.push({ tradeId: trade.id, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  }

  return {
    groupsFound: groups.filter((g) => !g.ambiguous).length,
    tradesDeleted,
    ambiguousGroups,
    errors,
  };
}

export interface NetShareTimelineRow {
  key: string;
  side: "BUY" | "SELL";
  shares: number;
  date: string;
}

export interface LastBalancedPoint {
  /** The last date (ISO) at which the running net share count (existing ledger + every pending row so far) last landed on exactly 0 — every row up to and including this date reconciles a fully closed position. */
  date: string;
  /** Every still-pending row's key on or before that date, in chronological order. */
  keysUpToHere: string[];
}

/**
 * A ticker stuck on "no-verification" (no broker screenshot, net shares not
 * 0) is usually not wrong everywhere — the real gap is almost always
 * confined to a specific stretch of dates, with everything before it a
 * perfectly clean re-read. Walking pending rows in chronological order,
 * starting the running net share count from whatever's already on the
 * ledger, finds the LAST point that running total returns to exactly 0 —
 * the same target checkTickerMatch's own "closed-position" branch checks.
 * Every row up to there genuinely nets a fully closed position; whatever's
 * wrong (a missing Sell, a misread Buy, an uncaught duplicate) only ever
 * lives after that date. Deterministic — no combinatorial guessing about
 * which subset of rows to blame (see mismatchResolver.ts for that, and why
 * it doesn't scale past a handful of rows) — this is exact arithmetic that
 * either finds a genuine reconciliation point or it doesn't.
 *
 * Returns undefined when no such point exists (the imbalance started from
 * the very first row) or when the only zero-crossing is the last row itself
 * (the whole batch already balances — checkTickerMatch's own
 * closed-position branch already covers that case with nothing left to
 * narrow down).
 */
export function findLastBalancedDate(params: {
  rows: NetShareTimelineRow[];
  existingRemainingShares: number;
}): LastBalancedPoint | undefined {
  const { rows, existingRemainingShares } = params;
  if (rows.length === 0) return undefined;

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let running = existingRemainingShares;
  let last: LastBalancedPoint | undefined;
  const seenKeys: string[] = [];

  for (const row of sorted) {
    running += row.side === "BUY" ? row.shares : -row.shares;
    seenKeys.push(row.key);
    if (Math.abs(running) < 1e-6) {
      last = { date: row.date, keysUpToHere: [...seenKeys] };
    }
  }

  if (!last || last.keysUpToHere.length === sorted.length) return undefined;
  return last;
}

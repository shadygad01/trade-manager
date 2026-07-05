import type { OrderRowsParseResult, OrdersScreenParseResult } from "./parsers/BrokerParser";

type OrdersResult = OrdersScreenParseResult | OrderRowsParseResult;

/**
 * Fulfilled orders visible on screen that neither became candidates nor were
 * deliberately excluded as out-of-range — i.e. genuinely lost by the parse.
 * Out-of-range exclusions are subtracted because they already get their own
 * dedicated warning; counting them here too would double-report them as
 * "missing" when nothing was actually misread.
 */
export function missingFulfilledCount(result: OrdersResult): number {
  return Math.max(0, result.fulfilledStatusCount - result.candidates.length - (result.outOfRangeCount ?? 0));
}

function problemScore(result: OrdersResult): number {
  return missingFulfilledCount(result) + result.incompleteRowCount + (result.statusCountMismatch ? 1 : 0);
}

/**
 * True when the flat parse's own signals say it lost or mispaired at least
 * one row. The row-isolated re-scan used to run only on a totally empty flat
 * result, which meant a clear screenshot parsed 4-of-5 just produced a
 * "1 may be missing" warning instead of ever trying the more reliable path —
 * a partial flat result is exactly as much a reason to re-scan as an empty one.
 */
export function flatResultIsDeficient(flat: OrdersScreenParseResult): boolean {
  return flat.candidates.length === 0 || problemScore(flat) > 0;
}

/**
 * The row scan replaces the flat result only when switching cannot lose a
 * trade the flat parse already had: it understood at least one row, and it
 * either recovered strictly more candidates or matched the count with fewer
 * unresolved problems.
 */
export function shouldPreferRowScan(flat: OrdersScreenParseResult, row: OrderRowsParseResult): boolean {
  if (row.resolvedRowCount === 0) return false;
  if (flat.candidates.length === 0) return true;
  if (row.candidates.length > flat.candidates.length) return true;
  return row.candidates.length === flat.candidates.length && problemScore(row) < problemScore(flat);
}

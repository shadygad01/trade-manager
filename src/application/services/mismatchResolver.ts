import { Money } from "@domain/value-objects/Money";
import type { ParseConfidence } from "@domain/entities/Upload";

export interface ReconcilableRow {
  key: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  confidence?: ParseConfidence;
}

export interface ReconcileSuggestion {
  keysToRemove: string[];
  /** How many other subsets also reconcile exactly — 0 means this is the only possible fix. */
  alternatives: number;
  /** True when the broker's avg cost was usable to rank the candidate subsets (see suggestRemovalsToReconcile). */
  rankedByAvgCost: boolean;
}

/** Exhaustive-subset search cap — above this the solver doesn't attempt (2^n). Exported so the UI never claims "no subset explains it" for batches the solver never actually searched. */
export const MAX_RECONCILE_ROWS = 16;

function confidenceRank(c?: ParseConfidence): number {
  if (c === "low") return 0;
  if (c === "medium") return 1;
  return 2;
}

/**
 * Solves a Mismatch the row-level heuristics can't explain: given a ticker's
 * still-pending rows and the broker's verified unit count (the trusted
 * source), finds which subset of rows to remove so the remaining total
 * reconciles exactly. None of the duplicate/cross-source checks can name the
 * wrong row when it isn't a literal duplicate of anything — but the share
 * arithmetic itself narrows it down, and the broker screenshot usually
 * carries a second, independently-verifiable number: the position's avg
 * cost. When several subsets reconcile the count, the one whose remaining
 * position lands closest to that avg cost is the one the broker's own math
 * agrees with.
 *
 * Ranking, in order: closest implied avg cost (integer-percent buckets, so
 * OCR-level price noise doesn't outweigh the other signals; only when every
 * row is a Buy and the existing lots' cost is known — sells make the implied
 * avg depend on lot selection, which is exactly what ADR-002 refuses to
 * guess); then lowest total OCR confidence of the removed rows (removing a
 * "low" guess is more plausible than removing a "high" anchored read); then
 * fewest rows removed. Always a suggestion — nothing is removed without the
 * user's click, and `alternatives` tells them when other combinations were
 * possible.
 *
 * Removing every row is never suggested: reconciling by emptying the batch
 * means the ledger alone already matched, which is checkTickerMatch's
 * `alreadyFullyRecorded` case with its own dedicated action.
 */
export function suggestRemovalsToReconcile(params: {
  rows: ReconcilableRow[];
  existingRemainingShares: number;
  existingCostBasis?: number;
  verifiedUnits: number;
  verifiedAvgCost?: number;
}): ReconcileSuggestion | undefined {
  const { rows } = params;
  if (rows.length === 0 || rows.length > MAX_RECONCILE_ROWS) return undefined;

  const rowNet = (r: ReconcilableRow) => (r.side === "BUY" ? r.shares : -r.shares);
  const pendingNet = rows.reduce((sum, r) => sum + rowNet(r), 0);
  const deficit = params.existingRemainingShares + pendingNet - params.verifiedUnits;
  if (Math.abs(deficit) < 1e-6) return undefined;

  const canRankByAvgCost =
    params.verifiedAvgCost !== undefined &&
    params.verifiedAvgCost > 0 &&
    rows.every((r) => r.side === "BUY") &&
    (params.existingRemainingShares === 0 || params.existingCostBasis !== undefined);

  const avgCostBucket = (removedMask: number): number => {
    if (!canRankByAvgCost) return 0;
    let keptCost = Money.from(params.existingCostBasis ?? 0);
    let keptShares = params.existingRemainingShares;
    for (let i = 0; i < rows.length; i++) {
      if (removedMask & (1 << i)) continue;
      keptCost = keptCost.add(Money.from(rows[i].price).multiply(rows[i].shares));
      keptShares += rows[i].shares;
    }
    if (keptShares <= 0) return Number.MAX_SAFE_INTEGER;
    const impliedAvg = keptCost.divide(keptShares).toNumber();
    return Math.round((Math.abs(impliedAvg - params.verifiedAvgCost!) / params.verifiedAvgCost!) * 100);
  };

  let best: { mask: number; score: [number, number, number] } | undefined;
  let solutionCount = 0;
  const fullMask = (1 << rows.length) - 1;

  for (let mask = 1; mask < fullMask; mask++) {
    let removedNet = 0;
    let removedConfidence = 0;
    let removedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!(mask & (1 << i))) continue;
      removedNet += rowNet(rows[i]);
      removedConfidence += confidenceRank(rows[i].confidence);
      removedCount++;
    }
    if (Math.abs(removedNet - deficit) >= 1e-6) continue;

    solutionCount++;
    const score: [number, number, number] = [avgCostBucket(mask), removedConfidence, removedCount];
    if (
      !best ||
      score[0] < best.score[0] ||
      (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))
    ) {
      best = { mask, score };
    }
  }

  if (!best) return undefined;
  const keysToRemove = rows.filter((_, i) => best!.mask & (1 << i)).map((r) => r.key);
  return { keysToRemove, alternatives: solutionCount - 1, rankedByAvgCost: canRankByAvgCost };
}

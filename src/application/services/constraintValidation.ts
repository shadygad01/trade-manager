/**
 * Constraint Validation Layer.
 *
 * Sits ABOVE the existing reconciliation engine (checkTickerMatch,
 * mismatchResolver, netShareTimeline, duplicateDetection, orderEvidence) —
 * it consumes their already-computed outputs as FACTS and never re-derives
 * or replaces any of their matching/duplicate-detection logic. Its only job
 * is to separate two questions that used to arrive pre-mixed in a single
 * banner string: "do the facts mathematically add up" (a Contradiction, or
 * none) from "why might they not" (a Diagnosis) — and to enforce that the
 * second question is only ever asked once the first has already found a
 * contradiction. See docs/ROADMAP.md's "Constraint Validation Layer" entry.
 */

const EPSILON = 1e-6;

export interface InventoryFacts {
  ticker: string;
  /** Shares already on the ledger before this Import batch (the "opening position" for this batch's arithmetic). */
  openingShares: number;
  /** Still-pending Buy shares in this batch. */
  buyShares: number;
  /** Still-pending Sell shares in this batch. */
  sellShares: number;
  /** openingShares + buyShares - sellShares. This codebase tracks no corporate-action share adjustments (Split/RightsIssue are record-only, see PortfolioService.recordSplit) — a corporate action term would be added here if that ever changes. */
  calculatedRemaining: number;
  /** The broker's independently-verified "Holdings" count for this ticker (PositionVerification.units), when one exists. */
  holdingsRemaining?: number;
  /** A closed position (calculatedRemaining == 0) never has Holdings to compare against — a broker "My Position" screenshot never lists a zero position, so its absence is expected. */
  closed: boolean;
}

export function buildInventoryFacts(
  ticker: string,
  status: { existingRemainingShares?: number; pendingBuyShares?: number; pendingSellShares?: number; netShares: number; verifiedUnits?: number },
): InventoryFacts {
  const openingShares = status.existingRemainingShares ?? 0;
  const buyShares = status.pendingBuyShares ?? 0;
  const sellShares = status.pendingSellShares ?? 0;
  return {
    ticker,
    openingShares,
    buyShares,
    sellShares,
    calculatedRemaining: status.netShares,
    holdingsRemaining: status.verifiedUnits,
    closed: Math.abs(status.netShares) < EPSILON,
  };
}

export interface InventoryContradiction {
  kind: "inventory";
  ticker: string;
  expected: number;
  calculated: number;
  difference: number;
}

/**
 * The Global Inventory Check: an open position's calculated remaining must
 * equal the broker's Holdings exactly; a closed position requires no
 * Holdings at all. Returns the objective, arithmetic contradiction — never a
 * guess about its cause. Empty array means the constraint is satisfied.
 */
export function evaluateInventoryConstraint(facts: InventoryFacts): InventoryContradiction[] {
  if (facts.closed) return [];
  if (facts.holdingsRemaining === undefined) return [];
  if (Math.abs(facts.calculatedRemaining - facts.holdingsRemaining) < EPSILON) return [];
  return [
    {
      kind: "inventory",
      ticker: facts.ticker,
      expected: facts.holdingsRemaining,
      calculated: facts.calculatedRemaining,
      difference: facts.calculatedRemaining - facts.holdingsRemaining,
    },
  ];
}

export interface DiagnosisHypothesis {
  explanation: string;
  confidence: "high" | "medium" | "low";
}

/**
 * Everything the existing engine already independently computed that CAN
 * explain a contradiction, once one exists. Each field is a plain fact/count
 * this layer reads back — none of it is recomputed here.
 */
export interface DiagnosisInputs {
  /** mismatchResolver.suggestRemovalsToReconcile's result for this ticker, if any. */
  reconcileSuggestion?: { keysToRemove: string[]; alternatives: number };
  /** netShareTimeline.findLastBalancedDate's result for this ticker, if any. */
  lastBalancedDate?: { date: string };
  /** Count of duplicateDetection.findWrongTickerCandidateKeys hints touching this ticker's pending rows. */
  wrongTickerHintCount?: number;
  /** Count of duplicateDetection.findDateMisreadDuplicateHints touching this ticker's pending rows. */
  dateMisreadHintCount?: number;
  /** Count of orderEvidence.findOrphanedFulfilledEvidence entries for this ticker. */
  orphanedOrderEvidenceCount?: number;
  /** checkTickerMatch's own discrepancySide, when present. */
  discrepancySide?: "buy" | "sell";
}

/**
 * Diagnosis always runs AFTER contradiction detection, and only when a
 * contradiction actually exists — never before, never speculatively. Maps
 * already-computed corroboration/duplicate/timeline signals to plain-English
 * hypotheses with a confidence label, ranked most-specific/most-confident
 * first. Falls back to the single most generic hypothesis (which side of the
 * ledger the surplus/shortage sits on) only when nothing more specific fired.
 */
export function diagnoseInventoryContradiction(
  contradictions: InventoryContradiction[],
  inputs: DiagnosisInputs,
): DiagnosisHypothesis[] {
  if (contradictions.length === 0) return [];

  const hypotheses: DiagnosisHypothesis[] = [];

  if (inputs.reconcileSuggestion && inputs.reconcileSuggestion.keysToRemove.length > 0) {
    hypotheses.push({
      explanation: "A duplicate or misread transaction among the still-pending rows accounts for the exact difference",
      confidence: inputs.reconcileSuggestion.alternatives === 0 ? "high" : "medium",
    });
  }
  if ((inputs.orphanedOrderEvidenceCount ?? 0) > 0) {
    hypotheses.push({
      explanation: "The broker's Orders history records a fulfilled transaction for this ticker not represented by any row here — likely a missing historical import",
      confidence: "medium",
    });
  }
  if ((inputs.wrongTickerHintCount ?? 0) > 0) {
    hypotheses.push({
      explanation: "One or more rows may be the same execution misfiled under the wrong ticker",
      confidence: "medium",
    });
  }
  if ((inputs.dateMisreadHintCount ?? 0) > 0) {
    hypotheses.push({
      explanation: "A row's date may have been misread by OCR, duplicating a trade already on the ledger",
      confidence: "medium",
    });
  }
  if (inputs.lastBalancedDate) {
    hypotheses.push({
      explanation: `Every row through ${inputs.lastBalancedDate.date} reconciles exactly — the discrepancy originates after that date`,
      confidence: "high",
    });
  }

  if (hypotheses.length === 0 && inputs.discrepancySide) {
    hypotheses.push({
      explanation:
        inputs.discrepancySide === "sell"
          ? "Ledger is missing a historical Buy transaction"
          : "An extra or duplicate Buy transaction is likely already on the ledger",
      confidence: "low",
    });
  }

  return hypotheses;
}

export interface TickerConstraintReport {
  ticker: string;
  facts: InventoryFacts;
  satisfied: boolean;
  contradictions: InventoryContradiction[];
  diagnosis: DiagnosisHypothesis[];
}

/**
 * Composes the three stages end-to-end for one ticker: facts, then
 * contradiction, then (only if unsatisfied) diagnosis. The single entry
 * point UI code should call — see ImportPage's TickerGroupCard.
 */
export function buildTickerConstraintReport(
  ticker: string,
  status: { existingRemainingShares?: number; pendingBuyShares?: number; pendingSellShares?: number; netShares: number; verifiedUnits?: number },
  diagnosisInputs: DiagnosisInputs,
): TickerConstraintReport {
  const facts = buildInventoryFacts(ticker, status);
  const contradictions = evaluateInventoryConstraint(facts);
  const diagnosis = diagnoseInventoryContradiction(contradictions, diagnosisInputs);
  return { ticker, facts, satisfied: contradictions.length === 0, contradictions, diagnosis };
}

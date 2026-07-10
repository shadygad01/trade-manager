import { verifyAllDetailed, verifyTicker, type TickerStatus, type VerifyAllParams } from "./verificationEngine";

/**
 * Historical Ledger Completeness Engine. A different question than
 * VerificationEngine's own: verification asks "does this ticker's evidence
 * agree with itself right now" (Verified/Rejected/Needs Review per
 * transaction). This engine asks "is the ticker's HISTORY complete" — could a
 * real buy or sell have happened that was never captured by any document at
 * all, leaving no trace for VerificationEngine to even evaluate.
 *
 * Pure interpretive layer: takes TickerStatus (already computed by
 * verifyAllDetailed/verifyTicker — netShares, existingRemainingShares,
 * verifiedUnits, reason, lastBalancedDate, orphanedOrderEvidence) as input and
 * never recomputes any of it. No changes to verificationEngine.ts were made
 * or are needed — every field this module reads already existed on
 * TickerStatus before this file was written.
 *
 * The one rule this engine exists to enforce that VerificationEngine's own
 * fold rule deliberately does NOT: a closed position (net shares = 0) with no
 * independent corroboration is never treated as trustworthy history, only as
 * an arithmetic coincidence — see classify() and its doc comment.
 */

export type LedgerCompletenessStatus = "Verified" | "Complete" | "Incomplete" | "Unknown";

export interface MissingWindow {
  /** The last date this ticker's running share count reconciled to exactly zero (see netShareTimeline.findLastBalancedDate) — the gap starts immediately after this. */
  from: string;
  /** The latest date any orphaned Orders-history evidence names — a real, evidence-backed upper bound. Undefined when no such evidence exists: the gap's true end is unknown and could extend to the present. */
  to?: string;
}

export type EvidenceDocumentType = "Orders History" | "Broker Statement" | "Invoice" | "Transactions" | "My Position";

/**
 * estimatedRecoverySuccess is a documented heuristic CONFIDENCE TIER
 * reflecting evidence strength (direct evidence vs. a bounded arithmetic gap
 * vs. an unbounded one) — see RECOVERY_CONFIDENCE. It is not a calibrated
 * statistical or ML prediction; nothing in this codebase has ever measured a
 * real recovery-success rate, and this module does not claim to.
 */
export interface RecoveryPlan {
  bestEvidence: EvidenceDocumentType;
  alternativeEvidence?: EvidenceDocumentType;
  estimatedRecoverySuccess: number;
  rationale: string;
}

export interface TickerCompletenessReport {
  ticker: string;
  status: LedgerCompletenessStatus;
  /** 0-100. Meaningful only alongside `status` — see completenessScore()'s doc comment for what each status's number actually means. */
  completeness: number;
  missingWindow?: MissingWindow;
  estimatedMissingTransactions?: number;
  estimatedMissingShares?: number;
  /** Present only when status is "Incomplete" — nothing to recover for Verified/Complete, and nothing to plan around for Unknown (there's no data to act on yet). */
  recoveryPlan?: RecoveryPlan;
}

const RECOVERY_CONFIDENCE = {
  /** Orphaned Orders-history evidence directly names the missing transaction's ticker/side/shares/date — recovering it is a lookup, not a search. */
  directEvidence: 90,
  /** The gap is bounded to a specific date range (findLastBalancedDate found a zero-crossing) but no document has named the missing transaction yet. */
  boundedGap: 60,
  /** No point in the ticker's history reconciles to zero at all — the gap isn't confined to any range this engine can name. */
  unboundedGap: 25,
} as const;

/**
 * The one rule this whole engine exists to enforce (requirement: "Closed
 * positions must never be considered complete simply because Net Shares =
 * 0"). checkTickerMatch's own "closed-position" reason is a legitimate,
 * useful VERIFICATION shortcut (a real broker Holdings screen can never list
 * a zero-unit position, so it correctly stops asking for one) — but
 * COMPLETENESS is a stricter question: a batch missing an equal, canceling
 * buy+sell pair nets to zero exactly the same way a genuinely complete
 * closed position does, and nothing about the arithmetic can tell them
 * apart. So "closed-position" alone maps to Incomplete here, never Complete
 * — the real historical cases this was written from (JUFO, SKPC; see
 * docs/ROADMAP.md) are exactly this shape. Complete is reserved for reasons
 * that mean a SECOND, independent source corroborated every row
 * (invoice-verified/cross-verified/orders-verified) — real independent
 * evidence, not just self-consistent numbers.
 */
function classify(status: TickerStatus): LedgerCompletenessStatus {
  if (status.reason === "no-shares-to-verify") return "Unknown";
  if (status.reason === "matched") return "Verified";
  if (status.reason === "invoice-verified" || status.reason === "cross-verified" || status.reason === "orders-verified") return "Complete";
  if (status.reason === "closed-position" || status.reason === "mismatch" || status.reason === "no-verification") return "Incomplete";
  return "Unknown";
}

/** How far a ticker's net position sits from the only independent count available, or from zero when none exists at all. */
function gapMagnitude(status: TickerStatus): number {
  if (status.verifiedUnits !== undefined) return Math.abs(status.netShares - status.verifiedUnits);
  return Math.abs(status.netShares);
}

/** A proxy for "how much real trading activity this ticker represents" — existing ledger shares plus this batch's own buy/sell volume, all fields already on TickerStatus. */
function totalVolume(status: TickerStatus): number {
  return (status.existingRemainingShares ?? 0) + (status.pendingBuyShares ?? 0) + (status.pendingSellShares ?? 0);
}

/**
 * Incomplete's score is the gap's magnitude relative to the ticker's own
 * trading volume, subtracted from a ceiling — direct evidence of a missing
 * transaction (orphanedOrderEvidence) caps lower (60) than an inferred-only
 * gap (85), since "we have proof" is a stronger incompleteness signal than
 * "the arithmetic doesn't add up." Deterministic and fully explainable from
 * TickerStatus's own fields — no hidden model, no fabricated precision.
 */
function incompleteScore(status: TickerStatus): number {
  const volume = totalVolume(status);
  const gap = gapMagnitude(status);
  const relativeGap = volume > 0 ? gap / volume : 1;
  const ceiling = status.orphanedOrderEvidence.length > 0 ? 60 : 85;
  return Math.max(0, Math.round(ceiling * (1 - Math.min(1, relativeGap))));
}

function completenessScore(status: TickerStatus, classification: LedgerCompletenessStatus): number {
  if (classification === "Verified") return 100;
  if (classification === "Complete") return 90;
  if (classification === "Unknown") return 0;
  return incompleteScore(status);
}

function missingWindow(status: TickerStatus): MissingWindow | undefined {
  if (!status.lastBalancedDate) return undefined;
  const orphanedDates = status.orphanedOrderEvidence
    .map((e) => e.date)
    .filter((d): d is string => d !== undefined)
    .sort();
  return { from: status.lastBalancedDate.date, to: orphanedDates.length > 0 ? orphanedDates[orphanedDates.length - 1] : undefined };
}

/**
 * Direct evidence (an orphaned, broker-authored order-history row) gives an
 * exact, non-estimated count and share total — read straight off the
 * evidence, not guessed. Absent that, a real independent count
 * (verifiedUnits) only ever supports a single conservative "at least one"
 * transaction guess with the raw gap's share magnitude; a closed position
 * with neither has nothing to estimate a magnitude FROM at all (that's the
 * whole point of requirement 6 — it's unverifiable, not partially verified).
 */
function estimateMissing(status: TickerStatus): { transactions?: number; shares?: number } {
  if (status.orphanedOrderEvidence.length > 0) {
    const shares = status.orphanedOrderEvidence.reduce((sum, e) => sum + (e.shares ?? 0), 0);
    return { transactions: status.orphanedOrderEvidence.length, shares: shares > 0 ? shares : undefined };
  }
  if (status.verifiedUnits !== undefined) {
    return { transactions: 1, shares: Math.abs(status.netShares - status.verifiedUnits) };
  }
  return {};
}

/**
 * Whether this ticker currently has real, non-zero shares outstanding — the
 * one fact that gates every "My Position" recommendation below. A broker's
 * "My Position" screen only ever lists tickers it currently holds; asking
 * for one on a CLOSED ticker (net shares = 0) can never be satisfied even in
 * principle, and — more importantly — a My Position screenshot proves only
 * the CURRENT count, never a historical execution, so it can't corroborate a
 * closed ticker's past even if a stale one happened to be on hand. See
 * business rule: "if the ticker is already closed, never request My
 * Position because it cannot prove historical executions."
 */
function isOpenPosition(status: TickerStatus): boolean {
  return Math.abs(status.netShares) >= 1e-6;
}

/**
 * Best-evidence recommendation searches what this ticker's evidence already
 * contains before naming the next document, per business rule "search the
 * existing Evidence Repository first, determine exactly which evidence is
 * missing, request only the smallest missing document." Three real signals
 * drive it: (1) whether direct (orphaned) Orders-history evidence already
 * names the missing transaction, (2) whether a bounded gap window was found,
 * and (3) whether the ticker is currently open or closed — which alone
 * decides whether "My Position" is ever a legal answer.
 *
 * TickerStatus still has no "was Orders History ever uploaded for this
 * ticker at all, and did it simply not cover the missing window" flag (only
 * which rows came back unmatched) — a ticker whose Orders History doesn't
 * cover the gap still reads identically to one that never had Orders History
 * uploaded at all. Fully closing that gap needs the Evidence Repository to
 * answer "which document types has this ticker ever seen" directly (see
 * Phase 5 — persisting original documents), not just which rows matched.
 * Documented as a known simplification, not hidden.
 */
function recoveryPlan(status: TickerStatus, classification: LedgerCompletenessStatus): RecoveryPlan | undefined {
  if (classification !== "Incomplete") return undefined;
  const open = isOpenPosition(status);

  if (status.orphanedOrderEvidence.length > 0) {
    return {
      bestEvidence: "Broker Statement",
      alternativeEvidence: "Invoice",
      estimatedRecoverySuccess: RECOVERY_CONFIDENCE.directEvidence,
      rationale: "Orders History already names the missing transaction's ticker/side/shares/date — a Statement or Invoice for that date closes the gap directly.",
    };
  }
  // Open with no independent broker count at all (never "mismatch" — that
  // reason means a count already exists) — the single most direct document
  // is the broker's own current-holdings screen, per business rule "if the
  // ticker is still open, request My Position."
  if (open && status.reason === "no-verification") {
    return {
      bestEvidence: "My Position",
      alternativeEvidence: "Orders History",
      estimatedRecoverySuccess: status.lastBalancedDate ? RECOVERY_CONFIDENCE.boundedGap : RECOVERY_CONFIDENCE.unboundedGap,
      rationale: "This position is still open and no broker holdings count has ever been supplied — a \"My Position\" screenshot confirms the current unit count directly, the single fact this ticker is missing.",
    };
  }
  if (status.lastBalancedDate) {
    return {
      // Transactions (account-wide, dated) is the cheaper, more exhaustive
      // ask than Orders History here -- the undated "Orders" timeline shape
      // can't pinpoint a date at all, while the dated "Transactions" list
      // (or an Orders History screenshot for the specific ticker) can. Never
      // My Position for a closed ticker (enforced above); a real "mismatch"
      // already has its broker count, so Orders History (to find WHICH row
      // is wrong) outranks Transactions (which only proves something
      // happened, not what).
      bestEvidence: !open || status.reason === "mismatch" ? "Orders History" : "Transactions",
      alternativeEvidence: "Broker Statement",
      estimatedRecoverySuccess: RECOVERY_CONFIDENCE.boundedGap,
      rationale: `Everything through ${status.lastBalancedDate.date} reconciles exactly -- evidence dated after that date (a Transactions screen, or an Orders History screenshot for this ticker) would show precisely what's missing.`,
    };
  }
  return {
    bestEvidence: "Orders History",
    alternativeEvidence: "Broker Statement",
    estimatedRecoverySuccess: RECOVERY_CONFIDENCE.unboundedGap,
    rationale: "No point in this ticker's history reconciles to zero — the gap isn't confined to a date range; a full account-wide Orders History covering this ticker's entire lifetime is the strongest single document.",
  };
}

/** The single entry point: TickerStatus in, a full completeness report out. Never recomputes anything verifyAllDetailed/verifyTicker didn't already compute. */
export function assessTickerCompleteness(status: TickerStatus): TickerCompletenessReport {
  const classification = classify(status);
  const estimate = classification === "Incomplete" ? estimateMissing(status) : {};
  return {
    ticker: status.ticker,
    status: classification,
    completeness: completenessScore(status, classification),
    missingWindow: classification === "Incomplete" ? missingWindow(status) : undefined,
    estimatedMissingTransactions: estimate.transactions,
    estimatedMissingShares: estimate.shares,
    recoveryPlan: recoveryPlan(status, classification),
  };
}

/** Ticker-level counterpart, mirroring verificationEngine's verifyTicker — one ticker's report, or undefined if it has no Buy/Sell transactions in scope. */
export function assessSingleTicker(ticker: string, params: VerifyAllParams): TickerCompletenessReport | undefined {
  const status = verifyTicker(ticker, params);
  return status ? assessTickerCompleteness(status) : undefined;
}

/** Every ticker in scope, in one call — the batch counterpart to assessSingleTicker. */
export function assessAllTickersCompleteness(params: VerifyAllParams): Map<string, TickerCompletenessReport> {
  const { tickers } = verifyAllDetailed(params);
  const reports = new Map<string, TickerCompletenessReport>();
  for (const [ticker, status] of tickers) reports.set(ticker, assessTickerCompleteness(status));
  return reports;
}

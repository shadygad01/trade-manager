import type { Upload } from "@domain/entities/Upload";
import type { RawTransactionSource } from "@domain/entities/RawTransaction";
import { verifyTicker, type VerifyAllParams } from "./verificationEngine";
import { assessTickerCompleteness, type TickerCompletenessReport, type RecoveryPlan } from "./completenessEngine";
import { buildCoverageClaims } from "./evidenceCoverage";
import { buildEvidenceGraph, type EvidenceGraph } from "./evidenceGraph";
import { buildCanonicalTransactions, type CanonicalTransaction } from "./canonicalTransaction";
import { authorityRank } from "./evidenceAuthority";

/**
 * Evidence Intelligence Layer: the one place these five questions get
 * answered for a ticker — "what is confirmed, what is missing, what is
 * contradictory, which evidence is strongest, which document is required
 * next." Every answer here is delegated, never re-derived:
 *
 * - confirmed/needsReview/rejected  -> canonicalTransaction.buildCanonicalTransactions
 *                                      (itself delegating to verificationEngine)
 * - completeness/recommendedDocument -> completenessEngine.assessTickerCompleteness
 * - graph (corroborates/contradicts/missing) -> evidenceGraph.buildEvidenceGraph
 * - strongestEvidenceSource -> evidenceAuthority.authorityRank over whatever
 *                               sources are actually present for this ticker
 *
 * Nothing in this module computes a verdict, a completeness score, or a
 * recovery plan itself — it composes the three engines that already do,
 * into one call and one report shape, so a caller (or a future UI) never
 * needs to know that "confirmed" lives in verificationEngine while "missing"
 * lives in completenessEngine while "strongest evidence" lives in
 * evidenceAuthority. This is the ONLY reasoning surface a new caller should
 * import from; extending what "business truth" means for a ticker means
 * extending one of the three composed engines, never adding a fourth
 * parallel one here.
 */

export interface EvidenceIntelligenceReport {
  ticker: string;
  /** Every canonical execution whose strongest verdict is "Verified". */
  confirmed: CanonicalTransaction[];
  /** Every canonical execution still "Needs Review" — not yet business truth. */
  needsReview: CanonicalTransaction[];
  /** Every canonical execution "Rejected" (a confident duplicate/contradiction). */
  rejected: CanonicalTransaction[];
  completeness: TickerCompletenessReport;
  /** completeness.recoveryPlan, surfaced at the top level — the Minimal Document Engine's answer to "which document is required next," or undefined when nothing is missing. */
  recommendedDocument: RecoveryPlan | undefined;
  /** Highest-authority document type actually on file for this ticker (see evidenceAuthority.ts) — undefined when the ticker has no Buy/Sell evidence at all. */
  strongestEvidenceSource: RawTransactionSource | undefined;
  graph: EvidenceGraph;
}

/** Answers all five Evidence Intelligence questions for one ticker in a single call. Returns undefined only when the ticker has no Buy/Sell evidence in scope at all (nothing to reason about yet). */
export function getEvidenceIntelligence(ticker: string, params: VerifyAllParams, uploads: Upload[] = []): EvidenceIntelligenceReport | undefined {
  const status = verifyTicker(ticker, params);
  if (!status) return undefined;

  const canonical = buildCanonicalTransactions(ticker, params, uploads);
  const completeness = assessTickerCompleteness(status, buildCoverageClaims(params.transactions));
  const graph = buildEvidenceGraph(ticker, params, uploads);

  const sources = params.transactions
    .filter((t) => (t.kind === "BuyExecution" || t.kind === "SellExecution") && t.ticker !== undefined)
    .map((t) => t.source);
  const strongestEvidenceSource = sources.reduce<RawTransactionSource | undefined>(
    (best, source) => (best === undefined || authorityRank(source) > authorityRank(best) ? source : best),
    undefined,
  );

  return {
    ticker: status.ticker,
    confirmed: canonical.filter((c) => c.currentStatus === "Verified"),
    needsReview: canonical.filter((c) => c.currentStatus === "Needs Review"),
    rejected: canonical.filter((c) => c.currentStatus === "Rejected"),
    completeness,
    recommendedDocument: completeness.recoveryPlan,
    strongestEvidenceSource,
    graph,
  };
}

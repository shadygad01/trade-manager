import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { Upload } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { canonicalKey } from "./ledgerRebuild";
import { verifyAllDetailed, type VerifyAllParams, type VerificationVerdict } from "./verificationEngine";
import { buildEvidenceGraph, type EvidenceEdge } from "./evidenceGraph";
import { higherAuthority } from "./evidenceAuthority";

/**
 * Canonical Transaction Identity: every execution as exactly ONE object,
 * merged from however many documents describe it. Composed entirely from
 * existing engines already producing this data — RawTransaction's own
 * canonicalKey dedup (ledgerRebuild.ts, the same identity ledgerEngine
 * already uses for a Buy/Sell's eventId), verifyAllDetailed (verdict,
 * confidence), and buildEvidenceGraph (which documents corroborate/
 * contradict it, which are missing). Deliberately NOT a new persisted
 * entity/table — see docs/EVIDENCE_ARCHITECTURE.md's reasoning for why the
 * Evidence Graph itself isn't persisted; a second, separately-stored
 * "Canonical Transaction" table would be exactly the kind of parallel
 * implementation this sprint's own instructions say to remove, not add.
 * Two or more RawTransaction rows sharing the same canonicalKey (same
 * ticker/side/date/shares/price) are already the SAME execution by this
 * app's own domain rule — this is a read-only VIEW over that existing
 * identity, not a new merge algorithm.
 */

export interface CanonicalTransaction {
  /** The canonicalKey every RawTransaction describing this execution shares — the same identity ledgerEngine.ts's own eventId already uses. */
  transactionId: string;
  ticker: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  /** From whichever contributing RawTransaction carries the highest Evidence Authority (see evidenceAuthority.ts) — undefined when no contributing fact recorded fees at all. */
  fees?: number;
  taxes?: number;
  date: string;
  time?: string;
  /** The strongest single verdict among every RawTransaction merged into this execution — "Verified" if any is, else "Rejected" if any is, else "Needs Review". */
  confidence: "high" | "medium" | "low" | undefined;
  /** Every RawTransaction id that folds into this one execution. */
  evidenceSources: string[];
  evidenceCount: number;
  /** corroborates/contradicts edges (from buildEvidenceGraph) touching any of this execution's own RawTransaction ids. */
  corroboratingEdges: EvidenceEdge[];
  contradictingEdges: EvidenceEdge[];
  /** True when the ticker's own completeness assessment found a named, missing execution this one does NOT already resolve — see completenessEngine.recoveryPlan.expectedExecution. */
  tickerHasKnownMissingEvidence: boolean;
  currentStatus: VerificationVerdict;
}

function toBuySellPayload(txn: RawTransaction): { side: "BUY" | "SELL"; payload: BuyExecutionPayload | SellExecutionPayload } | undefined {
  if (txn.kind === "BuyExecution") return { side: "BUY", payload: txn.payload as BuyExecutionPayload };
  if (txn.kind === "SellExecution") return { side: "SELL", payload: txn.payload as SellExecutionPayload };
  return undefined;
}

/** Strongest-wins fold: Verified beats Needs Review beats Rejected, matching "what is confirmed" being the most useful single answer for a merged execution touched by several documents at different confidence levels. */
function strongestVerdict(verdicts: VerificationVerdict[]): VerificationVerdict {
  if (verdicts.includes("Verified")) return "Verified";
  if (verdicts.includes("Needs Review")) return "Needs Review";
  return "Rejected";
}

/**
 * Every execution for one ticker, merged by canonicalKey — the same
 * "documents describing the same execution must merge into one node"
 * business rule the Evidence Graph already applies to its own transaction
 * nodes, made explicit here as its own typed view with exactly the fields
 * business reasoning needs (fees/taxes/evidence sources/missing/
 * conflicting/status), rather than requiring a caller to reconstruct all of
 * that from the graph and verification result by hand every time.
 */
export function buildCanonicalTransactions(ticker: string, params: VerifyAllParams, uploads: Upload[] = []): CanonicalTransaction[] {
  const normalizedTicker = normalizeTicker(ticker);
  const { transactions: verdicts } = verifyAllDetailed(params);
  const graph = buildEvidenceGraph(normalizedTicker, params, uploads);
  const relevant = params.transactions.filter((t) => t.ticker !== undefined && normalizeTicker(t.ticker) === normalizedTicker);

  const groups = new Map<string, RawTransaction[]>();
  for (const txn of relevant) {
    const bs = toBuySellPayload(txn);
    if (!bs) continue;
    const key = canonicalKey({ side: bs.side, ticker: normalizedTicker, date: bs.payload.executionDate, shares: bs.payload.shares, price: bs.payload.price });
    const bucket = groups.get(key) ?? [];
    bucket.push(txn);
    groups.set(key, bucket);
  }

  const knownMissing = graph.edges.some((e) => e.type === "missing");

  const result: CanonicalTransaction[] = [];
  for (const [transactionId, rows] of groups) {
    const ids = rows.map((r) => r.id);
    const bs = toBuySellPayload(rows[0])!;

    // Highest-authority row's own fees/taxes win — see evidenceAuthority.ts.
    // Reduces left-to-right; higherAuthority returns undefined on a tie, in
    // which case the row already chosen (leftmost/first-seen) is kept.
    let bestFeesSource = rows[0];
    for (const row of rows.slice(1)) {
      if (higherAuthority(row.source, bestFeesSource.source) === row.source) bestFeesSource = row;
    }
    const bestPayload = toBuySellPayload(bestFeesSource)!.payload;

    const rowVerdicts = ids.map((id) => verdicts.get(id)?.verdict).filter((v): v is VerificationVerdict => v !== undefined);
    const edgesTouching = graph.edges.filter((e) => (e.type === "corroborates" || e.type === "contradicts") && (ids.includes(e.from) || ids.includes(e.to)));

    result.push({
      transactionId,
      ticker: normalizedTicker,
      side: bs.side,
      shares: bs.payload.shares,
      price: bs.payload.price,
      fees: bestPayload.fees,
      taxes: bestPayload.taxes,
      date: bs.payload.executionDate,
      time: bs.payload.executionTime,
      confidence: rows.find((r) => r.confidence)?.confidence,
      evidenceSources: ids,
      evidenceCount: ids.length,
      corroboratingEdges: edgesTouching.filter((e) => e.type === "corroborates"),
      contradictingEdges: edgesTouching.filter((e) => e.type === "contradicts"),
      tickerHasKnownMissingEvidence: knownMissing,
      currentStatus: rowVerdicts.length > 0 ? strongestVerdict(rowVerdicts) : "Needs Review",
    });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}

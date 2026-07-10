import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { Upload } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { verifyAllDetailed, type VerifyAllParams, type EvidenceType } from "./verificationEngine";
import { assessTickerCompleteness, type TickerCompletenessReport } from "./completenessEngine";

/**
 * Evidence Graph: a read-only VIEW composing what verificationEngine.ts and
 * completenessEngine.ts already compute into one queryable, graph-shaped
 * structure — not a new source of truth, not a persisted table, and not a
 * reimplementation of any matching/corroboration logic. Every edge here is
 * built directly from an EvidenceItem verifyAllDetailed already produced, or
 * from a TickerCompletenessReport assessTickerCompleteness already produced.
 *
 * Deliberately NOT persisted (no Dexie table, no new repository): this
 * codebase's existing projections (ledgerCache, allocationsCache, and every
 * *Engine module) already established the rule that anything derivable
 * cheaply and correctly from RawTransaction must be regenerated fresh, never
 * cached as a second source of truth that can silently drift as new evidence
 * arrives. A materialized graph store would reintroduce exactly that risk —
 * "corroborates"/"contradicts" are judgments about the CURRENT total
 * evidence set, and must be recomputed whenever that set grows (a new
 * upload), not remembered from the last time they were computed. See
 * docs/EVIDENCE_ARCHITECTURE.md for the full reasoning.
 */

export type EvidenceNodeKind = "document" | "transaction" | "ticker-position";

export interface DocumentNode {
  kind: "document";
  id: string;
  fileName: string;
  fileHash: string;
  contentType: string;
  createdAt: string;
  /** True once the original bytes are permanently retrievable (see Upload.fileBlob) — false for a pre-durability-fix upload or a CSV (whose bytes already equal its extracted text). */
  hasPermanentCopy: boolean;
}

export interface TransactionNode {
  kind: "transaction";
  id: string;
  ticker: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  executionDate: string;
  /** Which document type this fact was extracted from — see RawTransactionSource. */
  source: RawTransaction["source"];
  /** How the text was obtained (native PDF/CSV text vs. OCR) — independent of ticker-match confidence. See RawTransaction.ExtractionMethod. */
  extractionMethod?: RawTransaction["extractionMethod"];
  confidence?: RawTransaction["confidence"];
  parserVersion?: string;
  verdict: "Verified" | "Rejected" | "Needs Review";
}

/** The ticker's own reconciliation outcome — every transaction node for that ticker points at exactly one of these, the same way every document in the user's own worked example (Invoice/Orders/Statement) ultimately converges on "My Position". */
export interface TickerPositionNode {
  kind: "ticker-position";
  id: string;
  ticker: string;
  matched: boolean;
  reason: string;
  netShares: number;
  verifiedUnits?: number;
  completeness: TickerCompletenessReport;
}

export type EvidenceNode = DocumentNode | TransactionNode | TickerPositionNode;

export type EvidenceEdgeType = "sourced-from" | "corroborates" | "contradicts" | "reconciles-against" | "missing";

export interface EvidenceEdge {
  from: string;
  to: string;
  type: EvidenceEdgeType;
  /** The evidence type this edge is built from (see verificationEngine.EvidenceType), or "gap" for a missing-evidence edge — kept so a caller can trace an edge back to exactly which rule produced it. */
  reason: EvidenceType | "gap";
  detail: string;
}

export interface EvidenceGraph {
  ticker: string;
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

const TICKER_NODE_PREFIX = "ticker:";

function tickerNodeId(ticker: string): string {
  return `${TICKER_NODE_PREFIX}${ticker}`;
}

function toTransactionNode(txn: RawTransaction, verdict: "Verified" | "Rejected" | "Needs Review"): TransactionNode | undefined {
  if (txn.kind !== "BuyExecution" && txn.kind !== "SellExecution") return undefined;
  const payload = txn.payload as BuyExecutionPayload | SellExecutionPayload;
  return {
    kind: "transaction",
    id: txn.id,
    ticker: normalizeTicker(payload.ticker),
    side: txn.kind === "BuyExecution" ? "BUY" : "SELL",
    shares: payload.shares,
    price: payload.price,
    executionDate: payload.executionDate,
    source: txn.source,
    extractionMethod: txn.extractionMethod,
    confidence: txn.confidence,
    parserVersion: txn.parserVersion,
    verdict,
  };
}

/**
 * Builds the full Evidence Graph for one ticker: every live Buy/Sell fact as
 * a node, the Upload each was extracted from (when any), the ticker's own
 * reconciliation outcome as a converging node every transaction points at,
 * and an edge for every corroborating/contradicting relationship
 * verifyAllDetailed already computed between them. `uploads` is optional —
 * omit it to get transaction/ticker nodes only, with no document nodes or
 * `sourced-from` edges (useful when the caller hasn't loaded Uploads).
 */
export function buildEvidenceGraph(ticker: string, params: VerifyAllParams, uploads: Upload[] = []): EvidenceGraph {
  const normalizedTicker = normalizeTicker(ticker);
  const { transactions, tickers } = verifyAllDetailed(params);
  const tickerStatus = tickers.get(normalizedTicker);

  const relevantTxns = params.transactions.filter((t) => t.ticker !== undefined && normalizeTicker(t.ticker) === normalizedTicker);

  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];
  const uploadById = new Map(uploads.map((u) => [u.id, u]));
  const includedUploadIds = new Set<string>();

  for (const txn of relevantTxns) {
    const verdict = transactions.get(txn.id)?.verdict;
    const node = verdict ? toTransactionNode(txn, verdict) : undefined;
    if (!node) continue;
    nodes.push(node);

    if (txn.sourceUploadId) {
      const upload = uploadById.get(txn.sourceUploadId);
      if (upload && !includedUploadIds.has(upload.id)) {
        includedUploadIds.add(upload.id);
        nodes.push({
          kind: "document",
          id: upload.id,
          fileName: upload.fileName,
          fileHash: upload.fileHash,
          contentType: upload.contentType,
          createdAt: upload.createdAt,
          hasPermanentCopy: upload.fileBlob !== undefined,
        });
      }
      if (upload) {
        edges.push({ from: node.id, to: upload.id, type: "sourced-from", reason: "matched-ledger", detail: `Extracted from ${upload.fileName}.` });
      }
    }

    // Pairwise corroboration/contradiction — every EvidenceItem verifyAllDetailed
    // attached to this transaction becomes one edge. matchedTransactionId is
    // only present on some evidence types (see verificationEngine.ts); those
    // without one describe a ticker-level or document-aggregate relationship,
    // represented instead by the reconciles-against edge below.
    const evidence = transactions.get(txn.id)?.evidence ?? [];
    for (const item of evidence) {
      if (!item.matchedTransactionId) continue;
      const isContradiction = item.type.startsWith("contradicted-");
      edges.push({
        from: txn.id,
        to: item.matchedTransactionId,
        type: isContradiction ? "contradicts" : "corroborates",
        reason: item.type,
        detail: item.detail,
      });
    }

    // Every transaction converges on its ticker's own reconciliation outcome
    // — the same "...→ My Position" convergence in the worked example.
    if (tickerStatus) {
      edges.push({
        from: txn.id,
        to: tickerNodeId(normalizedTicker),
        type: "reconciles-against",
        reason: "matched-position",
        detail: `Ticker-level reconciliation: ${tickerStatus.reason}.`,
      });
    }
  }

  if (tickerStatus) {
    const completeness = assessTickerCompleteness(tickerStatus);
    nodes.push({
      kind: "ticker-position",
      id: tickerNodeId(normalizedTicker),
      ticker: normalizedTicker,
      matched: tickerStatus.matched,
      reason: tickerStatus.reason,
      netShares: tickerStatus.netShares,
      verifiedUnits: tickerStatus.verifiedUnits,
      completeness,
    });

    // Missing evidence: orphaned fulfilled order-history rows point AT the
    // ticker node as a "missing" edge — there is no transaction node for
    // them (nothing else in the current evidence describes them yet), which
    // is exactly the gap completenessEngine's recoveryPlan names.
    for (const orphan of tickerStatus.orphanedOrderEvidence) {
      edges.push({
        from: tickerNodeId(normalizedTicker),
        to: tickerNodeId(normalizedTicker),
        type: "missing",
        reason: "gap",
        detail: `Orders history shows a fulfilled ${orphan.side} with no matching recorded transaction${orphan.date ? ` on ${orphan.date}` : ""}.`,
      });
    }
  }

  return { ticker: normalizedTicker, nodes, edges };
}

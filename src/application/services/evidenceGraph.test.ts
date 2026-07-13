import { describe, expect, it } from "vitest";
import { buildEvidenceGraph } from "./evidenceGraph";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { VerifyAllParams } from "./verificationEngine";
import type { PositionAggregate } from "./TradeService";
import type { Upload } from "@domain/entities/Upload";

function tickerCorrection(targetId: string, ticker: string): RawTransaction {
  return { ...createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId, patch: { ticker } } }), seq: 98 };
}

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"]; sourceUploadId?: string } = {}): RawTransaction {
  const { id, source, sourceUploadId, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "CSAG", shares: 100, price: 45.5, executionDate: "2026-02-01", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", sourceUploadId, ticker: payload.ticker, payload }), seq: 1 };
}

function sell(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "CSAG", shares: 100, price: 50, executionDate: "2026-02-05", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "manual", ticker: payload.ticker, payload }), seq: 2 };
}

function orderEvidence(overrides: { ticker?: string; side?: "BUY" | "SELL"; shares?: number; date?: string } = {}): RawTransaction {
  const ticker = overrides.ticker ?? "CSAG";
  return {
    ...createRawTransaction({
      kind: "OrderEvidenceCapture",
      source: "orders-timeline",
      ticker,
      payload: { ticker, side: overrides.side ?? "BUY", shares: overrides.shares, totalValue: 1000, status: "fulfilled", date: overrides.date },
    }),
    seq: 4,
  };
}

function emptyPosition(ticker = "CSAG"): PositionAggregate {
  return { ticker, totalShares: 0, costBasis: 0, avgCost: 0, openTrades: [] };
}

function upload(overrides: Partial<Upload> = {}): Upload {
  return {
    id: "upload-1",
    fileName: "statement.pdf",
    fileHash: "hash-1",
    contentType: "application/pdf",
    status: "parsed",
    candidates: [],
    createdAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("evidenceGraph.buildEvidenceGraph", () => {
  it("builds one transaction node per live Buy/Sell fact, plus a ticker-position node every one of them points at", () => {
    const b = buy({ id: "b1", source: "invoice" });
    const s = sell({ id: "s1", source: "invoice" });
    const params: VerifyAllParams = { transactions: [b, s], positions: [emptyPosition()] };

    const graph = buildEvidenceGraph("CSAG", params);

    const txnNodes = graph.nodes.filter((n) => n.kind === "transaction");
    expect(txnNodes.map((n) => n.id).sort()).toEqual(["b1", "s1"]);
    expect(txnNodes.every((n) => n.kind === "transaction" && n.verdict === "Verified")).toBe(true);

    const tickerNode = graph.nodes.find((n) => n.kind === "ticker-position");
    expect(tickerNode).toBeDefined();
    expect(tickerNode?.kind === "ticker-position" && tickerNode.matched).toBe(true);

    // Every transaction converges on the ticker node, mirroring the
    // Invoice/Orders/Statement -> My Position convergence in the spec.
    const reconcilesEdges = graph.edges.filter((e) => e.type === "reconciles-against");
    expect(reconcilesEdges).toHaveLength(2);
    expect(reconcilesEdges.every((e) => e.to === tickerNode?.id)).toBe(true);
  });

  it("adds a document node and a sourced-from edge when the Upload is supplied, and marks whether the original bytes are permanently retrievable", () => {
    const b = buy({ id: "b1", source: "statement", sourceUploadId: "upload-1" });
    const params: VerifyAllParams = { transactions: [b], positions: [emptyPosition()] };
    const uploads = [upload({ id: "upload-1", fileBlob: new Blob(["fake pdf bytes"]) })];

    const graph = buildEvidenceGraph("CSAG", params, uploads);

    const docNode = graph.nodes.find((n) => n.kind === "document");
    expect(docNode).toBeDefined();
    expect(docNode?.kind === "document" && docNode.hasPermanentCopy).toBe(true);
    expect(graph.edges).toContainEqual({
      from: "b1",
      to: "upload-1",
      type: "sourced-from",
      reason: "matched-ledger",
      detail: "Extracted from statement.pdf.",
    });
  });

  it("adds a corroborates edge between two independent documents describing the same execution", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement" });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice" });
    const params: VerifyAllParams = { transactions: [statementRead, invoiceRead], positions: [emptyPosition()] };

    const graph = buildEvidenceGraph("CSAG", params);

    const corroborates = graph.edges.filter((e) => e.type === "corroborates");
    expect(corroborates.length).toBeGreaterThan(0);
    expect(corroborates.some((e) => e.from === "stmt-1" && e.to === "invoice-1")).toBe(true);
  });

  it("represents a missing execution (orphaned Orders-history evidence) as a 'missing' edge on the ticker node — the graph's own view of the recovery plan's gap", () => {
    const closedPair1 = buy({ id: "c1", shares: 10, executionDate: "2025-12-01" });
    const closedPair2 = sell({ id: "c2", shares: 10, executionDate: "2025-12-15" });
    const orphaned = orderEvidence({ side: "BUY", shares: 20, date: "2026-01-14" });
    const params: VerifyAllParams = { transactions: [closedPair1, closedPair2, orphaned], positions: [emptyPosition()] };

    const graph = buildEvidenceGraph("CSAG", params);

    const missingEdges = graph.edges.filter((e) => e.type === "missing");
    expect(missingEdges).toHaveLength(1);
    expect(missingEdges[0].detail).toContain("2026-01-14");

    const tickerNode = graph.nodes.find((n) => n.kind === "ticker-position");
    expect(tickerNode?.kind === "ticker-position" && tickerNode.completeness.recoveryPlan?.expectedExecution).toEqual({
      ticker: "CSAG",
      side: "BUY",
      date: "2026-01-14",
      shares: 20,
    });
  });

  it("returns an empty graph for a ticker with no live Buy/Sell facts, never fabricating a node", () => {
    const graph = buildEvidenceGraph("GHOST", { transactions: [], positions: [] });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  // Policy audit finding: relevantTxns used to filter by the raw, immutable
  // t.ticker field, and toTransactionNode built each node's own `.ticker`
  // from the raw payload.ticker — the same bug class already fixed in
  // verificationEngine.ts/canonicalTransaction.ts/ledgerEngine.ts (same
  // session). A ticker renamed via a Correction fact silently lost its
  // pre-rename transaction node (and any corroborates/contradicts edge
  // touching it) from the graph built for its current name.
  it("still includes a pre-rename transaction node (under its current ticker) once its ticker has been corrected via a Correction fact", () => {
    const preRename = buy({ id: "b1", ticker: "CSAG", executionDate: "2026-01-10" });
    const rename = tickerCorrection("b1", "HRHO");
    const postRename = buy({ id: "b2", ticker: "HRHO", executionDate: "2026-01-20" });
    const params: VerifyAllParams = { transactions: [preRename, rename, postRename], positions: [emptyPosition("HRHO")] };

    const hrhoGraph = buildEvidenceGraph("HRHO", params);
    const txnNodes = hrhoGraph.nodes.filter((n) => n.kind === "transaction");
    expect(txnNodes.map((n) => n.id).sort()).toEqual(["b1", "b2"]);
    expect(txnNodes.every((n) => n.kind === "transaction" && n.ticker === "HRHO")).toBe(true);

    const csagGraph = buildEvidenceGraph("CSAG", params);
    expect(csagGraph.nodes.filter((n) => n.kind === "transaction")).toEqual([]);
  });
});

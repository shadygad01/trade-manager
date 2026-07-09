import type {
  RawTransaction,
  BuyExecutionPayload,
  SellExecutionPayload,
  PositionVerificationCapturePayload,
  OrderEvidenceCapturePayload,
} from "@domain/entities/RawTransaction";
import type { ParsedTradeCandidate, ParsedOrderEvidence } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import {
  findCrossSourceVerifiedKeys,
  findAggregateStatementMatches,
  findWrongTickerCandidateKeys,
  suggestDuplicatePendingCandidateKeysToDelete,
  pendingCandidateSignature,
} from "./duplicateDetection";
import { findOrderConfirmedKeys, findWrongTickerHintsFromOrders } from "./orderEvidence";
import { checkTickerMatch } from "./importVerification";
import { latestByTicker } from "./reconciliation";
import type { PositionAggregate } from "./TradeService";

/**
 * Verification Engine: for every still-pending Buy/Sell RawTransaction,
 * gathers the same evidence signals the codebase already computes elsewhere
 * (cross-source corroboration, order-history confirmation, ledger-duplicate
 * detection, broker "My Position" reconciliation, wrong-ticker/date-misread
 * hints) and folds them into one of three verdicts. This never writes
 * anything — no ledger, no allocations, no holdings, no transaction edits.
 * `positions` is supplied by the caller (today: TradeService.computePositions'
 * live output; later: the Holdings Engine's output) rather than computed
 * here, so this module has no dependency on how holdings are derived.
 */

export type EvidenceType =
  | "matched-order"
  | "matched-statement"
  | "matched-invoice"
  | "matched-orders-screen"
  | "matched-csv"
  | "matched-statement-aggregate"
  | "matched-ledger"
  | "matched-position"
  | "contradicted-wrong-ticker"
  | "contradicted-position-mismatch";

export interface EvidenceItem {
  type: EvidenceType;
  matchedTransactionId?: string;
  detail: string;
}

export type VerificationVerdict = "Verified" | "Rejected" | "Needs Review";

export interface TransactionVerification {
  transactionId: string;
  evidence: EvidenceItem[];
  verdict: VerificationVerdict;
}

interface TradeCandidateEntry {
  key: string;
  candidate: ParsedTradeCandidate;
  txn: RawTransaction;
}

function toCandidateSource(source: RawTransaction["source"]): ParsedTradeCandidate["source"] {
  if (source === "statement" || source === "invoice" || source === "orders-screen" || source === "csv") return source;
  // "manual" and the position/orders-timeline document sources never apply
  // to a Buy/Sell candidate itself — treated the same as a legacy untyped
  // read, exactly like duplicateDetection.ts already treats `undefined`.
  return undefined;
}

function toTradeCandidateEntries(transactions: RawTransaction[]): TradeCandidateEntry[] {
  const entries: TradeCandidateEntry[] = [];
  for (const txn of transactions) {
    if (txn.kind !== "BuyExecution" && txn.kind !== "SellExecution") continue;
    const payload = txn.payload as BuyExecutionPayload | SellExecutionPayload;
    entries.push({
      key: txn.id,
      txn,
      candidate: {
        ticker: payload.ticker,
        companyName: "companyName" in payload ? payload.companyName : undefined,
        side: txn.kind === "BuyExecution" ? "BUY" : "SELL",
        shares: payload.shares,
        price: payload.price,
        fees: payload.fees,
        taxes: payload.taxes,
        date: payload.executionDate,
        time: payload.executionTime,
        confidence: txn.confidence,
        source: toCandidateSource(txn.source),
        transactionNumber: payload.transactionNumber,
      },
    });
  }
  return entries;
}

function toOrderEvidences(transactions: RawTransaction[]): ParsedOrderEvidence[] {
  return transactions
    .filter((t) => t.kind === "OrderEvidenceCapture")
    .map((t) => t.payload as OrderEvidenceCapturePayload);
}

function toPositionVerifications(transactions: RawTransaction[]): PositionVerification[] {
  return transactions
    .filter((t) => t.kind === "PositionVerificationCapture")
    .map((t) => {
      const p = t.payload as PositionVerificationCapturePayload;
      return {
        id: t.id,
        portfolioId: t.portfolioId ?? "",
        ticker: p.ticker,
        companyName: p.companyName,
        units: p.units,
        avgCost: p.avgCost,
        capturedAt: p.capturedAt,
        source: t.source === "manual" ? "manual" : "screenshot",
      } satisfies PositionVerification;
    });
}

/** Which OTHER document type corroborated a cross-source-verified entry — findCrossSourceVerifiedKeys itself only returns which keys are verified, not by which pairing, so this re-derives just the grouping (via the same exported signature key), not the decision logic. */
function corroboratingSourceLabel(entry: TradeCandidateEntry, allEntries: TradeCandidateEntry[]): EvidenceType | undefined {
  const sig = pendingCandidateSignature(entry.candidate);
  const donor = allEntries.find(
    (o) => o.key !== entry.key && pendingCandidateSignature(o.candidate) === sig && o.candidate.source !== undefined && o.candidate.source !== entry.candidate.source
  );
  if (!donor?.candidate.source) return undefined;
  return (`matched-${donor.candidate.source}` as EvidenceType);
}

export interface VerifyAllParams {
  /** Scope: every RawTransaction relevant to one review batch — BuyExecution/SellExecution candidates plus their OrderEvidenceCapture/PositionVerificationCapture corroboration, typically for one portfolio (or still-unassigned, portfolioId undefined). */
  transactions: RawTransaction[];
  /** Currently computed holdings for the same scope, supplied by the caller — never computed by this module. */
  positions: PositionAggregate[];
}

export function verifyAll(params: VerifyAllParams): Map<string, TransactionVerification> {
  const entries = toTradeCandidateEntries(params.transactions);
  const orderEvidences = toOrderEvidences(params.transactions);
  const verifications = toPositionVerifications(params.transactions);
  const verificationByTicker = latestByTicker(verifications);
  const positionByTicker = new Map(params.positions.map((p) => [normalizeTicker(p.ticker), p]));

  const entryPairs = entries.map((e) => ({ key: e.key, candidate: e.candidate }));
  const crossVerified = findCrossSourceVerifiedKeys(entryPairs);
  const aggregateMatches = findAggregateStatementMatches(entryPairs);
  const aggregatedKeys = new Set(aggregateMatches.keys());
  const orderConfirmed = findOrderConfirmedKeys(entryPairs, orderEvidences);
  // Several same-signature raw transactions can mean two different things:
  // a genuine re-upload of the SAME source document (an error — one should
  // be rejected), or two DIFFERENT document types independently confirming
  // the same real execution (corroboration — both are legitimate, and which
  // one becomes the eventual Ledger event is the Ledger stage's own dedup
  // job, not a reason to reject either read here). Cross-source-verified
  // keys are excluded from this rejection so a statement+invoice pair, say,
  // both come out Verified via their own matched-invoice/matched-statement
  // evidence instead of one of them being wrongly flagged as an error.
  const duplicateKeysToReject = new Set(
    suggestDuplicatePendingCandidateKeysToDelete(entryPairs).filter((key) => !crossVerified.has(key))
  );
  // No separately committed ledger exists at this layer, so the
  // wrong-ticker/order hints only ever compare pending entries against each
  // other and against order-history evidence — never against a "committed"
  // pool, which is exactly what these functions already support (their
  // committedTrades/committedAllocations parameters are for a maintenance
  // scenario this layer doesn't have).
  const wrongTickerHints = findWrongTickerCandidateKeys(entryPairs, [], []);
  const wrongTickerOrderHints = findWrongTickerHintsFromOrders(entryPairs, orderEvidences);

  const tickers = new Set(entries.map((e) => normalizeTicker(e.candidate.ticker)));
  const tickerReason = new Map<string, ReturnType<typeof checkTickerMatch>>();
  for (const ticker of tickers) {
    const tickerEntries = entries.filter((e) => normalizeTicker(e.candidate.ticker) === ticker);
    const pendingBuyShares = tickerEntries.filter((e) => e.candidate.side === "BUY").reduce((s, e) => s + e.candidate.shares, 0);
    const pendingSellShares = tickerEntries.filter((e) => e.candidate.side === "SELL").reduce((s, e) => s + e.candidate.shares, 0);
    const existingRemainingShares = positionByTicker.get(ticker)?.totalShares ?? 0;
    const verification = verificationByTicker.get(ticker);
    const allPendingFromInvoice = tickerEntries.every((e) => e.candidate.source === "invoice");
    const allPendingSelfVerified = tickerEntries.every((e) => crossVerified.has(e.key) || aggregatedKeys.has(e.key));
    const allPendingOrderConfirmed = tickerEntries.every((e) => orderConfirmed.has(e.key));

    tickerReason.set(
      ticker,
      checkTickerMatch({
        hasShares: pendingBuyShares + pendingSellShares > 0,
        pendingBuyShares,
        pendingSellShares,
        existingRemainingShares,
        verifiedUnits: verification?.units,
        verifiedAvgCost: verification?.avgCost,
        allPendingFromInvoice,
        allPendingSelfVerified,
        allPendingOrderConfirmed,
      })
    );
  }

  const VERIFIED_REASONS = new Set(["no-shares-to-verify", "closed-position", "invoice-verified", "cross-verified", "orders-verified", "matched"]);

  const result = new Map<string, TransactionVerification>();
  for (const entry of entries) {
    const evidence: EvidenceItem[] = [];
    const ticker = normalizeTicker(entry.candidate.ticker);

    const isDuplicate = duplicateKeysToReject.has(entry.key);
    if (isDuplicate) {
      evidence.push({
        type: "matched-ledger",
        detail: "Duplicate read of the same real execution as another pending row — not the more plausible survivor.",
      });
    }

    const sourceLabel = corroboratingSourceLabel(entry, entries);
    if (sourceLabel) evidence.push({ type: sourceLabel, detail: "Independently corroborated by a second document type describing the same execution." });
    if (aggregatedKeys.has(entry.key)) evidence.push({ type: "matched-statement-aggregate", detail: "This statement row's total is exactly explained by a group of other executions." });
    if (orderConfirmed.has(entry.key)) evidence.push({ type: "matched-order", detail: "Confirmed by a fulfilled row on the broker's own Orders-history screen." });

    const reason = tickerReason.get(ticker);
    if (reason && VERIFIED_REASONS.has(reason.reason)) {
      evidence.push({ type: "matched-position", detail: `Ticker-level reconciliation: ${reason.reason}.` });
    } else if (reason && (reason.reason === "mismatch" || reason.reason === "no-verification")) {
      evidence.push({ type: "contradicted-position-mismatch", detail: `Ticker-level reconciliation: ${reason.reason}.` });
    }

    const wrongTicker = wrongTickerHints.get(entry.key) ?? wrongTickerOrderHints.get(entry.key);
    if (wrongTicker) evidence.push({ type: "contradicted-wrong-ticker", detail: `Numbers match a fulfilled/committed row under ticker ${wrongTicker} instead.` });

    // Fold rule (four branches, checked in order):
    // 1. A confirmed duplicate (not the survivor) is a confident re-read of a real execution already represented elsewhere -> Rejected.
    // 2. A CONFIDENT, row-specific contradiction (wrong-ticker hint — numbers point at a different ticker
    //    entirely) with nothing directly corroborating THIS row -> Rejected. A ticker-level, ambiguous
    //    mismatch (nobody knows WHICH row is the problem) deliberately does NOT trigger this branch —
    //    only a confident, row-specific signal is enough to reject a specific transaction outright.
    // 3. The ticker-level reconciliation is confidently settled and no row-specific contradiction exists -> Verified.
    // 4. Anything else (no evidence yet, an unresolved ticker-level mismatch, or no-verification) -> Needs Review.
    const hasSpecificContradiction = evidence.some((e) => e.type === "contradicted-wrong-ticker");
    const hasDirectMatch = evidence.some((e) => e.type !== "contradicted-wrong-ticker" && e.type !== "contradicted-position-mismatch" && e.type !== "matched-position");
    const tickerVerified = reason !== undefined && VERIFIED_REASONS.has(reason.reason);

    let verdict: VerificationVerdict;
    if (isDuplicate) {
      verdict = "Rejected";
    } else if (hasSpecificContradiction && !hasDirectMatch) {
      verdict = "Rejected";
    } else if (tickerVerified && !hasSpecificContradiction) {
      verdict = "Verified";
    } else {
      verdict = "Needs Review";
    }

    result.set(entry.key, { transactionId: entry.key, evidence, verdict });
  }

  return result;
}

export function verifyTransaction(transactionId: string, params: VerifyAllParams): TransactionVerification | undefined {
  return verifyAll(params).get(transactionId);
}

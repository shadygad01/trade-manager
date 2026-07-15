import type { ParsedTradeCandidate, ParsedDividendCandidate, ParsedOrderEvidence, ParsedCancelledOrder } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type PositionVerificationCapturePayload, type OrderEvidenceCapturePayload, type DividendPaymentPayload, type CancelledOrderPayload, type RawTransactionSource } from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { appendAndMaybeCommit, type CommitEngineRepos } from "./commitEngine";
import { findLiveExecutionFact } from "./rawTransactionFolds";
import { higherAuthority } from "./evidenceAuthority";

/**
 * Import Recording: Import's ONLY sanctioned write. Given the domain-typed
 * candidates a parsed document produced, appends one immutable RawTransaction
 * per candidate — nothing else. No ledger, no allocations, no holdings, no
 * verification/matching decision made HERE. Every row is written with status
 * "unverified"; deciding Verified/Rejected/Needs Review happens later, by
 * the Verification Engine.
 *
 * Phase 9.7: this is now the AUTHORITATIVE write for the RawTransaction log,
 * not a best-effort shadow of it. "Authoritative" describes completeness and
 * fidelity of the DATA, not write ordering or failure severity — ImportPage.tsx
 * still calls this from inside a non-fatal try/catch (a transient IndexedDB
 * failure here must never break today's working legacy Import flow, which
 * remains the actual source of truth for what the user sees), and the
 * localStorage pending pool is still what ImportPage reads and renders from.
 * What changed: every candidate's own session key is now threaded through as
 * the written RawTransaction's `id` (see ImportRecordingInput), so a later
 * Skip/Dismiss/Discard action can retract the exact right row — the raw log
 * can now faithfully reflect the candidate's FULL lifecycle (created, then
 * later retracted), not just its creation.
 *
 * Appends through `appendAndMaybeCommit` (commitEngine.ts) rather than
 * `rawTransactions.append` directly, so a commit fires automatically the
 * moment a ticker's verification state becomes terminal — but since Import
 * never assigns a `portfolioId` (a deliberately separate, later step, never
 * inferred here), every row Import writes today has nothing to commit yet;
 * that trigger is correctly inert for Import specifically until something
 * else assigns a portfolio.
 *
 * Deliberately takes plain domain-typed arrays rather than
 * ImportOrchestrator's ImportResult — that type lives in the infrastructure
 * layer (src/infrastructure/ocr/ImportOrchestrator.ts), which the
 * application layer is not allowed to import from. ImportPage.tsx
 * (presentation) bridges the two, exactly the direction Clean Architecture
 * intends: presentation wires infrastructure output into an application
 * service, not the other way around.
 */

export type ImportRecordingRepos = CommitEngineRepos;

export interface ImportRecordingInput {
  sourceUploadId: string;
  /**
   * `key` becomes the written RawTransaction's own `id` (see createRawTransaction's
   * `id` override) instead of a random generated one — the same key the
   * presentation layer's pending-candidate pool already uses (see
   * ImportPage.tsx's CandidateEntry). This is what makes a later
   * Skip/Dismiss/Discard action (keyed the same way) able to retract the
   * exact RawTransaction this candidate produced, via
   * commitEngine.retractRawTransaction(repos, key) — no separate lookup
   * table, no signature-based correlation needed.
   */
  candidates: { key: string; candidate: ParsedTradeCandidate }[];
  verifications: Omit<PositionVerification, "id" | "portfolioId">[];
  dividends: ParsedDividendCandidate[];
  /** Same `key`-as-`id` treatment as `candidates`, for the same reason — an Orders-screenshot row can be individually discarded too (see ImportPage.tsx's discardOrderEvidence). */
  orderEvidences: { key: string; evidence: ParsedOrderEvidence }[];
  /** Fully-cancelled orders (STES only) — recorded as `CancelledOrder` facts, audit trail only. Never read by commitEngine's Buy/Sell fold, never a candidate, never gated on a session key since nothing about them is ever committed/discardable the way a trade candidate is. */
  cancelledOrders: ParsedCancelledOrder[];
}

export function candidateSource(candidate: ParsedTradeCandidate): RawTransactionSource {
  // A candidate without a recorded source predates ParsedTradeCandidate.source
  // existing — "statement" is the most common/generic document shape and the
  // same fallback duplicateDetection.ts's own cross-source logic already
  // treats an untyped legacy read as closest to.
  return candidate.source ?? "statement";
}

export async function recordImportedRawTransactions(repos: ImportRecordingRepos, input: ImportRecordingInput): Promise<string[]> {
  const { sourceUploadId, candidates, verifications, dividends, orderEvidences, cancelledOrders } = input;
  const facts: Omit<RawTransaction, "seq">[] = [];

  // Invariant: exactly one live canonical execution fact per business
  // execution identity (ticker/date/shares/price/time), regardless of how
  // many times the same document is (re-)imported. A growing local view —
  // same "keep a live snapshot updated as this call writes its own facts"
  // pattern backfillRawTransactions.ts/ledgerProjection.ts already use — so
  // a second candidate in the SAME batch matching an earlier one in this
  // SAME batch is caught too, not just cross-call duplicates.
  const liveExecutionFacts = await repos.rawTransactions.getAll();

  for (const { key, candidate } of candidates) {
    const ticker = normalizeTicker(candidate.ticker);
    const kind = candidate.side === "BUY" ? "BuyExecution" : "SellExecution";
    const source = candidateSource(candidate);
    const existingFact = findLiveExecutionFact(liveExecutionFacts, {
      kind,
      ticker,
      date: candidate.date,
      shares: candidate.shares,
      price: candidate.price,
      time: candidate.time,
    });
    // A tie or lower-authority re-read of an execution already live at
    // equal-or-better authority needs no fact of its own — writing one
    // anyway is exactly what left two live "official-broker-excel" facts
    // for the same re-imported execution (only ever cleaned up afterward,
    // non-atomically, by ImportPage's own duplicate-skip effect). A
    // genuinely HIGHER-authority candidate (a better document describing an
    // execution only previously seen via a weaker source) still gets its own
    // fact, unchanged from before — ImportPage's effect remains responsible
    // for retracting the superseded lower-authority fact in that case, same
    // as today.
    if (existingFact && higherAuthority(source, existingFact.source) !== source) {
      continue;
    }

    if (candidate.side === "BUY") {
      const payload: BuyExecutionPayload = {
        ticker,
        shares: candidate.shares,
        price: candidate.price,
        fees: candidate.fees,
        taxes: candidate.taxes,
        executionDate: candidate.date,
        executionTime: candidate.time,
        companyName: candidate.companyName,
        transactionNumber: candidate.transactionNumber,
      };
      const fact = createRawTransaction({
        id: key,
        kind: "BuyExecution",
        source,
        sourceUploadId,
        ticker,
        confidence: candidate.confidence,
        extractionMethod: candidate.extractionMethod,
        parserVersion: candidate.parserVersion,
        payload,
      });
      facts.push(fact);
      liveExecutionFacts.push({ ...fact, seq: 0 });
    } else {
      const payload: SellExecutionPayload = {
        ticker,
        shares: candidate.shares,
        price: candidate.price,
        fees: candidate.fees,
        taxes: candidate.taxes,
        executionDate: candidate.date,
        executionTime: candidate.time,
        transactionNumber: candidate.transactionNumber,
      };
      const fact = createRawTransaction({
        id: key,
        kind: "SellExecution",
        source,
        sourceUploadId,
        ticker,
        confidence: candidate.confidence,
        extractionMethod: candidate.extractionMethod,
        parserVersion: candidate.parserVersion,
        payload,
      });
      facts.push(fact);
      liveExecutionFacts.push({ ...fact, seq: 0 });
    }
  }

  for (const verification of verifications) {
    const ticker = normalizeTicker(verification.ticker);
    const payload: PositionVerificationCapturePayload = {
      ticker,
      units: verification.units,
      avgCost: verification.avgCost,
      capturedAt: verification.capturedAt,
      companyName: verification.companyName,
    };
    facts.push(createRawTransaction({ kind: "PositionVerificationCapture", source: "position-verification", sourceUploadId, ticker, payload }));
  }

  // A dividend read alongside a "My Position" screen carries no source of its
  // own (the pre-STES default); an STES workbook observation carries its
  // Documents-sheet type instead.
  for (const dividend of dividends) {
    const ticker = dividend.ticker ? normalizeTicker(dividend.ticker) : undefined;
    const payload: DividendPaymentPayload = { ticker, amount: dividend.amount, date: dividend.date };
    facts.push(createRawTransaction({ kind: "DividendPayment", source: dividend.source ?? "position-verification", sourceUploadId, ticker, payload }));
  }

  // Order evidence is only ever read from the account-wide Orders-timeline
  // screen — see ImportOrchestrator's own routing.
  for (const { key, evidence } of orderEvidences) {
    const ticker = normalizeTicker(evidence.ticker);
    const payload: OrderEvidenceCapturePayload = {
      ticker,
      side: evidence.side,
      orderType: evidence.orderType,
      shares: evidence.shares,
      price: evidence.price,
      totalValue: evidence.totalValue,
      status: evidence.status,
      date: evidence.date,
      time: evidence.time,
      companyName: evidence.companyName,
    };
    facts.push(
      createRawTransaction({
        id: key,
        kind: "OrderEvidenceCapture",
        source: "orders-timeline",
        sourceUploadId,
        ticker,
        confidence: evidence.confidence,
        extractionMethod: evidence.extractionMethod,
        parserVersion: evidence.parserVersion,
        payload,
      }),
    );
  }

  // Fully-cancelled orders: audit trail only. This RawTransactionKind is
  // never read by commitEngine's Buy/Sell fold (relevantTradeTransactions
  // only ever selects "BuyExecution"/"SellExecution") and never read by
  // TradeService/computePositions — so it is structurally incapable of
  // creating a Ledger Entry or affecting Holdings, not just conventionally
  // excluded.
  for (const cancelledOrder of cancelledOrders) {
    const ticker = normalizeTicker(cancelledOrder.ticker);
    const payload: CancelledOrderPayload = {
      ticker,
      side: cancelledOrder.side,
      originalShares: cancelledOrder.originalShares,
      originalPrice: cancelledOrder.originalPrice,
      date: cancelledOrder.date,
      time: cancelledOrder.time,
      brokerStatus: cancelledOrder.brokerStatus,
      companyName: cancelledOrder.companyName,
    };
    facts.push(createRawTransaction({ kind: "CancelledOrder", source: cancelledOrder.source ?? "statement", sourceUploadId, ticker, payload }));
  }

  if (facts.length === 0) return [];
  if (repos.rawTransactions.appendMany) {
    await repos.rawTransactions.appendMany(facts);
    return facts
      .filter((fact) => fact.kind === "BuyExecution" || fact.kind === "SellExecution" || fact.kind === "OrderEvidenceCapture")
      .map((fact) => fact.id);
  }
  for (const fact of facts) await appendAndMaybeCommit(repos, fact);
  return facts
    .filter((fact) => fact.kind === "BuyExecution" || fact.kind === "SellExecution" || fact.kind === "OrderEvidenceCapture")
    .map((fact) => fact.id);
}

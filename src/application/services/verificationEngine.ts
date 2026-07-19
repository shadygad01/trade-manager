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
import { Money } from "@domain/value-objects/Money";
import {
  findCrossSourceVerifiedKeys,
  findAggregateStatementMatches,
  findWrongTickerCandidateKeys,
  findDateMisreadDuplicateHints,
  suggestDuplicatePendingCandidateKeysToDelete,
  pendingCandidateSignature,
  timesConflict,
} from "./duplicateDetection";
import { findOrderConfirmedKeys, findWrongTickerHintsFromOrders, findOrphanedFulfilledEvidence } from "./orderEvidence";
import { checkTickerMatch, type TickerMatchStatus } from "./importVerification";
import { latestByTicker } from "./reconciliation";
import { suggestRemovalsToReconcile, type ReconcileSuggestion } from "./mismatchResolver";
import { findLastBalancedDate, type LastBalancedPoint } from "./netShareTimeline";
import { buildTickerConstraintReport, type TickerConstraintReport } from "./constraintValidation";
import { isRetracted, findUnallocatedSellExecutions } from "./rawTransactionFolds";
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
  | "matched-backfill"
  | "contradicted-wrong-ticker"
  | "contradicted-position-mismatch"
  | "contradicted-date-misread";

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
  if (source === "statement" || source === "invoice" || source === "official-broker-excel" || source === "orders-screen" || source === "csv") return source;
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

/** Sorted side|shares|price|date signature of one ticker's whole buy/sell row set — ImportPage's own mergeSuggestions signature, ported verbatim (see computeVerification's merge-suggestion pre-pass). */
function tickerRowSignature(tickerEntries: TradeCandidateEntry[]): string {
  return tickerEntries
    .map((e) => `${e.candidate.side}|${e.candidate.shares}|${e.candidate.price}|${e.candidate.date}`)
    .sort()
    .join(";");
}

/**
 * Which OTHER document type (and specific transaction) corroborated a
 * cross-source-verified entry — findCrossSourceVerifiedKeys itself only
 * returns which keys are verified, not by which pairing, so this re-derives
 * just the grouping (via the same exported signature key), not the decision
 * logic. Returns the donor's own key alongside the label so the caller can
 * record a real transaction-to-transaction edge (EvidenceItem.
 * matchedTransactionId), not just a description of the corroboration.
 *
 * pendingCandidateSignature alone is deliberately time-blind — gated by
 * timesConflict here (the same discriminator findCrossSourceVerifiedKeys'
 * own sameCandidateExecution already applies to this identical signature),
 * so two genuinely distinct real executions sharing a signature but reading
 * different times (or different sources by coincidence) never get labeled as
 * corroborating each other. Without this, a false "Independently
 * corroborated" evidence badge could attach to two unrelated real trades,
 * and — since that evidence type isn't excluded from hasDirectMatch below —
 * could even suppress a genuine wrong-ticker rejection for one of them.
 */
function corroboratingSource(entry: TradeCandidateEntry, allEntries: TradeCandidateEntry[]): { type: EvidenceType; donorKey: string } | undefined {
  const sig = pendingCandidateSignature(entry.candidate);
  const donor = allEntries.find(
    (o) =>
      o.key !== entry.key &&
      pendingCandidateSignature(o.candidate) === sig &&
      o.candidate.source !== undefined &&
      o.candidate.source !== entry.candidate.source &&
      !timesConflict(entry.candidate.time, o.candidate.time)
  );
  if (!donor?.candidate.source) return undefined;
  return { type: `matched-${donor.candidate.source}` as EvidenceType, donorKey: donor.key };
}

export interface VerifyAllParams {
  /** Scope: every RawTransaction relevant to one review batch — BuyExecution/SellExecution candidates plus their OrderEvidenceCapture/PositionVerificationCapture corroboration, typically for one portfolio (or still-unassigned, portfolioId undefined). */
  transactions: RawTransaction[];
  /** Currently computed holdings for the same scope, supplied by the caller — never computed by this module. */
  positions: PositionAggregate[];
}

/**
 * Does the actual work behind verifyAll/verifyAllDetailed/verifyTicker —
 * exactly verifyAll's original body, unchanged, plus one addition: the
 * per-ticker checkTickerMatch() result (already computed either way, at the
 * same call site, to fold into each transaction's evidence) is also kept in
 * `tickerStatuses` instead of only ever being read for its `.reason` string.
 * verifyAll() itself is now a one-line wrapper over this so every existing
 * caller keeps getting the exact same Map it always has.
 */
function computeVerification(params: VerifyAllParams): VerificationResult {
  // Blocker 1 (retractions): a RawTransaction with a live Retraction pointed
  // at it is never a subject of verification again, permanently — same fold
  // rule commitEngine.ts's relevantTradeTransactions already applies before
  // a commit. Filtered once, up front, so every downstream computation
  // (entries, order evidence, position verifications, and every hint below)
  // automatically never sees a retracted row again.
  const liveTransactions = params.transactions.filter((t) => !isRetracted(params.transactions, t.id));

  const entries = toTradeCandidateEntries(liveTransactions);
  const orderEvidences = toOrderEvidences(liveTransactions);
  const verifications = toPositionVerifications(liveTransactions);
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
  // Blocker 3 (wrong-ticker/date-misread accuracy): there is no separate
  // "committed" table at this layer — every Buy/Sell RawTransaction in scope
  // (this batch's and any earlier, already-settled one alike) IS the
  // canonical history now, so it doubles as its own committed-comparison
  // pool. Self-matches are structurally impossible: findWrongTickerCandidateKeys'
  // committed check requires a DIFFERENT ticker than the row being checked,
  // and findDateMisreadDuplicateHints' committed check requires a DIFFERENT
  // (OCR-misread-shaped) date — neither can ever match a row against its own
  // literal data. This is a strict superset of what a real, separately
  // committed pool would have caught (every prior "committed" fact is
  // included here too), so detection accuracy only ever grows, never shrinks.
  const canonicalTrades = entries
    .filter((e) => e.candidate.side === "BUY")
    .map((e) => ({ ticker: e.candidate.ticker, executionDate: e.candidate.date, shares: e.candidate.shares, entryPrice: e.candidate.price }));
  const canonicalAllocations = entries
    .filter((e) => e.candidate.side === "SELL")
    .map((e) => ({ ticker: e.candidate.ticker, executionDate: e.candidate.date, sharesClosed: e.candidate.shares, exitPrice: e.candidate.price }));
  const wrongTickerHints = findWrongTickerCandidateKeys(entryPairs, canonicalTrades, canonicalAllocations);
  const wrongTickerOrderHints = findWrongTickerHintsFromOrders(entryPairs, orderEvidences);
  // Blocker 2 (date-misread evidence completion): same canonical pool as
  // wrong-ticker above — findDateMisreadDuplicateHints has no pending-vs-
  // pending fallback of its own, so without a real committed-shaped pool it
  // could never fire at all (see Phase 9.5's own gap notes).
  const dateMisreadHints = findDateMisreadDuplicateHints(entryPairs, canonicalTrades, canonicalAllocations);
  // Blocker 2 (orphaned order evidence): ticker-scoped, computed once over
  // the whole batch — findOrphanedFulfilledEvidence already returns its
  // result grouped by ticker.
  const orphanedByTicker = findOrphanedFulfilledEvidence(entryPairs, orderEvidences);

  const entriesByTicker = new Map<string, TradeCandidateEntry[]>();
  for (const e of entries) {
    const ticker = normalizeTicker(e.candidate.ticker);
    const bucket = entriesByTicker.get(ticker);
    if (bucket) bucket.push(e);
    else entriesByTicker.set(ticker, [e]);
  }
  const tickers = new Set(entriesByTicker.keys());

  // Blocker 4 (merge suggestions): two ticker groups whose full buy/sell row
  // sets are byte-for-byte identical (side|shares|price|date) are, for all
  // practical purposes, the same upload read under two different guessed
  // tickers — same signature/gating ImportPage's own mergeSuggestions used,
  // ported verbatim (every ticker's signature feeds the grouping regardless
  // of confidence; a SUGGESTION only fires for an all-low-confidence ticker,
  // preferring a non-all-low-confidence sibling over the first one found).
  const mergeSuggestions = new Map<string, string>();
  {
    const bySignature = new Map<string, string[]>();
    for (const ticker of tickers) {
      const sig = tickerRowSignature(entriesByTicker.get(ticker) ?? []);
      if (!sig) continue;
      const list = bySignature.get(sig) ?? [];
      list.push(ticker);
      bySignature.set(sig, list);
    }
    for (const ticker of tickers) {
      const tickerEntries = entriesByTicker.get(ticker) ?? [];
      if (tickerEntries.length === 0 || !tickerEntries.every((e) => e.candidate.confidence === "low")) continue;
      const sig = tickerRowSignature(tickerEntries);
      if (!sig) continue;
      const siblings = (bySignature.get(sig) ?? []).filter((t) => t !== ticker);
      if (siblings.length === 0) continue;
      const preferred =
        siblings.find((t) => !(entriesByTicker.get(t) ?? []).every((e) => e.candidate.confidence === "low")) ?? siblings[0];
      mergeSuggestions.set(ticker, preferred);
    }
  }

  const tickerReason = new Map<string, ReturnType<typeof checkTickerMatch>>();
  // Additive: the same checkTickerMatch() result tickerReason has always
  // stored, tagged with its ticker — see TickerStatus/VerificationResult.
  // Populated at the same call site as tickerReason, never a second call.
  const tickerStatuses = new Map<string, TickerStatus>();
  for (const ticker of tickers) {
    const tickerEntries = entriesByTicker.get(ticker) ?? [];
    const pendingBuyShares = tickerEntries.filter((e) => e.candidate.side === "BUY").reduce((s, e) => s + e.candidate.shares, 0);
    const pendingSellShares = tickerEntries.filter((e) => e.candidate.side === "SELL").reduce((s, e) => s + e.candidate.shares, 0);
    const position = positionByTicker.get(ticker);
    const existingRemainingShares = position?.totalShares ?? 0;
    const verification = verificationByTicker.get(ticker);
    const allPendingFromInvoice = tickerEntries.every((e) => e.candidate.source === "invoice");
    const allPendingFromOfficialBrokerExcel = tickerEntries.every((e) => e.candidate.source === "official-broker-excel");
    const allPendingSelfVerified = tickerEntries.every((e) => crossVerified.has(e.key) || aggregatedKeys.has(e.key));
    const allPendingOrderConfirmed = tickerEntries.every((e) => orderConfirmed.has(e.key));

    const status = checkTickerMatch({
      hasShares: pendingBuyShares + pendingSellShares > 0,
      pendingBuyShares,
      pendingSellShares,
      existingRemainingShares,
      verifiedUnits: verification?.units,
      verifiedAvgCost: verification?.avgCost,
      allPendingFromInvoice,
      allPendingFromOfficialBrokerExcel,
      allPendingSelfVerified,
      allPendingOrderConfirmed,
    });
    tickerReason.set(ticker, status);

    const wrongTickerHintCount = tickerEntries.filter((e) => wrongTickerHints.has(e.key) || wrongTickerOrderHints.has(e.key)).length;
    const dateMisreadHintCount = tickerEntries.filter((e) => dateMisreadHints.has(e.key)).length;

    // Blocker 2 (reconcile suggestion): same gating ImportPage's own
    // reconcileSuggestions applied — only once a mismatch is real (not
    // already fully explained by an alreadyFullyRecorded ledger) and the
    // broker's verified count is known. existingCostBasis intentionally
    // reproduces ImportPage's own fees/taxes-EXCLUSIVE formula
    // (entryPrice * remainingShares only), NOT PositionAggregate.costBasis
    // (which includes fees/taxes pro-rated) — those are different numbers,
    // and suggestRemovalsToReconcile's avg-cost ranking is sensitive to
    // which one it's given.
    let reconcileSuggestion: ReconcileSuggestion | undefined;
    if (status.reason === "mismatch" && !status.alreadyFullyRecorded && status.verifiedUnits !== undefined) {
      const openTrades = position?.openTrades ?? [];
      const existingCostBasis = Money.sum(openTrades.map((t) => Money.from(t.entryPrice).multiply(t.remainingShares))).toNumber();
      reconcileSuggestion = suggestRemovalsToReconcile({
        rows: tickerEntries.map((e) => ({ key: e.key, side: e.candidate.side, shares: e.candidate.shares, price: e.candidate.price, confidence: e.candidate.confidence })),
        existingRemainingShares,
        existingCostBasis,
        verifiedUnits: status.verifiedUnits,
        verifiedAvgCost: status.verifiedAvgCost,
      });
    }

    // Blocker 2 (last-balanced-date): same gating ImportPage applied — only
    // meaningful once a ticker is unmatched.
    const lastBalancedDate = status.matched
      ? undefined
      : findLastBalancedDate({
          rows: tickerEntries.map((e) => ({ key: e.key, side: e.candidate.side, shares: e.candidate.shares, date: e.candidate.date })),
          existingRemainingShares,
        });

    // Blocker 5 (placeholder replacement): same gating and same dateless-
    // opening-balance-lot detection ImportPage's own placeholderReplacements
    // applied, sourced from PositionAggregate.openTrades (already part of
    // VerifyAllParams — no new input needed). Forward-compat caveat: once a
    // future Holdings Engine cutover replaces this positions source,
    // openTrades' `notes` field (the only signal this reads) has no
    // Ledger-event equivalent yet — see the phase report.
    let placeholderReplacement: string[] | undefined;
    if (status.reason === "mismatch" && status.alreadyFullyRecorded && status.verifiedUnits !== undefined) {
      const pendingNet = status.netShares - existingRemainingShares;
      if (Math.abs(pendingNet - status.verifiedUnits) < 1e-6) {
        const existingOpen = (position?.openTrades ?? []).filter((t) => t.remainingShares > 0);
        const allDeletablePlaceholders =
          existingOpen.length > 0 && existingOpen.every((t) => t.notes?.startsWith("Opening balance") && t.remainingShares === t.shares);
        if (allDeletablePlaceholders) placeholderReplacement = existingOpen.map((t) => t.id);
      }
    }

    tickerStatuses.set(ticker, {
      ticker,
      ...status,
      orphanedOrderEvidence: orphanedByTicker.get(ticker) ?? [],
      wrongTickerHintCount,
      dateMisreadHintCount,
      reconcileSuggestion,
      lastBalancedDate,
      mergeSuggestion: mergeSuggestions.get(ticker),
      placeholderReplacement,
      unallocatedSellExecutionIds: findUnallocatedSellExecutions(liveTransactions, ticker).map((t) => t.id),
    });
  }

  // checkTickerMatch's own `matched` boolean is now the single canonical
  // trustworthiness signal (see importVerification.ts) — it already reflects
  // every corroboration rule this engine needs, including the closed-
  // position corroboration requirement. A separate VERIFIED_REASONS string
  // set used to duplicate that same judgment here, out of sync with the one
  // `matched` itself makes (an uncorroborated "closed-position" reason used
  // to read as "verified" here even after checkTickerMatch stopped trusting
  // it) — removed in favor of reading `matched` directly, so there's exactly
  // one place this decision is made.
  const result = new Map<string, TransactionVerification>();
  for (const entry of entries) {
    const evidence: EvidenceItem[] = [];
    const ticker = normalizeTicker(entry.candidate.ticker);

    // Backfilled data represents a fact already committed and reconciled
    // once, under the pre-migration architecture's own rules, at the time
    // it happened — re-litigating it under this engine's stricter
    // per-transaction rules (which real historical trading data routinely
    // wouldn't satisfy — a position that isn't closed and was never
    // captured by a broker screenshot at the time is completely normal)
    // would produce false Needs Review on perfectly legitimate history.
    // Trusted unconditionally. The Ledger stage's own dedup remains the
    // safety net for genuinely duplicate backfilled+new pairs — this
    // bypass only settles THIS row's own verdict, it doesn't suppress
    // anything else's evidence about it.
    if (entry.txn.source === "backfill") {
      result.set(entry.key, {
        transactionId: entry.key,
        evidence: [{ type: "matched-backfill", detail: "Already committed and reconciled under the pre-migration system." }],
        verdict: "Verified",
      });
      continue;
    }

    const isDuplicate = duplicateKeysToReject.has(entry.key);
    if (isDuplicate) {
      evidence.push({
        type: "matched-ledger",
        detail: "Duplicate read of the same real execution as another pending row — not the more plausible survivor.",
      });
    }

    const corroboration = corroboratingSource(entry, entries);
    if (corroboration) {
      evidence.push({
        type: corroboration.type,
        matchedTransactionId: corroboration.donorKey,
        detail: "Independently corroborated by a second document type describing the same execution.",
      });
    }
    if (aggregatedKeys.has(entry.key)) evidence.push({ type: "matched-statement-aggregate", detail: "This statement row's total is exactly explained by a group of other executions." });
    if (orderConfirmed.has(entry.key)) evidence.push({ type: "matched-order", detail: "Confirmed by a fulfilled row on the broker's own Orders-history screen." });

    const reason = tickerReason.get(ticker);
    if (reason && reason.matched) {
      evidence.push({ type: "matched-position", detail: `Ticker-level reconciliation: ${reason.reason}.` });
    } else if (reason && !reason.matched) {
      evidence.push({ type: "contradicted-position-mismatch", detail: `Ticker-level reconciliation: ${reason.reason}.` });
    }

    const wrongTicker = wrongTickerHints.get(entry.key) ?? wrongTickerOrderHints.get(entry.key);
    if (wrongTicker) evidence.push({ type: "contradicted-wrong-ticker", detail: `Numbers match a fulfilled/committed row under ticker ${wrongTicker} instead.` });

    // Advisory only, same contract as findDateMisreadDuplicateHints' own doc
    // comment — never auto-merges/rejects anything, so deliberately excluded
    // from both hasSpecificContradiction and hasDirectMatch below (a badge,
    // not a verdict input).
    const dateMisreadDate = dateMisreadHints.get(entry.key);
    if (dateMisreadDate) evidence.push({ type: "contradicted-date-misread", detail: `Date may be a single-digit OCR misread of an execution already recorded on ${dateMisreadDate}.` });

    // Fold rule (four branches, checked in order):
    // 1. A confirmed duplicate (not the survivor) is a confident re-read of a real execution already represented elsewhere -> Rejected.
    // 2. A CONFIDENT, row-specific contradiction (wrong-ticker hint — numbers point at a different ticker
    //    entirely) with nothing directly corroborating THIS row -> Rejected. A ticker-level, ambiguous
    //    mismatch (nobody knows WHICH row is the problem) deliberately does NOT trigger this branch —
    //    only a confident, row-specific signal is enough to reject a specific transaction outright.
    // 3. The ticker-level reconciliation is confidently settled and no row-specific contradiction exists -> Verified.
    // 4. Anything else (no evidence yet, an unresolved ticker-level mismatch, or no-verification) -> Needs Review.
    const hasSpecificContradiction = evidence.some((e) => e.type === "contradicted-wrong-ticker");
    const hasDirectMatch = evidence.some(
      (e) => e.type !== "contradicted-wrong-ticker" && e.type !== "contradicted-position-mismatch" && e.type !== "matched-position" && e.type !== "contradicted-date-misread"
    );
    const tickerVerified = reason !== undefined && reason.matched;

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

  return { transactions: result, tickers: tickerStatuses };
}

export function verifyAll(params: VerifyAllParams): Map<string, TransactionVerification> {
  return computeVerification(params).transactions;
}

export function verifyTransaction(transactionId: string, params: VerifyAllParams): TransactionVerification | undefined {
  return verifyAll(params).get(transactionId);
}

/**
 * Per-ticker reconciliation facts — checkTickerMatch()'s own result (see
 * importVerification.ts's TickerMatchStatus), tagged with the ticker it was
 * computed for. computeVerification already builds one of these per ticker
 * while folding each transaction's evidence/verdict; verifyAllDetailed/
 * verifyTicker expose it instead of letting it fall out of scope once that
 * fold is done. No new calculation: same checkTickerMatch() call, at the
 * same call site, with the same inputs, as verifyAll has always made.
 */
export interface TickerStatus extends TickerMatchStatus {
  ticker: string;
  /** Fulfilled order-history rows for this ticker with no matching pending candidate — same fact findOrphanedFulfilledEvidence surfaces, computed once per batch and split out per ticker here. Empty array (never undefined) when none exist. */
  orphanedOrderEvidence: ParsedOrderEvidence[];
  /** How many of this ticker's live Buy/Sell transactions carry a contradicted-wrong-ticker evidence item (see the per-transaction evidence list for which ones). */
  wrongTickerHintCount: number;
  /** How many of this ticker's live Buy/Sell transactions carry a contradicted-date-misread evidence item. */
  dateMisreadHintCount: number;
  /** mismatchResolver.suggestRemovalsToReconcile's result for this ticker — only computed once `reason==="mismatch"`, not `alreadyFullyRecorded`, and `verifiedUnits` is known (same gating the legacy caller applied). */
  reconcileSuggestion?: ReconcileSuggestion;
  /** netShareTimeline.findLastBalancedDate's result for this ticker — only computed while unmatched (same gating the legacy caller applied). */
  lastBalancedDate?: LastBalancedPoint;
  /** Another ticker in the same batch whose entire Buy/Sell row set is byte-for-byte identical to this one's — the same-execution-under-two-ticker-guesses shape ImportPage's own mergeSuggestions already flagged. */
  mergeSuggestion?: string;
  /** Existing open-Trade ids that are safely-deletable dateless "Opening balance" placeholders whose removal would let this batch's real dated rows verify instead of being discarded — requires the caller's PositionAggregate to carry `openTrades` (already part of the existing contract). */
  placeholderReplacement?: string[];
  /**
   * Ids of this ticker's live SellExecution facts that have no live
   * SellAllocationDecision pointed at them yet (rawTransactionFolds.findUnallocatedSellExecutions)
   * — i.e. sells the fact log confirms happened but whose lot(s) have never
   * been chosen (ADR-002). Deliberately independent of `matched`: a ticker
   * can be `matched: true` (the net-share arithmetic reconciles against the
   * broker) while this is non-empty, because verifying that enough
   * transactions exist and choosing which lots a sell closes are two
   * different questions. Empty array (never undefined) when every live sell
   * is allocated. See TradeService.recordSell/ensureSellFacts for the only
   * place a SellAllocationDecision is ever created.
   */
  unallocatedSellExecutionIds: string[];
}

export interface VerificationResult {
  /** Byte-for-byte what verifyAll() has always returned — kept for backward compatibility. */
  transactions: Map<string, TransactionVerification>;
  /** One entry per ticker present in params.transactions, keyed by normalizeTicker(ticker). */
  tickers: Map<string, TickerStatus>;
}

/**
 * The same per-ticker facts verifyAll()/verifyTransaction() have always
 * computed internally and discarded, now returned alongside the unchanged
 * transaction verdicts. See VerifyAllParams/VerificationResult; nothing here
 * recomputes anything verifyAll() didn't already compute.
 */
export function verifyAllDetailed(params: VerifyAllParams): VerificationResult {
  return computeVerification(params);
}

/** Ticker-level counterpart to verifyTransaction — the TickerStatus for one ticker, or undefined if that ticker has no Buy/Sell transactions in `params.transactions`. */
export function verifyTicker(ticker: string, params: VerifyAllParams): TickerStatus | undefined {
  return computeVerification(params).tickers.get(normalizeTicker(ticker));
}

/**
 * Blocker 6 (Constraint Validation): buildTickerConstraintReport
 * (constraintValidation.ts) has always been a pure facts-in/report-out
 * function — it never called duplicateDetection/orderEvidence/
 * mismatchResolver/netShareTimeline itself, a caller always had to. This is
 * that caller: every DiagnosisInputs field it needs is now already sitting
 * on TickerStatus, computed once, here. No calculation is duplicated —
 * constraintValidation.ts itself is untouched.
 */
export function buildConstraintReport(ticker: string, params: VerifyAllParams): TickerConstraintReport | undefined {
  const status = verifyTicker(ticker, params);
  if (!status) return undefined;
  return buildTickerConstraintReport(ticker, status, {
    reconcileSuggestion: status.reconcileSuggestion,
    lastBalancedDate: status.lastBalancedDate,
    wrongTickerHintCount: status.wrongTickerHintCount,
    dateMisreadHintCount: status.dateMisreadHintCount,
    orphanedOrderEvidenceCount: status.orphanedOrderEvidence.length,
    discrepancySide: status.discrepancySide,
  });
}

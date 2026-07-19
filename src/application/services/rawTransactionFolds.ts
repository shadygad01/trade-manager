import type {
  RawTransaction,
  RetractionPayload,
  CorrectionPayload,
  BuyExecutionPayload,
  SellExecutionPayload,
  SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { timesConflict } from "./duplicateDetection";

/**
 * Shared supersede/retract folds over the append-only RawTransaction log (see
 * RawTransaction.ts's own doc comment: "Readers resolve 'the current view of
 * fact X' by folding a row's supersede/retract chain, not by mutating it.").
 * A leaf module so commitEngine.ts, verificationEngine.ts, and
 * reconciliation.ts can all depend on it without depending on each other —
 * extracted out of commitEngine.ts (isRetracted/resolveCurrentTicker
 * originated there, private) rather than duplicated.
 */

/** Whether any Retraction targets `transactionId` — a retracted row is never a subject of commit, assignment, or verification again, permanently. */
export function isRetracted(all: RawTransaction[], transactionId: string): boolean {
  return all.some((t) => t.kind === "Retraction" && (t.payload as RetractionPayload).targetId === transactionId);
}

/**
 * A transaction's own `ticker` field is set once at write time and never
 * changes (immutability) — a later correction (e.g. fixing an OCR-garbled
 * ticker, or a wrong-ticker fix from Import) is its own separate Correction
 * raw transaction referencing the original by id, not an edit to it. Any
 * reader that cares which ticker a fact CURRENTLY belongs to (not which
 * ticker it was originally written under) must fold through this — reading
 * `payload.ticker` directly silently stops recognizing a corrected/renamed
 * fact under its new ticker, which broke isTickerFullyOfficialBrokerExcelSourced
 * for any Excel-sourced ticker later renamed via TradeService.renameTickerEverywhere.
 * `excludeCorrectionId` resolves what the ticker was immediately BEFORE one
 * specific correction landed, so a caller reacting to that correction's
 * arrival can tell which two tickers' caches need re-deriving.
 */
export function resolveCurrentTicker(all: RawTransaction[], transaction: RawTransaction, excludeCorrectionId?: string): string | undefined {
  const corrections = all.filter(
    (t) =>
      t.kind === "Correction" &&
      t.id !== excludeCorrectionId &&
      (t.payload as CorrectionPayload).targetId === transaction.id &&
      (t.payload as CorrectionPayload).patch.ticker !== undefined
  );
  if (corrections.length === 0) return transaction.ticker;
  const latest = corrections.reduce((a, b) => (b.seq > a.seq ? b : a));
  return (latest.payload as CorrectionPayload).patch.ticker;
}

/**
 * Finds a live SellExecution fact matching `match` (ticker/date/shares/price)
 * that no live SellAllocationDecision has already claimed via its own
 * `sellExecutionId` — i.e. a candidate fact genuinely available for a new
 * sell action to ADOPT (preserving whatever real source it already carries,
 * e.g. an Import-written "official-broker-excel" fact) instead of the caller
 * unconditionally minting a fresh one whose source it would have to guess or
 * hardcode.
 *
 * This is the single, universal fix for a whole class of bug: any ticker
 * whose Buy/Sell history should be 100% traceable to one originating
 * document (see reconciliation.ts's isTickerFullyOfficialBrokerExcelSourced)
 * silently lost that provenance the moment ANY code path recorded a sell
 * allocation with a hardcoded source instead of reusing the fact already
 * written for it at import/extraction time — regardless of which specific
 * ticker, how many times re-imported, or which UI recorded the allocation.
 *
 * "Claimed" (already the target of a live decision) is what makes repeat
 * calls safe for two genuinely different, coincidentally identical-value
 * sells recorded and allocated together in one atomic action (see
 * TradeService.ensureSellFacts, this function's only caller today): the
 * first call's decision claims the shared candidate fact; a second call for
 * the same value then correctly finds it already claimed and gets
 * `undefined`, so ITS caller mints its own new fact instead of silently
 * reusing (and merging into) the first sell's. An earlier version of this
 * exact dedup attempt (see ensureSellFacts's own doc comment) skipped this
 * "claimed" check and caused a real regression — orphaning the second sell's
 * allocations. Deliberately NOT used for a "record now, allocate later"
 * two-step flow (see lotManager.ts's recordSellTransaction) — a sell can sit
 * unallocated (and therefore unclaimed) there for a while by design, so
 * "unclaimed" would incorrectly mean "still pending," not "available to
 * adopt," risking the exact collision this function exists to prevent.
 */
export function findUnclaimedSellExecutionFact(
  all: RawTransaction[],
  match: { ticker: string; executionDate: string; shares: number; price: number; executionTime?: string },
): RawTransaction | undefined {
  const ticker = normalizeTicker(match.ticker);
  const claimedIds = new Set(
    all
      .filter((t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id))
      .map((t) => (t.payload as SellAllocationDecisionPayload).sellExecutionId),
  );
  const candidates = all.filter((t) => {
    if (t.kind !== "SellExecution") return false;
    if (isRetracted(all, t.id)) return false;
    // Resolved through any live Correction, not read from t.ticker directly
    // — a fact's own ticker field is immutable, so a candidate written
    // under a since-corrected ticker (e.g. an OCR misread fixed via
    // TradeService.renameTickerEverywhere) would otherwise never match
    // again under its current, corrected name. Same bug class as
    // reconciliation.ts's isTickerFullyOfficialBrokerExcelSourced.
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== ticker) return false;
    if (claimedIds.has(t.id)) return false;
    const p = t.payload as SellExecutionPayload;
    return p.executionDate === match.executionDate && p.shares === match.shares && p.price === match.price;
  });
  // Ticker/date/shares/price alone doesn't distinguish two genuinely
  // different real Sells sharing every one of those fields (e.g. two
  // same-price fills minutes apart) — prefer whichever candidate's own
  // executionTime actually agrees with match.executionTime, same fix as
  // TradeService.ensureBuyFact's liveMatch and ledgerProjection.ts's
  // resolveExistingTradeForLot. Falls back to the first candidate,
  // unchanged from prior behavior, when time can't disambiguate.
  if (candidates.length <= 1) return candidates[0];
  return candidates.find((t) => !timesConflict(match.executionTime, (t.payload as SellExecutionPayload).executionTime)) ?? candidates[0];
}

/**
 * Finds the live Buy/Sell execution fact already describing one real
 * execution (ticker/date/shares/price) — no "claimed" concept, unlike
 * findUnclaimedSellExecutionFact above (that one guards a two-step
 * record-then-allocate flow; this is for READING which fact already exists,
 * e.g. to compare Evidence Authority — see evidenceAuthority.ts — against a
 * newly-extracted duplicate of the same execution).
 *
 * `excludeId` must be passed whenever the caller's own new candidate has
 * ALREADY been written as a live fact with the identical signature (e.g.
 * Import's extraction-time write, see importRecording.ts) — repository
 * reads are never guaranteed to come back in insertion order (Dexie's
 * `getAll()` returns primary-key order, i.e. `id` string order, not `seq`
 * order), so an unguarded `.find()` can match the caller's OWN fact instead
 * of the other, genuinely pre-existing one it's trying to compare against.
 */
export function findLiveExecutionFact(
  all: RawTransaction[],
  match: { kind: "BuyExecution" | "SellExecution"; ticker: string; date: string; shares: number; price: number; time?: string },
  excludeId?: string,
): RawTransaction | undefined {
  const ticker = normalizeTicker(match.ticker);
  const candidates = all.filter((t) => {
    if (t.id === excludeId) return false;
    if (t.kind !== match.kind) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== ticker) return false;
    const p = t.payload as BuyExecutionPayload | SellExecutionPayload;
    return p.executionDate === match.date && p.shares === match.shares && p.price === match.price;
  });
  // Same time-blind-value-key fix as findUnclaimedSellExecutionFact above —
  // prefer whichever candidate's own executionTime actually agrees with
  // match.time when more than one shares the plain value.
  if (candidates.length <= 1) {
    const candidate = candidates[0];
    if (!candidate) return undefined;
    const payload = candidate.payload as BuyExecutionPayload | SellExecutionPayload;
    return timesConflict(match.time, payload.executionTime) ? undefined : candidate;
  }
  return candidates.find(
    (t) => !timesConflict(match.time, (t.payload as BuyExecutionPayload | SellExecutionPayload).executionTime),
  );
}

/**
 * Every live SellExecution fact for `ticker` that no live SellAllocationDecision
 * currently claims — i.e. a sell the broker/document already confirms
 * happened, but whose lot(s) have never been chosen (ADR-002: allocation is
 * always an explicit, never-inferred user decision, so this can never be
 * auto-resolved here, only reported).
 *
 * This is the single, canonical, fact-log-derived answer to "does this
 * ticker still need a Smart Allocate / Allocate Sell action" — the one thing
 * that was previously answered two different ways in two different places
 * (verificationEngine.ts's TickerStatus, and ImportPage.tsx's own
 * client-side-only importSession bookkeeping), which could silently drift:
 * checkTickerMatch's own net-share arithmetic can report a ticker "matched"
 * purely from SellExecution facts existing (see importVerification.ts's own
 * doc comment — that arithmetic never looks at SellAllocationDecision at
 * all), and ImportPage's addedKeys/skippedKeys session tracking can mark a
 * sell row "done" the moment TradeService.recordSell *returns*, even if the
 * fact-log write inside it silently failed (see TradeService.ensureSellFacts).
 * Neither of those was ever wrong about what it measures — they just don't
 * measure allocation completeness, which only this function does, from the
 * one place that can never drift: the append-only fact log itself.
 *
 * "Unallocated" means the live decision(s) pointed at a sell don't yet cover
 * its own full share count, not merely "at least one decision exists" — the
 * Lot Manager (lotManager.setSellAllocation) legitimately supports partial
 * allocation (`totalRequested > sell.shares` is rejected, `<` is not), so a
 * sell can have a live decision covering only part of itself. Summing every
 * live decision's allocated shares per `sellExecutionId` (there can
 * legitimately be more than one live decision for the same sell — e.g. two
 * separate Lot Manager edits that were never meant to replace each other) is
 * what this earlier, simpler "any decision at all" check missed.
 */
export function findUnallocatedSellExecutions(all: RawTransaction[], ticker: string): RawTransaction[] {
  const normalized = normalizeTicker(ticker);
  const allocatedSharesBySellId = new Map<string, number>();
  for (const t of all) {
    if (t.kind !== "SellAllocationDecision" || isRetracted(all, t.id)) continue;
    const payload = t.payload as SellAllocationDecisionPayload;
    const sharesInThisDecision = payload.allocations.reduce((sum, a) => sum + a.shares, 0);
    allocatedSharesBySellId.set(
      payload.sellExecutionId,
      (allocatedSharesBySellId.get(payload.sellExecutionId) ?? 0) + sharesInThisDecision,
    );
  }
  return all.filter((t) => {
    if (t.kind !== "SellExecution") return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== normalized) return false;
    const sellShares = (t.payload as SellExecutionPayload).shares;
    const allocatedShares = allocatedSharesBySellId.get(t.id) ?? 0;
    return allocatedShares < sellShares - 1e-6;
  });
}

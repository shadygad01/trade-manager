import type { RawTransaction, RetractionPayload, CorrectionPayload, SellExecutionPayload, SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";

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
  match: { ticker: string; executionDate: string; shares: number; price: number },
): RawTransaction | undefined {
  const ticker = normalizeTicker(match.ticker);
  const claimedIds = new Set(
    all
      .filter((t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id))
      .map((t) => (t.payload as SellAllocationDecisionPayload).sellExecutionId),
  );
  return all.find((t) => {
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
}

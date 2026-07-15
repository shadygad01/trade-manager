import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { PositionAggregate } from "./TradeService";
import { checkTickerMatch } from "./importVerification";
import { suggestRemovalsToReconcile, MAX_RECONCILE_ROWS, type ReconcilableRow } from "./mismatchResolver";
import { isRetracted, resolveCurrentTicker } from "./rawTransactionFolds";
import { authorityRank } from "./evidenceAuthority";
import { timesConflict } from "./duplicateDetection";

const OFFICIAL_BROKER_EXCEL_RANK = authorityRank("official-broker-excel");

/** A lower-authority fact with a live, higher-authority twin for the same time-resolved execution is redundant evidence. The durable authority sweep retracts it later; the read-side trust policy must not request a broker screenshot in the meantime. */
function hasHigherAuthorityTwin(
  all: RawTransaction[],
  fact: RawTransaction,
  ticker: string,
  options?: { requireRetracted?: boolean; requireKnownTimes?: boolean },
): boolean {
  if (fact.kind !== "BuyExecution" && fact.kind !== "SellExecution") return false;
  const payload = fact.payload as BuyExecutionPayload | SellExecutionPayload;
  return all.some((candidate) => {
    if (candidate.id === fact.id || candidate.kind !== fact.kind) return false;
    if (options?.requireRetracted ? !isRetracted(all, candidate.id) : isRetracted(all, candidate.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, candidate);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== ticker) return false;
    const candidatePayload = candidate.payload as BuyExecutionPayload | SellExecutionPayload;
    return (
      candidatePayload.executionDate === payload.executionDate &&
      candidatePayload.shares === payload.shares &&
      candidatePayload.price === payload.price &&
      (!options?.requireKnownTimes ||
        (payload.executionTime !== undefined &&
          candidatePayload.executionTime !== undefined &&
          payload.executionTime !== "00:00" &&
          candidatePayload.executionTime !== "00:00")) &&
      !timesConflict(candidatePayload.executionTime, payload.executionTime) &&
      authorityRank(candidate.source) > authorityRank(fact.source)
    );
  });
}

function isShadowedByHigherAuthorityTwin(all: RawTransaction[], fact: RawTransaction, ticker: string): boolean {
  return hasHigherAuthorityTwin(all, fact, ticker, { requireKnownTimes: true });
}

/**
 * A prior import can leave an immutable higher-authority fact retracted while
 * its exact lower-authority migration twin remains live.  The execution is
 * still covered by the broker document in the fact log; treating the orphaned
 * backfill as an uncovered execution would incorrectly reopen the screenshot
 * gate (the ACAMD/ACAMD class of bug).  Conflicting known execution times are
 * still kept separate by `timesConflict`.
 */
function isCoveredByRetractedHigherAuthorityTwin(all: RawTransaction[], fact: RawTransaction, ticker: string): boolean {
  return hasHigherAuthorityTwin(all, fact, ticker, { requireRetracted: true });
}

/**
 * True only when every live Buy/Sell RawTransaction fact for this ticker is
 * at least as authoritative as the broker's own official Excel export (see
 * ThndrOrdersWorkbookParser.ts and evidenceAuthority.ts's ranking) — the "My
 * Position" screenshot verification workflow no longer applies to such a
 * ticker at all, per the broker-record trust policy: the executed-BUY-minus-
 * executed-SELL count from documents this trustworthy already IS the
 * confirmed position, regardless of whether a screenshot exists, agrees, or
 * disagrees. Deliberately rank-based rather than an exact `source ===
 * "official-broker-excel"` match: a ticker whose sole surviving history is an
 * Invoice (rank 6, strictly above the Excel export's rank 5 — see
 * evidenceAuthority.ts) is real, found evidence of the same closed-position
 * dead-end this function exists to fix, just one authority tier higher than
 * the case it was originally written for. False for a ticker with zero facts
 * (nothing to be "fully" anything of) or any fact sourced below that bar — a
 * ticker with even one manual/screenshot/lower-tier execution still goes
 * through ordinary reconciliation.
 *
 * Resolves each fact's CURRENT ticker via `resolveCurrentTicker` (folding
 * any live Correction) rather than reading `payload.ticker` directly — a
 * fact's own `ticker` field is immutable and never rewritten in place (e.g.
 * TradeService.renameTickerEverywhere's wrong-ticker fix is its own separate
 * Correction fact), so reading it raw silently stops recognizing an
 * Excel-sourced ticker's facts the moment it's ever renamed/corrected.
 */
export function isTickerFullyOfficialBrokerExcelSourced(rawTransactions: RawTransaction[], ticker: string): boolean {
  const normalized = normalizeTicker(ticker);
  const live = rawTransactions.filter((t) => {
    if (t.kind !== "BuyExecution" && t.kind !== "SellExecution") return false;
    if (isRetracted(rawTransactions, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(rawTransactions, t);
    return resolvedTicker !== undefined && normalizeTicker(resolvedTicker) === normalized;
  });
  return (
    live.length > 0 &&
    live.every(
      (t) =>
        authorityRank(t.source) >= OFFICIAL_BROKER_EXCEL_RANK ||
        isShadowedByHigherAuthorityTwin(rawTransactions, t, normalized) ||
        isCoveredByRetractedHigherAuthorityTwin(rawTransactions, t, normalized),
    )
  );
}

/**
 * Read-side recovery for an old import whose official fact was retracted or
 * never persisted, while the same execution is still present in the current
 * official broker workbook.  This is intentionally stricter than merely
 * seeing an official row: every live lower-authority execution must match an
 * official candidate on the immutable execution fields, so an unrelated
 * manual/backfill trade can never be hidden by a fresh upload.
 */
export function isTickerOfficialBrokerExcelCoveredByCandidates(
  rawTransactions: RawTransaction[],
  ticker: string,
  candidates: ParsedTradeCandidate[],
): boolean {
  const normalized = normalizeTicker(ticker);
  const official = candidates.filter(
    (candidate) => normalizeTicker(candidate.ticker) === normalized && candidate.source === "official-broker-excel",
  );
  if (official.length === 0) return false;

  const live = rawTransactions.filter((fact) => {
    if (fact.kind !== "BuyExecution" && fact.kind !== "SellExecution") return false;
    if (isRetracted(rawTransactions, fact.id)) return false;
    const resolvedTicker = resolveCurrentTicker(rawTransactions, fact);
    return resolvedTicker !== undefined && normalizeTicker(resolvedTicker) === normalized;
  });
  if (live.length === 0) return false;
  // If a live official/invoice fact is already present, let the normal
  // provenance-upgrade effect finish retracting any lower twin first. Using
  // the session fallback during that short write window would make the UI
  // report "Fully matched" before the old fact was actually retracted.
  if (live.some((fact) => authorityRank(fact.source) >= OFFICIAL_BROKER_EXCEL_RANK)) return false;

  return live.every((fact) => {
    const payload = fact.payload as BuyExecutionPayload | SellExecutionPayload;
    const side = fact.kind === "BuyExecution" ? "BUY" : "SELL";
    return official.some(
      (candidate) =>
        candidate.side === side &&
        candidate.shares === payload.shares &&
        candidate.price === payload.price &&
        candidate.date === payload.executionDate &&
        !timesConflict(candidate.time, payload.executionTime),
    );
  });
}

export interface PositionReconciliation {
  ticker: string;
  /** The specific PositionVerification record this reconciliation is based on — lets the UI offer a direct delete for a stray/misfiled verification (see PortfolioDetailPage's "no recorded trades" banner). */
  verificationId: string;
  computedShares: number;
  verifiedUnits: number;
  verifiedAvgCost?: number;
  verificationCapturedAt: string;
  verificationSource: "screenshot" | "manual";
  /** Computed shares exceed the broker's verified units — a duplicate or misparsed trade is likely. */
  quantityMismatch: boolean;
  /** Computed shares fall short of the broker's verified units — the ledger is missing a trade. */
  quantityShortfall: boolean;
  /** A trade/allocation for this ticker was recorded after the screenshot was captured, so a gap is expected, not a bug — mismatch/shortfall are suppressed. */
  verificationStale: boolean;
}

export interface PendingConfirmation {
  ticker: string;
  side: "BUY" | "SELL";
  date: string;
  time: string;
  shares: number;
  price: number;
  /** The Trade id (BUY) or sellGroupId (SELL) to pass into confirmPendingBuy/confirmPendingSell. */
  refId: string;
}

/**
 * Every Trade/TradeAllocation still `confirmationStatus: "pending"` — a
 * partial-fill execution imported from STES (Extraction Notes = "Needs
 * Confirmation") whose exact final numbers await the broker invoice.
 * Independent of `reconcilePositions`: that function only ever produces a
 * row for a ticker with a broker "My Position" screenshot on file, but a
 * pending confirmation has nothing to do with that and must surface
 * regardless of whether one exists.
 */
export function findPendingConfirmations(trades: Trade[], allocations: TradeAllocation[]): PendingConfirmation[] {
  const results: PendingConfirmation[] = [];

  for (const trade of trades) {
    if (trade.confirmationStatus !== "pending") continue;
    results.push({
      ticker: trade.ticker,
      side: "BUY",
      date: trade.executionDate,
      time: trade.executionTime,
      shares: trade.shares,
      price: trade.entryPrice,
      refId: trade.id,
    });
  }

  const pendingBySellGroup = new Map<string, TradeAllocation[]>();
  for (const allocation of allocations) {
    if (allocation.confirmationStatus !== "pending") continue;
    const group = pendingBySellGroup.get(allocation.sellGroupId) ?? [];
    group.push(allocation);
    pendingBySellGroup.set(allocation.sellGroupId, group);
  }
  for (const [sellGroupId, group] of pendingBySellGroup) {
    results.push({
      ticker: group[0].ticker,
      side: "SELL",
      date: group[0].executionDate,
      time: group[0].executionTime,
      shares: group.reduce((sum, a) => sum + a.sharesClosed, 0),
      price: group[0].exitPrice,
      refId: sellGroupId,
    });
  }

  return results;
}

/** The most recent PositionVerification per ticker — the same "which broker screenshot is ground truth" reduction reused by ledgerRebuild.ts's holdings diff. */
export function latestByTicker(verifications: PositionVerification[]): Map<string, PositionVerification> {
  const latest = new Map<string, PositionVerification>();
  for (const v of verifications) {
    const ticker = normalizeTicker(v.ticker);
    const existing = latest.get(ticker);
    if (!existing || v.capturedAt > existing.capturedAt) {
      latest.set(ticker, v);
    }
  }
  return latest;
}

/**
 * Ground-truth reconciliation: compares the trade-ledger-derived position for
 * each ticker against the most recent broker "My Position" screenshot for
 * that ticker. Never mutates the ledger — this only surfaces a discrepancy
 * for the user to investigate (e.g. a duplicate import, or a missing trade).
 *
 * The actual match/mismatch judgment is delegated to checkTickerMatch — the
 * same canonical function Import's live commit gate and the Evidence
 * Intelligence facade both use — instead of a second, independently
 * hand-rolled comparison. Everything already committed for this ticker is
 * treated as a single settled amount (existingRemainingShares =
 * computedShares, no separate "pending" batch — there is none once trades
 * are committed), so checkTickerMatch's netShares reduces to exactly
 * computedShares here. `verificationStale` — a real, additional concern
 * checkTickerMatch has no equivalent for (it always compares "as of right
 * now," with no notion of a screenshot predating trades recorded since) —
 * remains this module's own, layered on top: a mismatch a newer trade would
 * fully explain is suppressed rather than reported as a live discrepancy.
 *
 * A ticker fully sourced from the broker's own official Excel export (see
 * `isTickerFullyOfficialBrokerExcelSourced`) never produces a row at all,
 * regardless of any "My Position" screenshot on file — per the broker-record
 * trust policy, that whole comparison no longer applies once the Excel
 * export alone already confirms the position; a stray disagreeing
 * screenshot is not this module's concern to surface for such a ticker.
 * `rawTransactions` is deliberately REQUIRED, not optional/defaulted —
 * an architectural-audit finding was that a defaulted-to-`[]` parameter here
 * would let any future caller silently bypass the trust policy (an omitted
 * argument reading as "no ticker is Excel-sourced" with no compiler or
 * runtime signal anything was skipped) purely by forgetting to thread it
 * through, exactly the class of bug this whole policy has been about
 * eliminating. Every caller must explicitly supply the real data.
 */
export function reconcilePositions(
  positions: PositionAggregate[],
  verifications: PositionVerification[],
  trades: Trade[],
  allocations: TradeAllocation[],
  rawTransactions: RawTransaction[]
): PositionReconciliation[] {
  const verificationByTicker = latestByTicker(verifications);
  const computedByTicker = new Map(positions.map((p) => [p.ticker, p.totalShares]));
  const tickers = new Set([...computedByTicker.keys(), ...verificationByTicker.keys()]);

  const results: PositionReconciliation[] = [];
  for (const ticker of tickers) {
    if (isTickerFullyOfficialBrokerExcelSourced(rawTransactions, ticker)) continue;
    const verification = verificationByTicker.get(ticker);
    if (!verification) continue;

    const computedShares = computedByTicker.get(ticker) ?? 0;

    // Timestamps are plain "YYYY-MM-DDTHH:MM" / ISO strings, not Date objects
    // — string comparison is safe here because both are zero-padded and
    // share the same YYYY-MM-DD prefix ordering.
    const hasNewerActivity =
      trades.some(
        (t) => normalizeTicker(t.ticker) === ticker && `${t.executionDate}T${t.executionTime}` > verification.capturedAt
      ) ||
      allocations.some(
        (a) => normalizeTicker(a.ticker) === ticker && `${a.executionDate}T${a.executionTime}` > verification.capturedAt
      );

    const match = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 0,
      pendingSellShares: 0,
      existingRemainingShares: computedShares,
      verifiedUnits: verification.units,
      verifiedAvgCost: verification.avgCost,
    });

    results.push({
      ticker,
      verificationId: verification.id,
      computedShares,
      verifiedUnits: verification.units,
      verifiedAvgCost: verification.avgCost,
      verificationCapturedAt: verification.capturedAt,
      verificationSource: verification.source,
      quantityMismatch: !hasNewerActivity && match.discrepancySide === "buy" && !match.matched,
      quantityShortfall: !hasNewerActivity && match.discrepancySide === "sell" && !match.matched,
      verificationStale: hasNewerActivity,
    });
  }
  return results;
}

/**
 * When a ticker's computed share count exceeds the broker's verified units
 * (quantityMismatch), one or more of the open trades is almost always an
 * extra fill from a duplicate import — the same statement re-uploaded more
 * than once produces more than one duplicate of the same real trade, not
 * just one. The same real trade parsed from two documents tends to differ
 * only by which one's price rounding won, so the lower-priced reads are the
 * more likely duplicates to delete, leaving the highest (most plausible,
 * post-commission) price on the ledger.
 *
 * Returns every trade needed to close the whole gap in one pass — not just
 * the single lowest-priced one — by removing lowest-priced deletable trades
 * (nothing sold against them yet) until computed shares reach the verified
 * count. Skips a trade that would remove more shares than the remaining gap
 * (which would turn the mismatch into a shortfall instead of resolving it)
 * and tries the next-lowest-priced one instead, so a caller can safely
 * delete every returned id without ever overshooting.
 */
export function suggestDuplicateTradeIds(params: {
  openTrades: { id: string; entryPrice: number; shares: number; remainingShares: number }[];
  computedShares: number;
  verifiedUnits: number;
  verifiedAvgCost?: number;
}): string[] {
  const deletable = [...params.openTrades].filter((t) => t.remainingShares === t.shares);

  // Prefer the canonical, avg-cost-ranked, alternatives-aware solver
  // (mismatchResolver.suggestRemovalsToReconcile — the same one Import's own
  // reconcile banner uses) only when it actually has a ranking signal to
  // exploit (a broker-verified avg cost) and its exhaustive-subset search
  // can cover every deletable trade. Without an avg cost, that solver has NO
  // price-preference signal at all and picks an arbitrary valid subset —
  // strictly worse than this module's own lowest-price-first heuristic,
  // which encodes a real, sound rule for exactly this common case (the same
  // real trade re-read from a duplicate document differs mostly in price
  // rounding; the lower reads are the more likely duplicates, leaving the
  // highest, most-plausible post-commission price on the ledger). So the
  // greedy heuristic remains primary whenever there's no avg cost to rank
  // by, and is also the fallback above MAX_RECONCILE_ROWS (2^n search),
  // where the canonical solver declines to run at all.
  if (params.verifiedAvgCost !== undefined && deletable.length > 0 && deletable.length <= MAX_RECONCILE_ROWS) {
    const rows: ReconcilableRow[] = deletable.map((t) => ({ key: t.id, side: "BUY", shares: t.shares, price: t.entryPrice }));
    const suggestion = suggestRemovalsToReconcile({
      rows,
      existingRemainingShares: 0,
      verifiedUnits: params.verifiedUnits,
      verifiedAvgCost: params.verifiedAvgCost,
    });
    if (suggestion) return suggestion.keysToRemove;
  }

  const sorted = [...deletable].sort((a, b) => a.entryPrice - b.entryPrice);
  const ids: string[] = [];
  let remaining = params.computedShares;
  for (const t of sorted) {
    if (remaining <= params.verifiedUnits) break;
    if (remaining - t.shares < params.verifiedUnits) continue;
    ids.push(t.id);
    remaining -= t.shares;
  }
  return ids;
}

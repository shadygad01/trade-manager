import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { UploadCloud, FileText, ShieldCheck, ShieldAlert, CheckCircle2, Loader2, RotateCcw, CircleDollarSign, History, Pencil, Trash2, XCircle, Eraser, ChevronDown } from "lucide-react";
import { repos, diagnostics, getImportOrchestrator, purgeTickerData } from "@presentation/lib/data";
import { recordBuy, recordSell, deleteTrade, renameTickerEverywhere } from "@application/services/TradeService";
import { recordDividend } from "@application/services/PortfolioService";
import { recordImportedRawTransactions, candidateSource } from "@application/services/importRecording";
import { createPendingExecutionRecord } from "@application/services/pendingExecutions";
import { assignPortfolio, assignPortfolioToFact, retractRawTransaction, resolveCurrentPortfolioId } from "@application/services/commitEngine";
import {
  findDuplicateBuyMatch,
  findDuplicateSellMatch,
  pricesWithinOcrNoise,
  dividendContentKey,
  buildExistingDividendKeys,
  suggestDuplicatePendingCandidateKeysToDelete,
  completeCandidateFieldsFromSiblings,
  findCrossSourceVerifiedKeys,
  findAggregateStatementMatches,
  keysToRaiseToHighConfidence,
  findWrongTickerCandidateKeys,
  findDateMisreadDuplicateHints,
  findOfficialBrokerExcelReuploadDuplicateKeys,
  parseTimeToMinutes,
} from "@application/services/duplicateDetection";
import { checkTickerMatch, isTickerFullyResolved, type TickerMatchStatus } from "@application/services/importVerification";
import { isTickerFullyOfficialBrokerExcelSourced } from "@application/services/reconciliation";
import { findLiveExecutionFact } from "@application/services/rawTransactionFolds";
import { higherAuthority } from "@application/services/evidenceAuthority";
import { upgradeSellExecutionFact } from "@application/services/provenanceRepair";
import { runSerialized } from "@application/services/serialize";
import {
  orderEvidenceContentKey,
  findOrderConfirmedKeys,
  findOrphanedFulfilledEvidence,
  findWrongTickerHintsFromOrders,
} from "@application/services/orderEvidence";
import { suggestRemovalsToReconcile, MAX_RECONCILE_ROWS, type ReconcileSuggestion } from "@application/services/mismatchResolver";
import { findLastBalancedDate } from "@application/services/netShareTimeline";
import { buildTickerConstraintReport, type TickerConstraintReport } from "@application/services/constraintValidation";
import { assessTickerCompleteness, type TickerCompletenessReport } from "@application/services/completenessEngine";
import type { TickerStatus } from "@application/services/verificationEngine";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { tickerForCompanyNameFallback } from "@domain/value-objects/knownTickers";
import { isBeforeTrackingStart } from "@domain/value-objects/trackingWindow";
import { useTrackingStartDate, trackingStartDateStore } from "@presentation/lib/trackingStartDateStore";
import type { ParsedTradeCandidate, ParsedOrderEvidence, Upload } from "@domain/entities/Upload";
import type { Trade } from "@domain/entities/Trade";
import type { RecordSellInput } from "@presentation/lib/types";
import {
  importSession,
  useImportSession,
  type CandidateEntry,
  type VerificationEntry,
  type DividendEntry,
  type OrderEvidenceEntry,
} from "@presentation/lib/importSession";
import { PageHeader } from "@presentation/components/PageHeader";
import { Modal } from "@presentation/components/Modal";
import { EmptyState } from "@presentation/components/EmptyState";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { STATUS } from "@presentation/lib/chartColors";
import { useT, type TFunction } from "@presentation/i18n/translations";

const CONFIDENCE_COLOR: Record<"high" | "medium" | "low", string> = {
  high: STATUS.good,
  medium: STATUS.warning,
  low: STATUS.critical,
};

function confidenceLabel(t: TFunction, confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return t("importPage.confidenceHigh");
  if (confidence === "medium") return t("importPage.confidenceMedium");
  return t("importPage.confidenceLow");
}

type Stage = "idle" | "reading" | "error";

/**
 * A sell can only close a lot that already existed when the sell happened.
 * Keep an unknown same-day time eligible: it is not evidence that the buy
 * happened later, whereas a known later time is decisive.
 */
export function isLotEligibleForSell(
  lot: Pick<Trade, "executionDate" | "executionTime">,
  sell: Pick<ParsedTradeCandidate, "date" | "time">,
): boolean {
  if (lot.executionDate !== sell.date) return lot.executionDate < sell.date;
  const lotMinutes = parseTimeToMinutes(lot.executionTime);
  const sellMinutes = sell.time ? parseTimeToMinutes(sell.time) : undefined;
  return lotMinutes === undefined || sellMinutes === undefined || lotMinutes <= sellMinutes;
}

/**
 * Position-verification and dividend candidates carry no per-transaction
 * identity of their own (unlike a Buy/Sell, which has a date+price+shares
 * to distinguish one execution from another) â€” re-uploading the same "My
 * Position" screenshot (a re-take, an accidental double-drop, or the same
 * PDF page appearing twice) re-extracts an identical reading every time.
 * These keys let processFiles() recognize "this is the same observation
 * already in the pool" and skip adding a redundant duplicate, rather than
 * piling up N identical "Accept as ground truth" rows for one real position.
 */
function verificationContentKey(v: { ticker: string; units: number; avgCost?: number }): string {
  return `${normalizeTicker(v.ticker)}|${v.units}|${v.avgCost ?? ""}`;
}

/**
 * Phase 9.7: every Skip/Dismiss/Discard action calls this so the canonical
 * RawTransaction history reflects the same intent the localStorage session
 * already records â€” a retracted row is permanently excluded from
 * VerificationEngine/CommitEngine (see rawTransactionFolds.isRetracted), the
 * same fold every other reader of the raw log already applies. Fire-and-
 * forget, isolated, non-fatal â€” same shadow-write discipline as every other
 * dual-write in this migration (assignPortfolio, recordImportedRawTransactions):
 * a failure here must never break today's working Import behavior, which
 * still reads only from the localStorage pending pool. Each `key` here is
 * expected to equal the RawTransaction id recordImportedRawTransactions wrote
 * for it (see importRecording.ts) â€” a key from before that change shipped
 * simply retracts nothing (no RawTransaction has that id), which is inert,
 * not harmful.
 */
function retractRawTransactionKeys(keys: Iterable<string>) {
  for (const key of keys) {
    retractRawTransaction(repos, key, undefined, diagnostics).catch((err) => {
      console.error("retractRawTransaction failed (shadow write, non-fatal):", err);
    });
  }
}

/**
 * Guards the batch commit against a genuine race: two triggers (e.g. a
 * duplicate Confirm click, or a rename firing while a commit is already in
 * flight) could otherwise both see the same entry as "not yet added" and
 * call recordBuy/recordDividend/acceptVerification on it twice, since the
 * check-then-act happens across an await. Module-level (not React state,
 * which only updates asynchronously) so the guard is synchronous: an entry
 * is marked in-flight before its first await and cleared in a finally,
 * regardless of how many times commitTickerGroup gets invoked concurrently.
 */
const inFlightKeys = new Set<string>();

/**
 * Import runs as a strict two-phase workflow: (1) extract â€” drop as many
 * files as needed; every candidate/verification accumulates into one pool,
 * confirmed complete by the running "N transactions from M files" count â€”
 * then (2) verify & distribute â€” group everything by ticker, assign ONE
 * portfolio per ticker (so a stock's sells automatically travel with its
 * buys), and reconcile each ticker's extracted share count against a broker
 * "My Position" screenshot. Nothing is written to a portfolio until every
 * ticker's count matches its screenshot exactly and the user explicitly
 * clicks "Confirm â€” Distribute to Portfolios" â€” see tickerMatchStatuses and
 * confirmAndDistributeAll. A Sell always still opens its own allocation
 * modal (ADR-002 â€” this app never auto-picks which lot a sell closes).
 *
 * The pool itself lives in `importSession` (module-level, localStorage-backed),
 * not component state â€” a user often needs to leave this page mid-import to
 * create a portfolio to distribute into, and plain useState would have thrown
 * away everything extracted so far the moment the page unmounted.
 */
export function ImportPage() {
  const t = useT();
  const trackingStartDate = useTrackingStartDate();
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [queueProgress, setQueueProgress] = useState<{ index: number; total: number; fileName: string } | null>(null);
  const [recentFileResults, setRecentFileResults] = useState<{ fileName: string; warnings: string[]; duplicate: boolean }[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [sellCandidate, setSellCandidate] = useState<{ key: string; ticker: string; portfolioId: string; candidate: ParsedTradeCandidate } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [distributing, setDistributing] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);

  const session = useImportSession();
  const { pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences, tickerPortfolio, filesProcessed } = session;

  /**
   * Every extraction path already filters a Buy/Sell candidate dated before
   * the configured tracking start date at parse time (see
   * trackedDateRange.ts) â€” but ThndrParser's dividend extraction didn't,
   * until a real out-of-range dividend reached this pool, sat there looking
   * normal, and only surfaced as a thrown error the moment the user tried to
   * confirm it. Silently dropping any out-of-range candidate/dividend still
   * sitting in the pool â€” regardless of which extraction path let it
   * through, including ones already stuck in a session from before this fix
   * â€” means there's never a row that can only ever fail to commit. Also
   * re-runs whenever the user lowers/raises the start date on this page, so
   * rows that fall outside the newly-picked range are dropped immediately
   * rather than surviving until the next file is imported.
   */
  useEffect(() => {
    const hasStaleCandidates = pendingCandidates.some((e) => isBeforeTrackingStart(e.candidate.date));
    const hasStaleDividends = pendingDividends.some((e) => isBeforeTrackingStart(e.dividend.date));
    if (!hasStaleCandidates && !hasStaleDividends) return;
    importSession.update((prev) => ({
      ...prev,
      pendingCandidates: prev.pendingCandidates.filter((e) => !isBeforeTrackingStart(e.candidate.date)),
      pendingDividends: prev.pendingDividends.filter((e) => !isBeforeTrackingStart(e.dividend.date)),
    }));
  }, [pendingCandidates, pendingDividends, trackingStartDate]);

  const addedKeys = useMemo(() => new Set(session.addedKeys), [session.addedKeys]);
  const acceptedKeys = useMemo(() => new Set(session.acceptedKeys), [session.acceptedKeys]);
  const skippedKeys = useMemo(() => new Set(session.skippedKeys), [session.skippedKeys]);
  const dismissedKeys = useMemo(() => new Set(session.dismissedKeys), [session.dismissedKeys]);

  const portfoliosRaw = useLiveQuery(() => repos.portfolios.getAll(), []);
  const portfolios = portfoliosRaw ?? [];

  // Loaded across every portfolio so a candidate is flagged as a possible
  // duplicate regardless of which portfolio it's ultimately assigned to.
  const existingTradesRaw = useLiveQuery(() => repos.trades.getAll(), []);
  const existingTrades = existingTradesRaw ?? [];
  const existingAllocationsRaw = useLiveQuery(() => repos.allocations.getAll(), []);
  const existingAllocations = existingAllocationsRaw ?? [];
  // The legacy Trade/TradeAllocation entities carry no provenance field at
  // all â€” this is the only way to know a ticker's ALREADY-COMMITTED history
  // (as opposed to this batch's still-pending candidates) came entirely from
  // the official broker Excel export (see tickerMatchStatuses below, and
  // reconciliation.ts's own doc comment on isTickerFullyOfficialBrokerExcelSourced).
  const existingRawTransactionsRaw = useLiveQuery(() => repos.rawTransactions.getAll(), []);
  const existingRawTransactions = existingRawTransactionsRaw ?? [];
  // Ground truth for the verification gate below â€” a broker "My Position"
  // screenshot accepted in an earlier session still counts as this ticker's
  // reference even if this batch re-extracts more buys/sells for it.
  const existingVerificationsRaw = useLiveQuery(() => repos.verifications.getAll(), []);
  const existingVerifications = existingVerificationsRaw ?? [];
  // A dividend already recorded in an earlier import session is otherwise
  // invisible to the in-session dedup below (seenDividendKeys), which only
  // ever sees the current batch's pending pool â€” the same broker statement
  // re-uploaded weeks later (its dividend history overlapping what's already
  // recorded) would silently double-count real cash. Global like existingTrades:
  // a real dividend payment happened once regardless of which portfolio it's filed under.
  const existingTimelineRaw = useLiveQuery(() => repos.timeline.getAll(), []);
  const existingDividendKeys = useMemo(() => buildExistingDividendKeys(existingTimelineRaw ?? []), [existingTimelineRaw]);

  /**
   * useLiveQuery returns undefined until its first read resolves, then an
   * array from then on â€” including a genuinely empty one. The verification
   * gate and commit logic must tell those apart: firing while any of these
   * is still undefined would decide duplicate/portfolio-resolution/match
   * status off of default-empty data (e.g. missing an already-recorded
   * exact-duplicate trade because existingTrades briefly reads as [] before
   * its first real load), and by the time the real data arrives a row
   * committed off the stale read is no longer eligible for reconsideration.
   *
   * existingRawTransactionsRaw belongs in this list for exactly the same
   * reason: tickerMatchStatuses' historical-fallback branch
   * (isTickerFullyOfficialBrokerExcelSourced) reads existingRawTransactions,
   * and each useLiveQuery resolves independently â€” a ticker whose complete
   * history is official-broker-excel-sourced but has nothing pending this
   * session would transiently read as "no-verification"/"closed-position"
   * (needs a screenshot) for however long this one query takes to resolve
   * after the others already have, purely because its default-empty read
   * ([]) can never satisfy isTickerFullyOfficialBrokerExcelSourced. Omitting
   * it here was a real, reproducible instance of the broker-record trust
   * policy being bypassed â€” not by wrong decision logic, but by feeding the
   * (correct) decision logic transiently-incomplete data. See docs/ROADMAP.md.
   */
  const initialDataLoaded =
    portfoliosRaw !== undefined &&
    existingTradesRaw !== undefined &&
    existingAllocationsRaw !== undefined &&
    existingVerificationsRaw !== undefined &&
    existingTimelineRaw !== undefined &&
    existingRawTransactionsRaw !== undefined;

  /**
   * `ownTradeId` (Buys) / `ownAllocationIds` (Sells) exclude a candidate's
   * own already-committed records from the comparison pool â€” without them, a
   * row that was itself just added would "match" the exact Trade/allocations
   * it just became (identical ticker/date/shares/price by construction),
   * showing a false "Duplicate" badge on a perfectly successful,
   * non-duplicate commit. Only matters for the per-row display after commit;
   * the pre-commit skip check in commitTickerGroup runs before this
   * candidate's own records exist, so it never needs an exclusion.
   */
  function duplicateMatch(candidate: ParsedTradeCandidate, ownTradeId?: string, ownAllocationIds?: string[]) {
    if (candidate.side === "BUY") {
      const trades = ownTradeId ? existingTrades.filter((t) => t.id !== ownTradeId) : existingTrades;
      return findDuplicateBuyMatch(candidate, trades);
    }
    const allocations = ownAllocationIds?.length
      ? existingAllocations.filter((a) => !ownAllocationIds.includes(a.id))
      : existingAllocations;
    return findDuplicateSellMatch(candidate, allocations);
  }

  /**
   * A pending Buy or Sell that's an exact duplicate of a trade/allocation
   * already on the ledger (same ticker/date/shares/price â€” e.g. the same
   * file, or the same real execution, re-imported) has nothing left to do:
   * committing it again would double-count real shares. This must run
   * BEFORE tickerMatchStatuses, not only at commit time inside
   * commitTickerGroup: an un-skipped duplicate still counts toward
   * pendingBuyShares/pendingSellShares in the net-share reconciliation,
   * which can hold a ticker at "Mismatch"/"Blocked â€” needs verification"
   * forever even when the ledger and a broker "My Position" screenshot
   * already agree exactly â€” commitTickerGroup's own skip only ever runs for
   * a ticker `tickerMatchStatuses` already reports as matched, so it can
   * never break that particular chicken-and-egg deadlock on its own (a real
   * gap found and reproduced during the reconciliation investigation: a
   * ticker whose only pending row was an exact re-import of an
   * already-fully-recorded, already-broker-verified position stayed
   * permanently "Mismatch"). Auto-marking the duplicate skipped here
   * resolves it the same way the Sell side already did on its own before
   * this was generalized to cover Buys too. This never commits anything
   * itself (ADR-002 â€” which lots a sell closes stays a manual decision for
   * a genuinely new Sell); it only closes a row whose real-world
   * transaction is already fully recorded. Gated on initialDataLoaded so a
   * briefly-empty trades/allocations read can't mislabel (or fail to label)
   * a row off stale data.
   *
   * `inFlightKeys` exclusion closes a real, reproduced race: commitTickerGroup's
   * own addBuyCandidate saves the Trade (repos.trades.save) several awaits
   * BEFORE it ever updates addedKeys â€” a window in which this effect's own
   * existingTrades dependency (a live Dexie query) can already see the
   * brand-new Trade and re-run before addedKeys catches up. Without this
   * guard, a candidate mid-commit briefly looks like "not yet added, and now
   * duplicates an existing trade" (the trade its OWN commit just wrote), so
   * this effect would skip it and retract its RawTransaction fact out from
   * under ensureBuyFact/ensureSellFacts â€” which then finds no live fact left
   * to adopt and mints a fresh one hardcoded to source "manual", silently
   * destroying the ticker's official-broker-excel provenance (reproduced:
   * an Excel-sourced ticker with nothing left pending immediately reads as
   * "Needs broker screenshot"/"Closed â€” needs corroborating evidence" right
   …40389 tokens truncated…late-300">@ {formatMoney(c.price)}</span>
          <span className="text-slate-400">{formatDate(c.date)}</span>
          {isLowConfidence ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              <ShieldAlert size={11} /> {t("importPage.lowConfidenceGuess")}
            </span>
          ) : c.confidence ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_COLOR[c.confidence] }} />
              {confidenceLabel(t, c.confidence)}
            </span>
          ) : null}
          {match ? (
            <span
              title={
                match.matchType === "exact"
                  ? t("importPage.exactMatchTitle")
                  : t("importPage.possibleMatchTitle")
              }
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
              }`}
            >
              <ShieldAlert size={11} /> {match.matchType === "exact" ? t("importPage.duplicate") : t("importPage.possibleDuplicate")}
            </span>
          ) : null}
          {canDiscard && !match ? (
            <span
              title={t("importPage.suspectedDuplicateTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suspectedDuplicate")}
            </span>
          ) : null}
          {stillPending && wrongTickerHint ? (
            <span
              title={t("importPage.likelyOthersTransactionTitle", { ticker: wrongTickerHint })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.likelyOthersTransaction", { ticker: wrongTickerHint })}
            </span>
          ) : null}
          {stillPending && dateMisreadHint ? (
            <span
              title={t("importPage.dateMisreadHintTitle", { date: formatDate(dateMisreadHint) })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.dateMisreadHint", { date: formatDate(dateMisreadHint) })}
            </span>
          ) : null}
          {stillPending && suggestedRemoval ? (
            <span
              title={t("importPage.suggestedRemovalTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suggestedRemoval")}
            </span>
          ) : null}
          {crossSourceVerified ? (
            <span
              title={t("importPage.crossSourceVerifiedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.twoDocumentsAgree")}
            </span>
          ) : null}
          {aggregateConfirmed ? (
            <span
              title={
                aggregateMatchDetail
                  ? t("importPage.aggregateConfirmedTitleDetail", { detail: aggregateMatchDetail })
                  : t("importPage.aggregateConfirmedTitle")
              }
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.aggregateConfirmed")}
            </span>
          ) : null}
          {orderConfirmed ? (
            <span
              title={t("importPage.orderConfirmedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <History size={11} /> {t("importPage.matchesOrdersHistory")}
            </span>
          ) : stillPending && noMatchingOrder ? (
            <span
              title={t("importPage.noMatchingOrderTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              <History size={11} /> {t("importPage.noMatchingOrder")}
            </span>
          ) : null}
        </div>
        {skipped ? (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <XCircle size={14} /> {t("importPage.skippedDuplicate")}
          </span>
        ) : dismissed ? (
          <span className="text-xs text-slate-600">{t("importPage.removed")}</span>
        ) : added ? (
          <span className="flex items-center gap-2 text-xs text-emerald-400">
            <span className="flex items-center gap-1">
              <CheckCircle2 size={14} /> {t("importPage.added")}
            </span>
            {isLowConfidence ? (
              <button
                onClick={onDelete}
                title={t("importPage.deleteTradeTitle")}
                className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </span>
        ) : canDiscard ? (
          <button
            onClick={onDiscardPending}
            title={t("importPage.discardDuplicateTitle")}
            className="flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 size={12} /> {t("importPage.discard")}
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            {!matched ? (
              <span className="text-xs text-amber-300">{t("importPage.blockedNeedsVerification")}</span>
            ) : !portfolioResolved ? (
              <span className="text-xs text-slate-500">{t("importPage.waitingForPortfolio")}</span>
            ) : distributing ? (
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <Loader2 size={13} className="animate-spin" /> {t("importPage.adding")}
              </span>
            ) : (
              <span className="text-xs text-slate-500">{t("importPage.readyClickConfirm")}</span>
            )}
            <button
              onClick={onDiscardPending}
              disabled={distributing}
              title={t("importPage.discardGenericTitle")}
              className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>
      {error ? <p className="mt-1.5 text-xs text-rose-400">{error}</p> : null}
    </div>
  );
}

/**
 * Sell is the one row type Import never batch-commits (see ImportPage's
 * commitTickerGroup doc comment) â€” which lot(s) it closes is an explicit
 * financial decision (ADR-002), so "Allocate Sell" always opens the
 * allocation modal for the user to review and submit. Because that modal
 * is itself the review step, a low-confidence sell doesn't need a separate
 * confirmation gate the way a batch-committed buy did â€” it's flagged with
 * the same amber styling, but the button stays clickable either way. It's
 * still gated on the ticker's verification-match status, though: `disabled`
 * blocks the click (with `disabledReason` as its tooltip) until this
 * ticker's share count reconciles against a broker position screenshot.
 */
export function CandidateRow({
  entry,
  match,
  added,
  skipped = false,
  actionLabel,
  actionClassName,
  onAction,
  smartActionLabel,
  onSmartAction,
  disabled = false,
  disabledReason,
  suspectedDuplicate = false,
  suggestedRemoval = false,
  wrongTickerHint,
  dateMisreadHint,
  crossSourceVerified = false,
  aggregateConfirmed = false,
  aggregateMatchDetail,
  orderConfirmed = false,
  noMatchingOrder = false,
  error,
  onDiscardPending,
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
  /** True when this row was auto-resolved as an exact duplicate of an already-recorded transaction (see the exact-duplicate-sell auto-skip effect) â€” replaces the action button with a "Skipped â€” duplicate" state so nothing invites a double-count. */
  skipped?: boolean;
  actionLabel: string;
  actionClassName: string;
  onAction: () => void;
  /** Label/handler for the optional "Smart Allocate" action, shown immediately before the main action button â€” see ImportPage's smartAllocateSell. Omitted entirely (no button rendered) when the row has no smart-allocate handler. */
  smartActionLabel?: string;
  onSmartAction?: () => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  /** Flags a still-pending row as a suggested duplicate â€” of a sibling still pending in this batch, or of a trade already committed to the ledger (see ImportPage's pendingDuplicateCandidateKeys). Drives the "Discard" action regardless of which; the badge itself is only shown when `match` isn't already showing its own duplicate pill for the same row. */
  suspectedDuplicate?: boolean;
  /** True when the mismatch auto-reconcile solver picked this row for removal (see suggestRemovalsToReconcile and AutoCommitRow's twin prop). */
  suggestedRemoval?: boolean;
  /** The ticker this row most likely belongs to, when it looks like a phantom wrong-ticker read (see findWrongTickerCandidateKeys and AutoCommitRow's twin prop). */
  wrongTickerHint?: string;
  /** The ledger date this row's date was most likely misread from (see findDateMisreadDuplicateHints and AutoCommitRow's twin prop). */
  dateMisreadHint?: string;
  /** True when this exact transaction was read from two different document types (see AutoCommitRow's twin prop). */
  crossSourceVerified?: boolean;
  /** True when this row is part of an execution group a Statement row's aggregate quantity confirmed (see AutoCommitRow's twin prop). */
  aggregateConfirmed?: boolean;
  /** Formatted breakdown of the execution group this row belongs to (see AutoCommitRow's twin prop). */
  aggregateMatchDetail?: string;
  /** True when a fulfilled order on the broker's Orders timeline screenshot corroborates this exact row (see AutoCommitRow's twin prop). */
  orderConfirmed?: boolean;
  /** True on a mismatch when this ticker's Orders history was uploaded and no fulfilled order matches this row (see AutoCommitRow's twin prop). */
  noMatchingOrder?: boolean;
  /** Set when onAction/onSmartAction threw (see ImportPage's rowErrors/setRowError) â€” previously silently swallowed for a Sell row (unlike AutoCommitRow's own twin prop), which made a failing Smart Allocate/Allocate Sell click look like a no-op with zero feedback. */
  error?: string;
  /** Discards this row from the pending pool outright â€” available on every still-pending row, not just ones auto-flagged as a suspected duplicate (see AutoCommitRow's onDiscardPending). */
  onDiscardPending?: () => void;
}) {
  const t = useT();
  const c = entry.candidate;
  const isLowConfidence = c.confidence === "low";
  const canDiscard = suspectedDuplicate && !added && !skipped;
  const flaggedForRemoval = !added && !skipped && (suggestedRemoval || wrongTickerHint !== undefined);
  const [smartAllocating, setSmartAllocating] = useState(false);
  async function handleSmartAction() {
    if (!onSmartAction) return;
    setSmartAllocating(true);
    try {
      await onSmartAction();
    } finally {
      setSmartAllocating(false);
    }
  }
  return (
    <div
      className={`px-4 py-2.5 text-sm ${canDiscard || flaggedForRemoval ? "bg-rose-500/5" : isLowConfidence ? "bg-amber-500/[0.04]" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              c.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
            }`}
          >
            {c.side}
          </span>
          <span className="tabular-nums text-slate-300">{formatShares(c.shares)} sh</span>
          <span className="tabular-nums text-slate-300">@ {formatMoney(c.price)}</span>
          <span className="text-slate-400">{formatDate(c.date)}</span>
          {isLowConfidence ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              <ShieldAlert size={11} /> {t("importPage.lowConfidenceGuess")}
            </span>
          ) : c.confidence ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_COLOR[c.confidence] }} />
              {confidenceLabel(t, c.confidence)}
            </span>
          ) : null}
          {match ? (
            <span
              title={
                match.matchType === "exact"
                  ? t("importPage.exactMatchTitle")
                  : t("importPage.possibleMatchTitle")
              }
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
              }`}
            >
              <ShieldAlert size={11} /> {match.matchType === "exact" ? t("importPage.duplicate") : t("importPage.possibleDuplicate")}
            </span>
          ) : null}
          {canDiscard && !match ? (
            <span
              title={t("importPage.suspectedDuplicateTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suspectedDuplicate")}
            </span>
          ) : null}
          {!added && wrongTickerHint ? (
            <span
              title={t("importPage.likelyOthersTransactionTitle", { ticker: wrongTickerHint })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.likelyOthersTransaction", { ticker: wrongTickerHint })}
            </span>
          ) : null}
          {!added && dateMisreadHint ? (
            <span
              title={t("importPage.dateMisreadHintTitle", { date: formatDate(dateMisreadHint) })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.dateMisreadHint", { date: formatDate(dateMisreadHint) })}
            </span>
          ) : null}
          {!added && suggestedRemoval ? (
            <span
              title={t("importPage.suggestedRemovalTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suggestedRemoval")}
            </span>
          ) : null}
          {crossSourceVerified ? (
            <span
              title={t("importPage.crossSourceVerifiedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.twoDocumentsAgree")}
            </span>
          ) : null}
          {aggregateConfirmed ? (
            <span
              title={
                aggregateMatchDetail
                  ? t("importPage.aggregateConfirmedTitleDetail", { detail: aggregateMatchDetail })
                  : t("importPage.aggregateConfirmedTitle")
              }
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.aggregateConfirmed")}
            </span>
          ) : null}
          {orderConfirmed ? (
            <span
              title={t("importPage.orderConfirmedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <History size={11} /> {t("importPage.matchesOrdersHistory")}
            </span>
          ) : !added && noMatchingOrder ? (
            <span
              title={t("importPage.noMatchingOrderTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              <History size={11} /> {t("importPage.noMatchingOrder")}
            </span>
          ) : null}
        </div>
        {added ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle2 size={14} /> {t("importPage.added")}
          </span>
        ) : skipped ? (
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <CheckCircle2 size={14} /> {t("importPage.skippedDuplicate")}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <button
              onClick={onDiscardPending}
              title={
                canDiscard
                  ? t("importPage.discardDuplicateTitle")
                  : t("importPage.discardGenericTitle")
              }
              className={`rounded p-1 hover:bg-rose-500/10 ${canDiscard ? "text-rose-300" : "text-slate-500 hover:text-rose-400"}`}
            >
              <Trash2 size={13} />
            </button>
            {onSmartAction ? (
              <button
                onClick={() => void handleSmartAction()}
                disabled={disabled || smartAllocating}
                title={disabled ? disabledReason : undefined}
                className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {smartAllocating ? <Loader2 size={13} className="animate-spin" /> : (smartActionLabel ?? t("importPage.smartAllocate"))}
              </button>
            ) : null}
            <button
              onClick={onAction}
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              className={`rounded-md px-3 py-1 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 ${
                disabled ? "" : actionClassName
              }`}
            >
              {actionLabel}
            </button>
          </span>
        )}
      </div>
      {error ? <p className="mt-1.5 text-xs text-rose-400">{error}</p> : null}
    </div>
  );
}


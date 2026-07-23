import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { RotateCcw } from "lucide-react";
import { repos, diagnostics, getImportOrchestrator, purgeTickerData } from "@presentation/lib/data";
import { recordBuy, recordBuyBatch, recordSell, deleteTrade, renameTickerEverywhere } from "@application/services/TradeService";
import { recordDividend } from "@application/services/PortfolioService";
import { recordImportedRawTransactions, candidateSource } from "@application/services/importRecording";
import { createPendingExecutionRecord } from "@application/services/pendingExecutions";
import { assignPortfolio, assignPortfolioToFact, commitTicker, retractRawTransaction, resolveCurrentPortfolioId } from "@application/services/commitEngine";
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
  alreadyAllocatedSharesForSell,
} from "@application/services/duplicateDetection";
import { hasSharesToReconcile, isLotEligibleForSell } from "@application/services/importReviewRules";
export { hasSharesToReconcile, isLotEligibleForSell } from "@application/services/importReviewRules";
import { checkTickerMatch, isTickerFullyResolved, type TickerMatchStatus } from "@application/services/importVerification";
import {
  isTickerFullyOfficialBrokerExcelSourced,
  isTickerOfficialBrokerExcelCoveredByCandidates,
} from "@application/services/reconciliation";
import { findLiveExecutionFact } from "@application/services/rawTransactionFolds";
import { higherAuthority } from "@application/services/evidenceAuthority";
import { upgradeSellExecutionFact } from "@application/services/provenanceRepair";
import {
  orderEvidenceContentKey,
  findOrderConfirmedKeys,
  findOrphanedFulfilledEvidence,
  findWrongTickerHintsFromOrders,
} from "@application/services/orderEvidence";
import { suggestRemovalsToReconcile, type ReconcileSuggestion } from "@application/services/mismatchResolver";
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
import { importJob } from "@presentation/lib/importJob";
import { PageHeader } from "@presentation/components/PageHeader";
import { Modal } from "@presentation/components/Modal";
import { EmptyState } from "@presentation/components/EmptyState";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";
import { useImportQueries } from "@presentation/hooks/useImportQueries";
import { useCommitLock } from "@presentation/hooks/useCommitLock";
import { useCommitQueue } from "@presentation/hooks/useCommitQueue";
import { TickerGroupCard } from "@presentation/components/TickerGroupCard";
import { ImportUploadPanel } from "@presentation/components/ImportUploadPanel";
import { CompletedTickersPanel } from "@presentation/components/CompletedTickersPanel";
import { ImportReviewSummaryBar } from "@presentation/components/ImportReviewSummaryBar";
export { CandidateRow } from "@presentation/components/CandidateRow";
export { AutoCommitRow } from "@presentation/components/AutoCommitRow";
export { TickerGroupCard } from "@presentation/components/TickerGroupCard";

type Stage = "idle" | "reading" | "error";

/**
 * Position-verification and dividend candidates carry no per-transaction
 * identity of their own (unlike a Buy/Sell, which has a date+price+shares
 * to distinguish one execution from another) — re-uploading the same "My
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
 * already records — a retracted row is permanently excluded from
 * VerificationEngine/CommitEngine (see rawTransactionFolds.isRetracted), the
 * same fold every other reader of the raw log already applies. Fire-and-
 * forget, isolated, non-fatal — same shadow-write discipline as every other
 * dual-write in this migration (assignPortfolio, recordImportedRawTransactions):
 * a failure here must never break today's working Import behavior, which
 * still reads only from the localStorage pending pool. Each `key` here is
 * expected to equal the RawTransaction id recordImportedRawTransactions wrote
 * for it (see importRecording.ts) — a key from before that change shipped
 * simply retracts nothing (no RawTransaction has that id), which is inert,
 * not harmful.
 */
function retractRawTransactionKeys(keys: Iterable<string>) {
  const recordedRawFactKeys = new Set(importSession.getState().recordedRawFactKeys);
  for (const key of keys) {
    // A duplicate candidate may be skipped without writing a new fact. Its
    // session key can still equal an older fact id, so retracting blindly
    // would delete the already-trusted official fact (the ACAMD failure).
    if (!recordedRawFactKeys.has(key)) continue;
    retractRawTransaction(repos, key, undefined, diagnostics).catch((err) => {
      console.error("retractRawTransaction failed (shadow write, non-fatal):", err);
    });
  }
}

interface ConfirmBatchState {
  addedKeys: string[];
  acceptedKeys: string[];
  skippedKeys: string[];
  addedTradeIds: Record<string, string>;
  addedAllocationIds: Record<string, string[]>;
}

function emptyConfirmBatchState(): ConfirmBatchState {
  return { addedKeys: [], acceptedKeys: [], skippedKeys: [], addedTradeIds: {}, addedAllocationIds: {} };
}

/**
 * Import runs as a strict two-phase workflow: (1) extract — drop as many
 * files as needed; every candidate/verification accumulates into one pool,
 * confirmed complete by the running "N transactions from M files" count —
 * then (2) verify & distribute — group everything by ticker, assign ONE
 * portfolio per ticker (so a stock's sells automatically travel with its
 * buys), and reconcile each ticker's extracted share count against a broker
 * "My Position" screenshot. Nothing is written to a portfolio until every
 * ticker's count matches its screenshot exactly and the user explicitly
 * clicks "Confirm — Distribute to Portfolios" — see tickerMatchStatuses and
 * confirmAndDistributeAll. A Sell always still opens its own allocation
 * modal (ADR-002 — this app never auto-picks which lot a sell closes).
 *
 * The pool itself lives in `importSession` (module-level, localStorage-backed),
 * not component state — a user often needs to leave this page mid-import to
 * create a portfolio to distribute into, and plain useState would have thrown
 * away everything extracted so far the moment the page unmounted.
 */
export function ImportPage() {
  const t = useT();
  const commitLock = useCommitLock();
  const commitQueue = useCommitQueue();
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
  const [reviewDataSettled, setReviewDataSettled] = useState(false);

  const session = useImportSession();
  const { pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences, tickerPortfolio, filesProcessed } = session;

  // Navigation unmounts this page. Persistently remove a terminal session at
  // that boundary so returning to Import cannot hydrate already-completed
  // rows before IndexedDB has finished loading. Never touch an active job.
  useEffect(() => {
    return () => {
      if (importJob.getState()?.status === "running") return;
      importSession.clearIfFullyResolved();
      importSession.flush();
    };
  }, []);

  /**
   * Every extraction path already filters a Buy/Sell candidate dated before
   * the configured tracking start date at parse time (see
   * trackedDateRange.ts) — but ThndrParser's dividend extraction didn't,
   * until a real out-of-range dividend reached this pool, sat there looking
   * normal, and only surfaced as a thrown error the moment the user tried to
   * confirm it. Silently dropping any out-of-range candidate/dividend still
   * sitting in the pool — regardless of which extraction path let it
   * through, including ones already stuck in a session from before this fix
   * — means there's never a row that can only ever fail to commit. Also
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

  const queries = useImportQueries(
    { pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences },
    distributing,
  );
  if (queries.error) throw queries.error;
  const {
    pendingTickerKey,
    portfolios,
    existingTrades,
    existingAllocations,
    existingRawTransactions,
    rawTransactionsLoaded,
    existingVerifications,
    existingTimeline,
    officialUploadCandidatesByTicker,
  } = queries;

  // The legacy Trade/TradeAllocation entities carry no provenance field at
  // all — this is the only way to know a ticker's ALREADY-COMMITTED history
  // (as opposed to this batch's still-pending candidates) came entirely from
  // the official broker Excel export (see tickerMatchStatuses below, and
  // reconciliation.ts's own doc comment on isTickerFullyOfficialBrokerExcelSourced).
  // Uploads are durable evidence, unlike the localStorage review session.
  // Keep official broker-workbook candidates available after a page reload or
  // after every pending row has been dismissed/committed.
  // Ground truth for the verification gate below — a broker "My Position"
  // screenshot accepted in an earlier session still counts as this ticker's
  // reference even if this batch re-extracts more buys/sells for it.
  // A dividend already recorded in an earlier import session is otherwise
  // invisible to the in-session dedup below (seenDividendKeys), which only
  // ever sees the current batch's pending pool — the same broker statement
  // re-uploaded weeks later (its dividend history overlapping what's already
  // recorded) would silently double-count real cash. Global like existingTrades:
  // a real dividend payment happened once regardless of which portfolio it's filed under.
  const existingDividendKeys = useMemo(() => buildExistingDividendKeys(existingTimeline), [existingTimeline]);

  /**
   * useLiveQuery returns undefined until its first read resolves, then an
   * array from then on — including a genuinely empty one. The verification
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
   * and each useLiveQuery resolves independently — a ticker whose complete
   * history is official-broker-excel-sourced but has nothing pending this
   * session would transiently read as "no-verification"/"closed-position"
   * (needs a screenshot) for however long this one query takes to resolve
   * after the others already have, purely because its default-empty read
   * ([]) can never satisfy isTickerFullyOfficialBrokerExcelSourced. Omitting
   * it here was a real, reproducible instance of the broker-record trust
   * policy being bypassed — not by wrong decision logic, but by feeding the
   * (correct) decision logic transiently-incomplete data. See docs/ROADMAP.md.
   */
  const initialDataLoaded = queries.ready;

  /**
   * A persisted import session is available synchronously, while the durable
   * ledger queries resolve asynchronously.  On a remount that used to expose
   * one render of already-completed rows as pending before the duplicate and
   * reconciliation effects below could classify them.  Keep the review area
   * hidden through one settled task after all durable reads complete, giving
   * those effects a chance to publish their final skipped/completed state.
   */
  useEffect(() => {
    setReviewDataSettled(false);
    if (!initialDataLoaded) return;
    const timer = window.setTimeout(() => setReviewDataSettled(true), 0);
    return () => window.clearTimeout(timer);
  }, [initialDataLoaded, pendingTickerKey]);

  /**
   * `ownTradeId` (Buys) / `ownAllocationIds` (Sells) exclude a candidate's
   * own already-committed records from the comparison pool — without them, a
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
   * already on the ledger (same ticker/date/shares/price — e.g. the same
   * file, or the same real execution, re-imported) has nothing left to do:
   * committing it again would double-count real shares. This must run
   * BEFORE tickerMatchStatuses, not only at commit time inside
   * commitTickerGroup: an un-skipped duplicate still counts toward
   * pendingBuyShares/pendingSellShares in the net-share reconciliation,
   * which can hold a ticker at "Mismatch"/"Blocked — needs verification"
   * forever even when the ledger and a broker "My Position" screenshot
   * already agree exactly — commitTickerGroup's own skip only ever runs for
   * a ticker `tickerMatchStatuses` already reports as matched, so it can
   * never break that particular chicken-and-egg deadlock on its own (a real
   * gap found and reproduced during the reconciliation investigation: a
   * ticker whose only pending row was an exact re-import of an
   * already-fully-recorded, already-broker-verified position stayed
   * permanently "Mismatch"). Auto-marking the duplicate skipped here
   * resolves it the same way the Sell side already did on its own before
   * this was generalized to cover Buys too. This never commits anything
   * itself (ADR-002 — which lots a sell closes stays a manual decision for
   * a genuinely new Sell); it only closes a row whose real-world
   * transaction is already fully recorded. Gated on initialDataLoaded so a
   * briefly-empty trades/allocations read can't mislabel (or fail to label)
   * a row off stale data.
   *
   * The commit-lock exclusion closes a real, reproduced race: commitTickerGroup's
   * own addBuyCandidate saves the Trade (repos.trades.save) several awaits
   * BEFORE it ever updates addedKeys — a window in which this effect's own
   * existingTrades dependency (a live Dexie query) can already see the
   * brand-new Trade and re-run before addedKeys catches up. Without this
   * guard, a candidate mid-commit briefly looks like "not yet added, and now
   * duplicates an existing trade" (the trade its OWN commit just wrote), so
   * this effect would skip it and retract its RawTransaction fact out from
   * under ensureBuyFact/ensureSellFacts — which then finds no live fact left
   * to adopt and mints a fresh one hardcoded to source "manual", silently
   * destroying the ticker's official-broker-excel provenance (reproduced:
   * an Excel-sourced ticker with nothing left pending immediately reads as
   * "Needs broker screenshot"/"Closed — needs corroborating evidence" right
   * after Confirm, exactly the recurring class of bug this file has chased
   * before — see docs/ROADMAP.md). commitTickerGroup already marks a key
   * in-flight before its first await for exactly this kind of reentrancy;
   * this effect just needs to respect the same guard.
   *
   * `sellCandidate?.key` closes the identical race for the OTHER commit path
   * this file has — SellAllocationForm's submission, which isn't covered by
   * the batch commit lock at all (it is acquired by commitTickerGroup's
   * own three loops). recordSell saves each TradeAllocation, several awaits
   * before its own fact is ensured, exactly like recordBuy — the sell
   * candidate's key stays excluded for the whole time its modal is open,
   * which safely covers the in-flight submission window too (nothing else
   * can add this key while its own modal is up).
   */
  useEffect(() => {
    if (!initialDataLoaded) return;
    const state = importSession.getState();
    const ownAllocs = state.addedAllocationIds ?? {};
    const skipEntries = state.pendingCandidates
      .filter(
        (e) =>
          !state.addedKeys.includes(e.key) &&
          !state.skippedKeys.includes(e.key) &&
          !state.dismissedKeys.includes(e.key) &&
          !commitLock.isLocked(e.key) &&
          e.key !== sellCandidate?.key,
      )
      .map((e) => ({ e, m: duplicateMatch(e.candidate, undefined, ownAllocs[e.key]) }))
      .filter((entry): entry is { e: CandidateEntry; m: NonNullable<ReturnType<typeof duplicateMatch>> } => {
        const m = entry.m;
        return m !== undefined && (m.matchType === "exact" || pricesWithinOcrNoise(m.matchedPrice, entry.e.candidate.price));
      });
    if (skipEntries.length === 0) return;
    const keysToSkip = skipEntries.map(({ e }) => e.key);
    // A candidate this authoritative (e.g. official-broker-excel)
    // duplicating a trade recorded earlier via a lower-authority source
    // (manual entry, an OCR'd screenshot) is itself stronger evidence than
    // whatever fact already exists for that execution — retract THAT
    // lower-authority fact instead of the new one, so the ticker's
    // provenance upgrades to the newly-uploaded document rather than losing
    // it. Without this, a real, reported bug: an Excel-confirmed position
    // kept reading "Needs broker screenshot" because the auto-skip always
    // retracted the newly-extracted, higher-authority fact and left the
    // older, lower-authority one as the ticker's only surviving evidence.
    const plainRetractIds: string[] = [];
    for (const { e, m } of skipEntries) {
      const existingFact = findLiveExecutionFact(
        existingRawTransactions,
        {
          kind: e.candidate.side === "BUY" ? "BuyExecution" : "SellExecution",
          ticker: e.candidate.ticker,
          date: e.candidate.date,
          shares: e.candidate.shares,
          price: m.matchedPrice,
          time: e.candidate.time,
        },
        e.key,
      );
      const newSource = candidateSource(e.candidate);
      const upgrade = existingFact && higherAuthority(newSource, existingFact.source) === newSource;
      if (!upgrade) {
        plainRetractIds.push(e.key);
        continue;
      }
      // The new fact must inherit the old one's CURRENT portfolio assignment
      // before the old one is retracted — otherwise the surviving fact stays
      // unassigned, the retraction's own triggered commit
      // (commitEngine.appendAndMaybeCommit) computes zero relevant
      // transactions for this (portfolio, ticker), and projectLegacyTicker
      // deletes the ticker's real Trade/TradeAllocation row as "stale" — a
      // real, reproduced bug (an Excel-confirmed position's provenance badge
      // fixed itself while its actual Holdings row silently vanished).
      const oldPortfolioId = resolveCurrentPortfolioId(existingRawTransactions, existingFact!);
      const upgradeFact = async () => {
        if (oldPortfolioId !== undefined) {
          await assignPortfolioToFact(repos, e.key, oldPortfolioId, diagnostics);
        }
        if (e.candidate.side === "BUY") {
          // A Buy fact is never referenced by another fact's id, so a plain
          // retraction of the old one is the rest of the upgrade.
          await retractRawTransaction(
            repos,
            existingFact!.id,
            "Provenance upgrade: superseded by a higher-authority document describing the same execution.",
            diagnostics,
          );
        } else {
          // A Sell's fact may already be claimed by a live
          // SellAllocationDecision (see rawTransactionFolds.findUnclaimedSellExecutionFact)
          // — upgradeSellExecutionFact re-points that decision at the new,
          // higher-authority fact instead of leaving it referencing a
          // retracted one, the same swap provenanceRepair.ts's dry-run/apply
          // flow performs for its own (narrower, "manual"-only) historical bug.
          await upgradeSellExecutionFact(repos, { oldFactId: existingFact!.id, newFactId: e.key });
        }
      };
      upgradeFact().catch((err) => {
        console.error("provenance upgrade failed (shadow write, non-fatal):", err);
      });
    }
    importSession.update((prev) => ({ ...prev, skippedKeys: [...new Set([...prev.skippedKeys, ...keysToSkip])] }));
    retractRawTransactionKeys(plainRetractIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initialDataLoaded,
    pendingCandidates,
    existingTrades,
    existingAllocations,
    existingRawTransactions,
    session.addedKeys,
    session.skippedKeys,
    session.dismissedKeys,
    sellCandidate,
    distributing,
  ]);

  // A repeated native broker Excel export can reach the persisted Import
  // session after its original rows have already been committed.  The
  // general duplicate guard above intentionally keeps time-conflicting rows
  // (they may be genuine twin fills); this narrower pass uses the official
  // export's exact execution time to remove only a true re-upload copy before
  // it can remain as a misleading Ready/Confirm row.
  useEffect(() => {
    if (!initialDataLoaded || distributing) return;
    const state = importSession.getState();
    const resolvedKeys = new Set([...state.addedKeys, ...state.skippedKeys, ...state.dismissedKeys]);
    const duplicateKeys = findOfficialBrokerExcelReuploadDuplicateKeys(state.pendingCandidates, resolvedKeys);
    if (duplicateKeys.length === 0) return;
    importSession.update((prev) => ({ ...prev, skippedKeys: [...new Set([...prev.skippedKeys, ...duplicateKeys])] }));
    retractRawTransactionKeys(duplicateKeys);
  }, [initialDataLoaded, pendingCandidates, session.addedKeys, session.skippedKeys, session.dismissedKeys, distributing]);

  /**
   * Statement Aggregate Reconciliation: a Statement row that sums several
   * same-day executions from a higher-detail source (Orders, an Invoice, a
   * CSV export) into one printed quantity (see
   * findAggregateStatementMatches) is confirmation of that execution group,
   * not a separate transaction — committing it alongside the group it
   * summarizes would double-count real shares exactly the way an un-skipped
   * ledger duplicate would. Auto-skipped here on the same terms as the exact-
   * duplicate effect above: only once every match condition (ticker, side,
   * day, exact share sum, compatible price) is satisfied, and only for a
   * Statement row that doesn't already have a direct 1:1 cross-source match
   * (see findCrossSourceVerifiedKeys, computed fresh here rather than reused
   * from the render-time crossVerifiedKeys memo so this effect stays
   * self-contained like its sibling above). The matched execution rows
   * themselves are never skipped — they commit normally and are surfaced as
   * "Confirmed by Statement" via aggregateConfirmedKeys below.
   *
   * Same commit-lock exclusion as the exact-duplicate effect above, and
   * for the same reason — a key mid-commit must never be retracted out from
   * under the commit that's still in flight on it.
   */
  useEffect(() => {
    if (!initialDataLoaded || distributing) return;
    const state = importSession.getState();
    const stillPending = state.pendingCandidates.filter(
      (e) => !state.addedKeys.includes(e.key) && !state.skippedKeys.includes(e.key) && !state.dismissedKeys.includes(e.key) && !commitLock.isLocked(e.key),
    );
    const crossSourceVerified = findCrossSourceVerifiedKeys(stillPending);
    const aggregateMatches = findAggregateStatementMatches(stillPending, crossSourceVerified);
    if (aggregateMatches.size === 0) return;
    const keysToSkip = [...aggregateMatches.keys()];
    importSession.update((prev) => ({ ...prev, skippedKeys: [...new Set([...prev.skippedKeys, ...keysToSkip])] }));
    retractRawTransactionKeys(keysToSkip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDataLoaded, pendingCandidates, session.addedKeys, session.skippedKeys, session.dismissedKeys, distributing]);

  /**
   * A ticker that already has trades recorded somewhere shouldn't make the
   * user re-pick a portfolio every time it's re-imported — this is the
   * "suggest the portfolio it already lives in" behavior. When it lives in
   * more than one portfolio, this is deliberately ambiguous (no auto-pick):
   * the user has to say which one these new rows belong to.
   */
  const existingPortfoliosByTicker = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const t of existingTrades) {
      const key = normalizeTicker(t.ticker);
      const set = map.get(key) ?? new Set<string>();
      set.add(t.portfolioId);
      map.set(key, set);
    }
    return map;
  }, [existingTrades]);

  /**
   * Every already-recorded (real, committed) Trade for a ticker, grouped for
   * TickerGroupCard's "Recorded on the ledger" panel — the direct-delete
   * tool for a blocked ticker whose problem is a duplicate/misread buy
   * already on the ledger rather than anything still pending (see
   * deleteExistingTrade). Global across portfolios like
   * existingPortfoliosByTicker, since the panel's job is to help the user
   * find the offending row wherever it actually is.
   */
  const existingTradesByTicker = useMemo(() => {
    const map = new Map<string, Trade[]>();
    for (const t of existingTrades) {
      const key = normalizeTicker(t.ticker);
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return map;
  }, [existingTrades]);

  function portfolioForTicker(ticker: string): string {
    if (tickerPortfolio[ticker]) return tickerPortfolio[ticker];
    const existing = existingPortfoliosByTicker.get(ticker);
    if (existing && existing.size === 1) return [...existing][0];
    return portfolios[0]?.id ?? "";
  }

  /**
   * The confident subset of portfolioForTicker's result: undefined whenever
   * the choice would be a guess (a brand-new ticker with more than one
   * portfolio open, and no explicit pick yet) rather than a real answer.
   * Auto-commit only ever fires once this resolves — landing money in the
   * wrong portfolio is exactly the risk manual assignment existed to avoid,
   * so ambiguity still waits on the user picking from the dropdown.
   */
  function resolvedPortfolioId(ticker: string): string | undefined {
    if (tickerPortfolio[ticker]) return tickerPortfolio[ticker];
    const existing = existingPortfoliosByTicker.get(ticker);
    if (existing && existing.size === 1) return [...existing][0];
    if ((!existing || existing.size === 0) && portfolios.length === 1) return portfolios[0].id;
    return undefined;
  }

  function setTickerPortfolio(ticker: string, portfolioId: string) {
    importSession.update((prev) => ({ ...prev, tickerPortfolio: { ...prev.tickerPortfolio, [ticker]: portfolioId } }));

    // Migration dual-write: also assigns every still-unassigned
    // RawTransaction for this ticker to the chosen portfolio (see
    // commitEngine.assignPortfolio), which is what lets the new
    // architecture's reactive commit trigger fire for it at all — Import
    // itself never assigns a portfolio (see importRecording.ts). Isolated
    // and non-fatal for the same reason as the dual-write in processFiles.
    //
    // Routed through the SAME per-(portfolio, ticker) runSerialized queue as
    // commitTickerGroup/smartAllocateSell/SellAllocationForm (see
    // serialize.ts) — a real, reproduced gap the "forensic architectural
    // audit" that enumerated every commitTicker-triggering write path (see
    // ROADMAP) missed entirely: this dropdown handler is a distinct call
    // site from commitTickerGroupLocked's own (already-serialized) trailing
    // assignPortfolio sweep, and picking a ticker's portfolio from Import's
    // own dropdown is an ordinary action a multi-portfolio user takes right
    // around Confirm/Smart-Allocate time, not a contrived edge case. Left
    // fire-and-forget (setTickerPortfolio itself isn't async, called
    // directly from a <select>'s onChange) — joining the queue is what
    // matters: any subsequent commitTickerGroup/smartAllocateSell/
    // SellAllocationForm call for this ticker shares the identical key and
    // will correctly queue behind this sweep instead of racing it.
    void commitQueue.run(portfolioId, ticker, () => assignPortfolio(repos, ticker, portfolioId, diagnostics)).catch((err) => {
      console.error("assignPortfolio failed (shadow write, non-fatal):", err);
    });
  }

  async function processFiles(files: File[]) {
    if (files.length === 0) return;
    setStage("reading");
    setErrorMessage("");
    let seq = importSession.getState().uploadSeq;
    const batchResults: typeof recentFileResults = [];

    try {
      const orchestrator = await getImportOrchestrator();
      for (let i = 0; i < files.length; i++) {
        const currentFile = files[i];
        setQueueProgress({ index: i + 1, total: files.length, fileName: currentFile.name });

        const result = await orchestrator.importFile(currentFile);
        const existingUpload = await repos.uploads.getByHash(result.fileHash);
        let isDuplicateFile = Boolean(existingUpload);

        // A file whose earlier upload FAILED (e.g. the parser didn't know its
        // format yet) must not stay permanently blocked by its hash — once the
        // app can read it, re-uploading should work. Likewise, a file that
        // yields no trade candidates (evidence/verification/dividend-only
        // screenshots) is session-scoped: the session's own content-key dedup
        // already drops true repeats, so the hash must not block it either.
        if (
          isDuplicateFile &&
          result.status !== "failed" &&
          (existingUpload!.status === "failed" ||
            (result.candidates.length === 0 &&
              (result.orderEvidences.length > 0 || result.verifications.length > 0 || result.dividends.length > 0)))
        ) {
          await repos.uploads.delete(existingUpload!.id);
          isDuplicateFile = false;
        }

        // A file previously imported whose trades were later deleted should
        // not remain permanently blocked by its hash. If any candidate from
        // this file is no longer recorded in the ledger (e.g. a buy that was
        // deleted), treat the file as new so those candidates can be
        // re-imported. This fixes the case where deleting a trade and then
        // re-uploading the original file shows everything as "skipped".
        if (isDuplicateFile && result.candidates.length > 0) {
          const [currentTrades, currentAllocations] = await Promise.all([
            repos.trades.getAll(),
            repos.allocations.getAll(),
          ]);
          const hasUnrecordedCandidate = result.candidates.some((candidate) => {
            if (candidate.side === "BUY") {
              return !findDuplicateBuyMatch(candidate, currentTrades);
            }
            return !findDuplicateSellMatch(candidate, currentAllocations);
          });
          if (hasUnrecordedCandidate) {
            await repos.uploads.delete(existingUpload!.id);
            isDuplicateFile = false;
          }

          // A previously imported official workbook may have been processed
          // by an older provenance bug: its ledger row survived, but the
          // official RawTransaction fact was retracted or never written. In
          // that state every candidate looks like a duplicate and the hash
          // gate would make the workbook impossible to use as a repair. Let
          // the recorder append the higher-authority facts on a re-upload;
          // it remains idempotent because equal/higher live facts are still
          // skipped by recordImportedRawTransactions.
          const officialCandidateTickers = new Set(
            result.candidates
              .filter((candidate) => candidate.source === "official-broker-excel")
              .map((candidate) => normalizeTicker(candidate.ticker)),
          );
          if (isDuplicateFile && officialCandidateTickers.size > 0) {
            const currentRawTransactions = await repos.rawTransactions.getAll();
            const needsOfficialProvenanceRepair = [...officialCandidateTickers].some(
              (ticker) => !isTickerFullyOfficialBrokerExcelSourced(currentRawTransactions, ticker),
            );
            if (needsOfficialProvenanceRepair) {
              await repos.uploads.delete(existingUpload!.id);
              isDuplicateFile = false;
            }
          }
        }

        if (!isDuplicateFile) {
          const upload: Upload = {
            id: generateId(),
            fileName: currentFile.name,
            fileHash: result.fileHash,
            contentType: currentFile.type || "application/octet-stream",
            status: result.status === "failed" ? "failed" : "parsed",
            candidates: result.candidates,
            rawText: result.rawText,
            fileBlob: result.fileBlob,
            createdAt: new Date().toISOString(),
            parsedAt: new Date().toISOString(),
          };
          await repos.uploads.save(upload);

          // Phase 9.7: keys computed BEFORE the dual-write below (not after,
          // as before) so each candidate/order-evidence row's own session key
          // can be threaded through as its RawTransaction's own `id` — see
          // importRecording.ts's ImportRecordingInput doc comment. This is
          // what lets a later Skip/Dismiss/Discard action retract the exact
          // right row by key, with no separate lookup needed.
          const fileSeq = seq;
          seq += 1;
          const newCandidates = result.candidates.map((candidate, ci) => ({ key: `${fileSeq}-c${ci}`, candidate }));
          const newOrderEvidenceEntries = result.orderEvidences.map((evidence, oi) => ({ key: `${fileSeq}-o${oi}`, evidence }));

          // Migration dual-write: additionally record every parsed candidate
          // as an immutable RawTransaction (see importRecording.ts). No
          // longer shadow data nobody reads — Phase 9.7 made this the
          // authoritative, full-lifecycle record (see the module's own doc
          // comment) — but still isolated in its own try/catch on purpose:
          // a transient IndexedDB failure here must never break today's
          // working Import flow, which the localStorage pending pool below
          // remains the actual source of truth for.
          try {
            const recordedFactKeys = await recordImportedRawTransactions(repos, {
              sourceUploadId: upload.id,
              candidates: newCandidates,
              verifications: result.verifications,
              dividends: result.dividends,
              orderEvidences: newOrderEvidenceEntries,
              cancelledOrders: result.cancelledOrders,
            });
            if (recordedFactKeys.length > 0) {
              importSession.update((prev) => ({
                ...prev,
                recordedRawFactKeys: [...new Set([...prev.recordedRawFactKeys, ...recordedFactKeys])],
              }));
            }
          } catch (err) {
            console.error("recordImportedRawTransactions failed (shadow write, non-fatal):", err);
          }

          let skippedVerifications = 0;
          let skippedDividends = 0;
          let skippedOrderEvidences = 0;
          importSession.update((prev) => {
            const seenVerificationKeys = new Set(prev.pendingVerifications.map((e) => verificationContentKey(e.verification)));
            const newVerifications: VerificationEntry[] = [];
            result.verifications.forEach((verification, vi) => {
              const key = verificationContentKey(verification);
              if (seenVerificationKeys.has(key)) {
                skippedVerifications += 1;
                return;
              }
              seenVerificationKeys.add(key);
              newVerifications.push({ key: `${fileSeq}-v${vi}`, verification });
            });

            const seenDividendKeys = new Set([
              ...prev.pendingDividends.map((e) => dividendContentKey(e.dividend)),
              ...existingDividendKeys,
            ]);
            const newDividends: DividendEntry[] = [];
            result.dividends.forEach((dividend, di) => {
              const key = dividendContentKey(dividend);
              if (seenDividendKeys.has(key)) {
                skippedDividends += 1;
                return;
              }
              seenDividendKeys.add(key);
              newDividends.push({ key: `${fileSeq}-d${di}`, dividend });
            });

            // Deduped only against PREVIOUS files' rows, never within this
            // file's own batch: consecutive scrolled screenshots of the same
            // Orders screen overlap by a few rows (same signature in two
            // files = the overlap), while two identical rows within one
            // screenshot are genuinely two separate orders.
            const seenEvidenceKeys = new Set(prev.pendingOrderEvidences.map((e) => orderEvidenceContentKey(e.evidence)));
            const newOrderEvidences: OrderEvidenceEntry[] = [];
            newOrderEvidenceEntries.forEach(({ key, evidence }) => {
              if (seenEvidenceKeys.has(orderEvidenceContentKey(evidence))) {
                skippedOrderEvidences += 1;
                return;
              }
              newOrderEvidences.push({ key, evidence });
            });

            // Cross-document field completion: the same transaction read
            // from two documents (statement + invoice, invoice + orders
            // screenshot) completes each other's missing fees/taxes/time/
            // transactionNumber — strictly additive, never overwriting a
            // value a document actually carried (see
            // completeCandidateFieldsFromSiblings).
            const combinedCandidates = [...prev.pendingCandidates, ...newCandidates];
            const fieldCompletions = completeCandidateFieldsFromSiblings(combinedCandidates);
            const completedCandidates =
              fieldCompletions.size === 0
                ? combinedCandidates
                : combinedCandidates.map((e) => {
                    const patch = fieldCompletions.get(e.key);
                    return patch ? { ...e, candidate: { ...e.candidate, ...patch } } : e;
                  });

            return {
              ...prev,
              pendingCandidates: completedCandidates,
              pendingVerifications: [...prev.pendingVerifications, ...newVerifications],
              pendingDividends: [...prev.pendingDividends, ...newDividends],
              pendingOrderEvidences: [...prev.pendingOrderEvidences, ...newOrderEvidences],
            };
          });

          const dedupWarnings: string[] = [];
          if (skippedVerifications > 0) {
            dedupWarnings.push("This position reading matches one already in the list — not added again.");
          }
          if (skippedDividends > 0) {
            dedupWarnings.push(
              `${skippedDividends} dividend${skippedDividends === 1 ? "" : "s"} already in the list or already recorded — not added again.`,
            );
          }
          if (skippedOrderEvidences > 0) {
            dedupWarnings.push(
              `${skippedOrderEvidences} order row${skippedOrderEvidences === 1 ? "" : "s"} already read from an earlier screenshot (overlapping scroll) — not added again.`,
            );
          }
          if (dedupWarnings.length > 0) {
            result.warnings = [...result.warnings, ...dedupWarnings];
          }
        }

        batchResults.push({ fileName: currentFile.name, warnings: result.warnings, duplicate: isDuplicateFile });
        importSession.update((prev) => ({ ...prev, filesProcessed: prev.filesProcessed + 1 }));
      }

      importSession.update((prev) => ({ ...prev, uploadSeq: seq }));
      setRecentFileResults(batchResults);
      setStage("idle");
      setQueueProgress(null);
    } catch (e) {
      importSession.update((prev) => ({ ...prev, uploadSeq: seq }));
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Import failed.");
      setQueueProgress(null);
    }
  }

  function clearRowError(key: string) {
    setRowErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function setRowError(key: string, e: unknown) {
    setRowErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : "Something went wrong." }));
  }

  async function addBuyCandidate(entry: CandidateEntry, ticker: string, deferCommit = false, batch?: ConfirmBatchState) {
    try {
      const portfolioId = portfolioForTicker(ticker);

      // A partial-fill execution (STES "Needs Confirmation") is never
      // committed to a Trade here — see the audit that produced
      // pendingExecutions.ts: doing so used to affect Holdings/cost basis/
      // cash before any invoice existed, a real bug. It's recorded as a
      // PendingExecution instead (no Ledger Entry, no Holdings impact) and
      // leaves this review pool the same way a normal commit would; the
      // broker-invoice upload/confirm flow lives on PortfolioDetailPage.
      if (entry.candidate.needsConfirmation) {
        await createPendingExecutionRecord(repos, {
          portfolioId,
          ticker,
          companyName: entry.candidate.companyName,
          side: "BUY",
          originalShares: entry.candidate.shares,
          originalPrice: entry.candidate.price,
          originalFees: entry.candidate.fees,
          originalTaxes: entry.candidate.taxes,
          executionDate: entry.candidate.date,
          executionTime: entry.candidate.time,
          brokerStatus: entry.candidate.brokerStatus ?? "Needs Confirmation",
          transactionNumber: entry.candidate.transactionNumber,
        });
        if (batch) batch.addedKeys.push(entry.key);
        else {
          importSession.update((prev) => ({ ...prev, addedKeys: [...prev.addedKeys, entry.key] }));
          clearRowError(entry.key);
        }
        return;
      }

      const { trade } = await recordBuy(
        repos,
        {
          portfolioId,
          ticker,
          companyName: entry.candidate.companyName,
          shares: entry.candidate.shares,
          entryPrice: entry.candidate.price,
          fees: entry.candidate.fees ?? 0,
          taxes: entry.candidate.taxes ?? 0,
          executionDate: entry.candidate.date,
          executionTime: entry.candidate.time ?? "00:00",
          notes: "Imported from screenshot/PDF",
          transactionNumber: entry.candidate.transactionNumber,
          deferCommit,
        },
        diagnostics,
      );
      if (batch) {
        batch.addedKeys.push(entry.key);
        batch.addedTradeIds[entry.key] = trade.id;
      } else {
        importSession.update((prev) => ({
          ...prev,
          addedKeys: [...prev.addedKeys, entry.key],
          addedTradeIds: { ...prev.addedTradeIds, [entry.key]: trade.id },
        }));
        clearRowError(entry.key);
      }
    } catch (e) {
      setRowError(entry.key, e);
      if (batch) throw e;
    }
  }

  /**
   * A SELL candidate normally always opens the allocation modal (ADR-002 —
   * this app never auto-picks which lot a sell closes). A partial-fill
   * ("Needs Confirmation") candidate skips that entirely: which lot(s) it
   * closes can't even be decided yet, since the executed quantity itself
   * isn't confirmed — it becomes a PendingExecution instead, and the
   * allocation step happens later, after the invoice is confirmed, from
   * PortfolioDetailPage.
   */
  async function allocateOrPendSell(entry: CandidateEntry, ticker: string) {
    if (!entry.candidate.needsConfirmation) {
      setSellCandidate({ key: entry.key, ticker, portfolioId: portfolioForTicker(ticker), candidate: entry.candidate });
      return;
    }
    try {
      const portfolioId = portfolioForTicker(ticker);
      await createPendingExecutionRecord(repos, {
        portfolioId,
        ticker,
        companyName: entry.candidate.companyName,
        side: "SELL",
        originalShares: entry.candidate.shares,
        originalPrice: entry.candidate.price,
        originalFees: entry.candidate.fees,
        originalTaxes: entry.candidate.taxes,
        executionDate: entry.candidate.date,
        executionTime: entry.candidate.time,
        brokerStatus: entry.candidate.brokerStatus ?? "Needs Confirmation",
        transactionNumber: entry.candidate.transactionNumber,
      });
      importSession.update((prev) => ({ ...prev, addedKeys: [...prev.addedKeys, entry.key] }));
      clearRowError(entry.key);
    } catch (e) {
      setRowError(entry.key, e);
    }
  }

  /**
   * Strict-FIFO variant of allocateOrPendSell's manual flow: closes the
   * oldest open lot(s) first, silently, through the exact same recordSell
   * engine the manual "Allocate Sell" dialog uses (see SellAllocationForm's
   * own doc comment on why manual allocation itself has no auto-FIFO
   * suggestion — this button is the deliberate opt-in for that).
   */
  async function smartAllocateSell(entry: CandidateEntry, ticker: string) {
    if (entry.candidate.needsConfirmation) {
      await allocateOrPendSell(entry, ticker);
      return;
    }
    // Same reentrancy guard as commitTickerGroup's own three loops (see its
    // doc comment) — recordSell below saves each TradeAllocation several
    // awaits before addedKeys updates, a window in which the exact-duplicate
    // auto-skip effect's own existingAllocations dependency can already see
    // this call's OWN in-flight write and mark this very candidate skipped
    // as an apparent "duplicate" of the allocation its own commit just
    // created — the identical race already fixed for commitTickerGroup and
    // SellAllocationForm, just never extended to this newer button.
    commitLock.acquire(entry.key);
    try {
      const portfolioId = portfolioForTicker(ticker);
      const normalizedTicker = normalizeTicker(ticker);
      // Serialized end-to-end (read open lots -> decide -> write -> commit)
      // per (portfolio, ticker) — see serialize.ts's own doc comment. Without
      // this, clicking Smart Allocate on several sell rows for the same
      // ticker in quick succession lets a later call read open lots before
      // an earlier one's commit has finished reducing them, misreporting a
      // real position as "not enough open shares."
      await commitQueue.run(portfolioId, normalizedTicker, async () => {
        const allTrades = await repos.trades.getByPortfolio(portfolioId);
        const openLots = allTrades
          .filter((t) => normalizeTicker(t.ticker) === normalizedTicker && t.remainingShares > 0 && isLotEligibleForSell(t, entry.candidate))
          .sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.executionTime.localeCompare(b.executionTime));

        let remainingToSell = entry.candidate.shares;
        const lines: { tradeId: string; shares: number }[] = [];
        for (const lot of openLots) {
          if (remainingToSell <= 0) break;
          const allocatedShares = Math.min(lot.remainingShares, remainingToSell);
          if (allocatedShares <= 0) continue;
          lines.push({ tradeId: lot.id, shares: allocatedShares });
          remainingToSell -= allocatedShares;
        }

        if (remainingToSell > 0) {
          throw new Error(
            `Not enough open shares to Smart Allocate: need ${entry.candidate.shares}, only ${entry.candidate.shares - remainingToSell} open for ${ticker}.`,
          );
        }

        const totalFees = entry.candidate.fees ?? 0;
        const totalTaxes = entry.candidate.taxes ?? 0;
        const totalShares = entry.candidate.shares;
        const allocations = lines.map((line) => ({
          tradeId: line.tradeId,
          shares: line.shares,
          exitPrice: entry.candidate.price,
          fees: (totalFees / totalShares) * line.shares,
          taxes: (totalTaxes / totalShares) * line.shares,
        }));

        const input: RecordSellInput = {
          portfolioId,
          ticker,
          allocations,
          executionDate: entry.candidate.date,
          executionTime: entry.candidate.time ?? "00:00",
          transactionNumber: entry.candidate.transactionNumber,
          source: entry.candidate.source,
        };

        const result = await recordSell(repos, input, diagnostics);
        importSession.update((prev) => ({
          ...prev,
          addedKeys: [...prev.addedKeys, entry.key],
          addedAllocationIds: { ...prev.addedAllocationIds, [entry.key]: result.allocations.map((a) => a.id) },
        }));
        clearRowError(entry.key);
      });
    } catch (e) {
      setRowError(entry.key, e);
    } finally {
      commitLock.release(entry.key);
    }
  }

  /**
   * Undoes one specific auto-added buy, right from Import — most useful for
   * a low-confidence row the user notices is wrong as soon as it lands.
   * Marked "dismissed" (not just un-added) so auto-commit never silently
   * re-adds a row the user deliberately removed.
   */
  async function deleteAutoAddedTrade(entry: CandidateEntry) {
    const tradeId = importSession.getState().addedTradeIds[entry.key];
    if (!tradeId) return;
    if (!confirm(t("importPage.deleteTradeConfirm"))) {
      return;
    }
    try {
      await deleteTrade(repos, tradeId);
      importSession.update((prev) => {
        const addedTradeIds = { ...prev.addedTradeIds };
        delete addedTradeIds[entry.key];
        return {
          ...prev,
          addedKeys: prev.addedKeys.filter((k) => k !== entry.key),
          dismissedKeys: [...prev.dismissedKeys, entry.key],
          addedTradeIds,
        };
      });
      clearRowError(entry.key);
    } catch (e) {
      setRowError(entry.key, e);
    }
  }

  /**
   * Deletes a trade already sitting on the real ledger for this ticker —
   * not one this Import session added (deleteAutoAddedTrade covers that),
   * but one recorded in an earlier session/import that's now the likely
   * cause of a mismatch (a duplicate buy, a misread quantity). Surfaced
   * directly on a blocked ticker's card (see TickerGroupCard's "Recorded on
   * the ledger" panel) so fixing a duplicate never requires leaving Import
   * for the Trades page and hunting for the right row by hand. Keyed by the
   * trade's own id in the same rowErrors map deleteAutoAddedTrade uses.
   */
  async function deleteExistingTrade(tradeId: string) {
    if (!confirm(t("importPage.deleteTradeConfirm"))) {
      return;
    }
    try {
      await deleteTrade(repos, tradeId);
      clearRowError(tradeId);
    } catch (e) {
      setRowError(tradeId, e);
    }
  }

  /**
   * Commits every pending buy/dividend/verification under one ticker in one
   * go — called only from confirmAndDistributeAll, and only for a ticker
   * whose share count has already reconciled against a broker position
   * screenshot (see tickerMatchStatuses/checkTickerMatch) and whose
   * portfolio has resolved. A buy that's an exact duplicate of an
   * already-recorded trade is skipped silently instead (near-certainly the
   * same transaction re-read from a different file); a "possible" duplicate
   * (same ticker/date/shares, a different price) still commits, since
   * that's usually the same real trade parsed from a different document
   * format, but keeps showing its duplicate badge so it stays visible for a
   * later look. Ambiguous screenshot/manual sells remain excluded because
   * choosing their lots is an explicit financial decision. Native broker
   * Excel sells are applied below with strict FIFO: they are authoritative
   * execution history, and leaving them unallocated would make Holdings show
   * gross buys instead of the broker's real net position.
   */
  async function commitTickerGroup(ticker: string) {
    const portfolioId = resolvedPortfolioId(ticker);
    if (!portfolioId) return;
    const normalizedTicker = normalizeTicker(ticker);
    // Serialized against the IDENTICAL (portfolio, ticker) queue
    // smartAllocateSell/SellAllocationForm already use (see serialize.ts) —
    // closes the one gap that class of fix deliberately left open (see its
    // own doc comment/ROADMAP entry): every Buy this loop commits, and the
    // trailing assignPortfolio sweep below, reactively triggers commitEngine's
    // own commitTicker for this ticker (via appendAndMaybeCommit), the exact
    // same commit pathway a concurrent Smart Allocate/Allocate Sell call also
    // triggers. Without sharing the queue, a Sell allocation started right
    // after Confirm (a completely ordinary "confirm buys, then allocate
    // sells" flow, not just a rapid-click edge case) could run its own
    // commitTicker concurrently with this function's, and whichever
    // commitTicker call's projectLegacyTicker read a transiently-incomplete
    // decision set last would silently delete the OTHER call's just-written
    // TradeAllocation as "stale" — reproduced live: a value-keyed phantom
    // allocation row replaces the real one, and ensureLegacyFactsExist's own
    // gap-backfill (racing the same window) can mint an extra decision for a
    // sell whose real one hasn't landed yet.
    return commitQueue.run(portfolioId, normalizedTicker, () => commitTickerGroupLocked(ticker, portfolioId));
  }

  async function commitTickerGroupLocked(ticker: string, portfolioId: string): Promise<void> {
    diagnostics.recordSessionEvent({ workflowStep: "Confirm", label: `Confirm ${ticker}`, portfolioId, ticker });
    const stateBeforeBatch = importSession.getState();
    const state = stateBeforeBatch;
    const batchState = emptyConfirmBatchState();
    const processBatch = async () => {

    const buys = state.pendingCandidates.filter(
      (e) =>
        normalizeTicker(e.candidate.ticker) === ticker &&
        e.candidate.side === "BUY" &&
        !state.addedKeys.includes(e.key) &&
        !state.skippedKeys.includes(e.key) &&
        !state.dismissedKeys.includes(e.key) &&
        !commitLock.isLocked(e.key),
    );
    const normalBuys: CandidateEntry[] = [];
    // `existingTrades` is a snapshot from before this confirmation starts.
    // Several identical rows in the same workbook therefore cannot be found
    // by duplicateMatch until AFTER recordBuyBatch has already written them.
    // Track the immutable execution identity within this batch so a second
    // identical read is skipped before it can become a Trade. A real time or
    // broker transaction number keeps genuinely separate fills distinct.
    const seenBuyExecutionKeys = new Set<string>();
    for (const entry of buys) {
      commitLock.acquire(entry.key);
      try {
        const candidate = entry.candidate;
        const batchIdentity = candidate.transactionNumber
          ? `${normalizeTicker(candidate.ticker)}|BUY|txn:${candidate.transactionNumber}`
          : `${normalizeTicker(candidate.ticker)}|BUY|${candidate.date}|${candidate.shares}|${Math.round(candidate.price * 10000)}|${candidate.time ?? "unknown"}`;
        if (seenBuyExecutionKeys.has(batchIdentity)) {
          batchState.skippedKeys.push(entry.key);
          continue;
        }
        seenBuyExecutionKeys.add(batchIdentity);
        const match = duplicateMatch(entry.candidate);
        // "exact" is the same read re-imported; a "possible" match whose price
        // sits within OCR/commission noise of the recorded one is the same
        // real trade parsed from a different document format (value-derived
        // vs raw execution price) — committing it would double-count real
        // shares and break the ticker's verification. Only a possible match
        // with a genuinely different price (>1%) still commits, badge intact.
        if (match && (match.matchType === "exact" || pricesWithinOcrNoise(match.matchedPrice, entry.candidate.price))) {
          batchState.skippedKeys.push(entry.key);
          continue;
        }
        if (entry.candidate.needsConfirmation) {
          await addBuyCandidate(entry, ticker, true, batchState);
        } else {
          normalBuys.push(entry);
        }
      } finally {
        if (!normalBuys.some((candidate) => candidate.key === entry.key)) commitLock.release(entry.key);
      }
    }

    // The ordinary Buy rows are the dominant part of a broker workbook.
    // Build them once and let the application service bulk-write the trades,
    // timeline rows, cash update, and canonical facts. This removes the
    // per-row getAll/getByPortfolio/save cycle that used to freeze the page.
    if (normalBuys.length > 0) {
      try {
        const results = await recordBuyBatch(
          repos,
          normalBuys.map((entry) => ({
            portfolioId,
            ticker,
            companyName: entry.candidate.companyName,
            shares: entry.candidate.shares,
            entryPrice: entry.candidate.price,
            fees: entry.candidate.fees ?? 0,
            taxes: entry.candidate.taxes ?? 0,
            executionDate: entry.candidate.date,
            executionTime: entry.candidate.time ?? "00:00",
            notes: "Imported from screenshot/PDF",
            transactionNumber: entry.candidate.transactionNumber,
            source: entry.candidate.source,
            deferCommit: true,
          })),
          diagnostics,
        );
        results.forEach((result, index) => {
          const entry = normalBuys[index];
          batchState.addedKeys.push(entry.key);
          batchState.addedTradeIds[entry.key] = result.trade.id;
        });
      } finally {
        normalBuys.forEach((entry) => commitLock.release(entry.key));
      }
    }

    const dividends = state.pendingDividends.filter(
      (e) => normalizeTicker(e.dividend.ticker) === ticker && !state.addedKeys.includes(e.key) && !commitLock.isLocked(e.key),
    );
    for (const entry of dividends) {
      commitLock.acquire(entry.key);
      try {
        await addDividend(entry, ticker, batchState);
      } finally {
        commitLock.release(entry.key);
      }
    }

    const verifications = state.pendingVerifications.filter(
      (e) => normalizeTicker(e.verification.ticker) === ticker && !state.acceptedKeys.includes(e.key) && !commitLock.isLocked(e.key),
    );
    for (const entry of verifications) {
      commitLock.acquire(entry.key);
      try {
        await acceptVerification(entry, ticker, batchState);
      } finally {
        commitLock.release(entry.key);
      }
    }

    // Migration dual-write: setTickerPortfolio's own assignPortfolio call
    // only fires when the user explicitly picks from the dropdown —
    // resolvedPortfolioId can also resolve implicitly (a ticker already
    // uniquely tied to one portfolio, or a single-portfolio app), in which
    // case that call never happens and this ticker's RawTransactions would
    // stay unassigned forever, never reaching the new architecture's commit
    // trigger. Calling it here too, on every commit regardless of how the
    // portfolio resolved, closes that gap; it's a harmless no-op once
    // setTickerPortfolio already assigned everything. Isolated and
    // non-fatal for the same reason as every other shadow write here.
    //
    // Deliberately run AFTER the three loops above, not before (a real,
    // reproduced bug this ordering fixes): assignPortfolio assigns EVERY
    // still-unassigned live fact for this ticker in one sweep, and each
    // assignment reactively fires commitEngine's own shouldCommit/commitTicker
    // trigger (appendAndMaybeCommit's PortfolioAssignment branch) — a
    // SEPARATE commit pathway from this function's own recordBuy/recordSell
    // calls. Running the sweep BEFORE the buys loop let it assign a SECOND
    // (or later) still-unprocessed candidate the moment the FIRST one's
    // assignment made the whole ticker's verification batch terminal —
    // triggering commitEngine's own projectLegacyTicker to materialize a
    // legacy Trade for that second candidate from raw facts alone, racing
    // this function's own recordBuy call for the SAME candidate moments
    // later and producing two Trade rows for one real execution (reproduced:
    // a ticker with two Excel-sourced Buys in the same import batch ended up
    // with a duplicate Trade, and the genuine candidate's own RawTransaction
    // fact got auto-skipped/retracted as an apparent "exact duplicate" of
    // the phantom one, permanently losing its official-broker-excel
    // provenance the same way the single-Buy race did). Running the sweep
    // LAST means every candidate this call itself processes already has its
    // own Trade AND its own assignment (ensureBuyFact/ensureSellFacts assign
    // individually, immediately after adopting/creating their fact) by the
    // time this blanket sweep runs — it only ever has real gaps left to
    // close (dividends/verifications, which never assign themselves), never
    // a not-yet-recordBuy'd candidate to race.
    //
    // AWAITED (not fire-and-forget) now that this whole function runs inside
    // commitTickerGroup's runSerialized lock for this (portfolio, ticker) —
    // a detached promise here would keep writing/reactively committing after
    // the lock had already released, letting a queued-up Smart Allocate call
    // start its own commitTicker while this sweep's commit was still
    // in flight, reopening the exact race the lock exists to close. Still
    // non-fatal: a failure here is a shadow-write gap (dividends/
    // verifications missing their portfolio assignment), never a reason to
    // fail the Buy commit that already succeeded.
      await assignPortfolio(repos, ticker, portfolioId, diagnostics, { deferCommit: true });
    };

    try {
      if (repos.runInTransaction) {
        await repos.runInTransaction(processBatch);
      } else {
        await processBatch();
      }
    } catch (err) {
      // The database transaction rolls back on failure. Restore the session
      // snapshot too, so the UI never claims rows were Added when their
      // durable writes did not commit.
      importSession.update(() => stateBeforeBatch);
      throw err;
    }

    // A native Thndr workbook is transaction evidence, not an ambiguous
    // position screenshot. Once its buys are durable, apply its sells in
    // execution order using the same date-safe FIFO policy as Smart Allocate.
    // Without this step Confirm records only gross buys, so a fully closed
    // broker position incorrectly survives in Holdings as an open position.
    const officialSells = state.pendingCandidates
      .filter(
        (e) =>
          normalizeTicker(e.candidate.ticker) === ticker &&
          e.candidate.side === "SELL" &&
          e.candidate.source === "official-broker-excel" &&
          !e.candidate.needsConfirmation &&
          !state.addedKeys.includes(e.key) &&
          !state.skippedKeys.includes(e.key) &&
          !state.dismissedKeys.includes(e.key) &&
          !commitLock.isLocked(e.key),
      )
      .sort(
        (a, b) =>
          a.candidate.date.localeCompare(b.candidate.date) ||
          (a.candidate.time ?? "00:00").localeCompare(b.candidate.time ?? "00:00"),
      );

    for (const entry of officialSells) {
      commitLock.acquire(entry.key);
      try {
        await commitOfficialBrokerSell(entry, ticker, portfolioId, batchState);
      } finally {
        commitLock.release(entry.key);
      }
    }

    // All Buy/assignment facts above are durable now and were appended without
    // triggering the expensive full ticker projection. Rebuild exactly once.
    await commitTicker(repos, portfolioId, ticker, diagnostics, { repairOfficialBrokerAllocations: true });
    importSession.update((prev) => ({
      ...prev,
      addedKeys: [...new Set([...prev.addedKeys, ...batchState.addedKeys])],
      acceptedKeys: [...new Set([...prev.acceptedKeys, ...batchState.acceptedKeys])],
      skippedKeys: [...new Set([...prev.skippedKeys, ...batchState.skippedKeys])],
      addedTradeIds: { ...prev.addedTradeIds, ...batchState.addedTradeIds },
      addedAllocationIds: { ...prev.addedAllocationIds, ...batchState.addedAllocationIds },
    }));
  }

  /**
   * Allocates one native-Thndr-workbook sell against this ticker's open
   * lots in execution-date FIFO order, same policy as Smart Allocate — see
   * commitTickerGroupLocked's own call site for why this only ever runs
   * after that function's buy-side transaction has already committed
   * (`repos.trades.getByPortfolio` here must see this batch's own just-
   * written buys as eligible open lots).
   */
  async function commitOfficialBrokerSell(entry: CandidateEntry, ticker: string, portfolioId: string, batch: ConfirmBatchState) {
    try {
      const currentAllocations = await repos.allocations.getAll();
      const duplicate = findDuplicateSellMatch(entry.candidate, currentAllocations);
      if (duplicate && (duplicate.matchType === "exact" || pricesWithinOcrNoise(duplicate.matchedPrice, entry.candidate.price))) {
        batch.skippedKeys.push(entry.key);
        return;
      }

      const alreadyAllocatedShares = alreadyAllocatedSharesForSell(entry.candidate, currentAllocations);
      const sharesToAllocate = entry.candidate.shares - alreadyAllocatedShares;
      if (sharesToAllocate <= 0) {
        batch.skippedKeys.push(entry.key);
        return;
      }

      const openLots = (await repos.trades.getByPortfolio(portfolioId))
        .filter(
          (trade) =>
            normalizeTicker(trade.ticker) === ticker &&
            trade.remainingShares > 0 &&
            isLotEligibleForSell(trade, entry.candidate),
        )
        .sort(
          (a, b) =>
            a.executionDate.localeCompare(b.executionDate) ||
            a.executionTime.localeCompare(b.executionTime),
        );

      let remainingToSell = sharesToAllocate;
      const lines: { tradeId: string; shares: number }[] = [];
      for (const lot of openLots) {
        if (remainingToSell <= 0) break;
        const shares = Math.min(lot.remainingShares, remainingToSell);
        if (shares <= 0) continue;
        lines.push({ tradeId: lot.id, shares });
        remainingToSell -= shares;
      }
      if (remainingToSell > 0) {
        throw new Error(
          `Official broker sell cannot be allocated: need ${sharesToAllocate} remaining shares, only ${sharesToAllocate - remainingToSell} eligible open shares for ${ticker}.`,
        );
      }

      const totalShares = entry.candidate.shares;
      const result = await recordSell(
        repos,
        {
          portfolioId,
          ticker,
          allocations: lines.map((line) => ({
            tradeId: line.tradeId,
            shares: line.shares,
            exitPrice: entry.candidate.price,
            fees: ((entry.candidate.fees ?? 0) / totalShares) * line.shares,
            taxes: ((entry.candidate.taxes ?? 0) / totalShares) * line.shares,
          })),
          executionDate: entry.candidate.date,
          executionTime: entry.candidate.time ?? "00:00",
          transactionNumber: entry.candidate.transactionNumber,
          source: entry.candidate.source,
          deferCommit: true,
        },
        diagnostics,
      );
      batch.addedKeys.push(entry.key);
      batch.addedAllocationIds[entry.key] = result.allocations.map((allocation) => allocation.id);
    } catch (e) {
      // One sell candidate lacking enough eligible open lots (e.g. its
      // buy side fell outside the tracking window, or was itself an
      // unreconstructable "invest by EGP amount" order — see
      // ThndrOrdersWorkbookParser's own skippedValueOrders warning) must
      // never abort every OTHER sell in this same official-broker-excel
      // batch: this used to be an uncaught throw here, which stopped this
      // `for` loop dead — silently skipping every sell queued after the
      // failing one and skipping the commitTicker() rebuild below
      // entirely, so this ticker's already-recorded buys sat with zero
      // sells applied, showing as a fully open position in Holdings
      // despite the broker's own export proving it closed. Surfaced as a
      // normal row error instead (same as every other Import row failure)
      // so the specific unresolvable sell stays visible for the user to
      // investigate, while every other sell — for this ticker and, via
      // confirmAndDistributeAll's own matching per-ticker isolation,
      // every other ticker — still gets allocated.
      setRowError(entry.key, e);
    }
  }

  /**
   * The entry point for actually moving anything into a portfolio. Only
   * ever commits tickers whose match status is already true — Step 1's
   * extraction and Step 2's per-ticker portfolio picks never write a real
   * Trade/Dividend/PositionVerification on their own. This is the two-phase
   * gate: extract-and-verify, then an explicit confirmation before anything
   * is allocated.
   *
   * Commits every currently-matched ticker in one click — deliberately not
   * gated on every ticker in the batch being matched (a single still-stuck
   * ticker, e.g. one still needing "Discard all pending" or a portfolio
   * pick, used to block every other already-verified ticker from
   * distributing at all). confirmTicker below is the same commit, scoped to
   * one ticker, for confirming just that one without waiting on the rest.
   */
  async function confirmAndDistributeAll() {
    // initialDataLoaded gates the button's own `disabled` too, so this should
    // be unreachable in the steady state — but the two are computed from
    // separate useLiveQuery reads on every render, so a click landing in the
    // narrow window where they've gone briefly out of sync must still say
    // something rather than silently doing nothing (see the same historical
    // "silent Import failure" class of bug this page already guards against
    // elsewhere).
    if (!initialDataLoaded) {
      setStage("error");
      setErrorMessage(t("importPage.stillLoadingError"));
      return;
    }
    const matchedTickers = activeTickerGroups
      .filter(([ticker]) => tickerMatchStatuses.get(ticker)?.matched)
      .map(([ticker]) => ticker);
    if (matchedTickers.length === 0) return;
    setDistributing(true);
    importJob.start(matchedTickers);
    try {
      // Tickers in the same portfolio share its cash row. Process those
      // serially to avoid lost-update races, while independent portfolios can
      // still progress concurrently.
      const byPortfolio = new Map<string, string[]>();
      for (const ticker of matchedTickers) {
        const portfolioId = resolvedPortfolioId(ticker);
        if (!portfolioId) continue;
        const group = byPortfolio.get(portfolioId) ?? [];
        group.push(ticker);
        byPortfolio.set(portfolioId, group);
      }
      // One ticker's commitTickerGroup failure (e.g. an official-broker-excel
      // sell that can't find enough eligible open shares) used to be an
      // uncaught throw here, which stopped this portfolio's `for` loop dead —
      // every OTHER already-verified ticker queued behind the failing one
      // silently never got its own commitTickerGroup call at all, leaving a
      // whole batch of genuinely closed positions sitting with unallocated
      // sells and showing as open in Holdings. This is the exact same
      // "single stuck ticker blocks every sibling" failure mode this
      // function's own doc comment already describes for Step 1/2 gating —
      // it just wasn't closed for a commit-time failure. Each ticker is now
      // isolated: a failure is recorded as a normal row error on that
      // ticker's own card (see TickerGroupCard's rowErrors[ticker] banner)
      // and the loop continues to the next ticker.
      const failedTickers: string[] = [];
      await Promise.all(
        [...byPortfolio.values()].map(async (tickers) => {
          for (const ticker of tickers) {
            importJob.markTickerStarted(ticker);
            try {
              await commitTickerGroup(ticker);
              clearRowError(ticker);
              importJob.markTickerComplete(ticker);
            } catch (e) {
              setRowError(ticker, e);
              failedTickers.push(ticker);
            }
          }
        }),
      );
      if (failedTickers.length > 0) {
        setStage("error");
        const message = t("importPage.confirmPartialFailed", { tickers: failedTickers.join(", ") });
        importJob.fail(message);
        setErrorMessage(message);
      } else {
        importJob.complete();
        setStage("idle");
      }
    } catch (e) {
      setStage("error");
      const message = e instanceof Error ? e.message : t("importPage.confirmFailed");
      importJob.fail(message);
      setErrorMessage(message);
    } finally {
      setDistributing(false);
    }
  }

  /** Confirms and distributes just one ticker, independent of any other still-stuck ticker in the same batch. */
  async function confirmTicker(ticker: string) {
    if (!initialDataLoaded) {
      setStage("error");
      setErrorMessage(t("importPage.stillLoadingError"));
      return;
    }
    if (!tickerMatchStatuses.get(ticker)?.matched) return;
    setDistributing(true);
    importJob.start([ticker]);
    try {
      importJob.markTickerStarted(ticker);
      await commitTickerGroup(ticker);
      importJob.markTickerComplete(ticker);
      importJob.complete();
      setStage("idle");
    } catch (e) {
      setStage("error");
      const message = e instanceof Error ? e.message : t("importPage.confirmFailed");
      importJob.fail(message);
      setErrorMessage(message);
    } finally {
      setDistributing(false);
    }
  }

  async function clearAll() {
    const uploads = await repos.uploads.getAll();
    await Promise.all(uploads.map((u) => repos.uploads.delete(u.id)));
    importSession.clear();
    setRecentFileResults([]);
  }

  /**
   * Factory-reset for ONE ticker: permanently deletes everything ever
   * recorded for it (trades, allocations, timeline, journal, verifications,
   * raw transactions, ledger caches, and the uploads that carried it — see
   * purgeTickerData) AND every trace of it in this import session, so
   * re-uploading its documents starts from a truly blank slate, as if the
   * stock had never been imported.
   */
  async function resetTickerData(ticker: string) {
    if (!confirm(t("importPage.resetTickerConfirm", { ticker }))) return;
    try {
      await purgeTickerData(ticker);
      importSession.update((prev) => {
        const droppedKeys = new Set<string>();
        for (const e of [...prev.pendingCandidates, ...prev.discardedCandidates]) {
          if (normalizeTicker(e.candidate.ticker) === ticker) droppedKeys.add(e.key);
        }
        for (const e of prev.pendingVerifications) if (normalizeTicker(e.verification.ticker) === ticker) droppedKeys.add(e.key);
        for (const e of prev.pendingDividends) if (normalizeTicker(e.dividend.ticker) === ticker) droppedKeys.add(e.key);
        for (const e of prev.pendingOrderEvidences) if (normalizeTicker(e.evidence.ticker) === ticker) droppedKeys.add(e.key);
        const tickerPortfolio = { ...prev.tickerPortfolio };
        delete tickerPortfolio[ticker];
        return {
          ...prev,
          pendingCandidates: prev.pendingCandidates.filter((e) => !droppedKeys.has(e.key)),
          pendingVerifications: prev.pendingVerifications.filter((e) => !droppedKeys.has(e.key)),
          pendingDividends: prev.pendingDividends.filter((e) => !droppedKeys.has(e.key)),
          pendingOrderEvidences: prev.pendingOrderEvidences.filter((e) => !droppedKeys.has(e.key)),
          discardedCandidates: prev.discardedCandidates.filter((e) => !droppedKeys.has(e.key)),
          addedKeys: prev.addedKeys.filter((k) => !droppedKeys.has(k)),
          acceptedKeys: prev.acceptedKeys.filter((k) => !droppedKeys.has(k)),
          skippedKeys: prev.skippedKeys.filter((k) => !droppedKeys.has(k)),
          dismissedKeys: prev.dismissedKeys.filter((k) => !droppedKeys.has(k)),
          recordedRawFactKeys: prev.recordedRawFactKeys.filter((k) => !droppedKeys.has(k)),
          addedTradeIds: Object.fromEntries(Object.entries(prev.addedTradeIds).filter(([k]) => !droppedKeys.has(k))),
          addedAllocationIds: Object.fromEntries(Object.entries(prev.addedAllocationIds).filter(([k]) => !droppedKeys.has(k))),
          tickerPortfolio,
        };
      });
      setStage("idle");
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : t("importPage.resetTickerFailed"));
    }
  }

  /**
   * Discards suggested-duplicate pending candidates outright (unlike a
   * committed trade's delete, which reverses cash — these were never
   * committed, so there's nothing to refund). Never touches an
   * already-added/skipped/dismissed row; only rows still genuinely pending
   * are eligible, matching pendingDuplicateCandidateKeys below.
   */
  /**
   * Discarded rows move to discardedCandidates instead of vanishing: a
   * discarded duplicate is still a real read of its document, and the
   * surviving row's dual-source confirmation must not evaporate the moment
   * the redundant copy is cleaned up for commit.
   */
  function moveToDiscarded(prev: typeof session, keys: Set<string>) {
    // Phase 9.7: fires once here for all four discard entry points below
    // (clearPendingDuplicateCandidates, discardPendingCandidate,
    // discardPendingCandidateKeys, discardAllPendingForTicker) instead of
    // once per call site.
    retractRawTransactionKeys(keys);
    return {
      ...prev,
      pendingCandidates: prev.pendingCandidates.filter((e) => !keys.has(e.key)),
      discardedCandidates: [...prev.discardedCandidates, ...prev.pendingCandidates.filter((e) => keys.has(e.key))],
    };
  }

  function clearPendingDuplicateCandidates() {
    if (pendingDuplicateCandidateKeys.length === 0) return;
    const keys = new Set(pendingDuplicateCandidateKeys);
    importSession.update((prev) => moveToDiscarded(prev, keys));
  }

  /** Discards one order-evidence row read from an Orders screenshot — for a visibly misread row, so it can't wrongly corroborate (or fail to corroborate) anything. */
  function discardOrderEvidence(key: string) {
    importSession.update((prev) => ({
      ...prev,
      pendingOrderEvidences: prev.pendingOrderEvidences.filter((e) => e.key !== key),
    }));
    retractRawTransactionKeys([key]);
  }

  /** Discards one specific still-pending candidate — the single-row counterpart to clearPendingDuplicateCandidates. */
  function discardPendingCandidate(key: string) {
    importSession.update((prev) => moveToDiscarded(prev, new Set([key])));
  }

  /** Discards a named set of still-pending candidates in one shot — used by the mismatch auto-reconcile suggestion (see reconcileSuggestions). */
  function discardPendingCandidateKeys(keys: string[]) {
    importSession.update((prev) => moveToDiscarded(prev, new Set(keys)));
  }

  /**
   * For a ticker flagged alreadyFullyRecorded (see checkTickerMatch): the
   * broker independently confirms the ledger was already correct before
   * this batch, so every pending Buy/Sell for this ticker is re-describing
   * shares already accounted for — not a genuinely new transaction. Unlike
   * clearPendingDuplicateCandidates, this doesn't rely on any individual row
   * matching a specific sibling or existing trade by date+shares, since the
   * whole point is that the existing lots were recorded with a different
   * split than this new read. Never touches verifications (that's the
   * ground truth this decision rests on) or dividends (already deduped
   * separately at extraction time).
   */
  function discardAllPendingForTicker(ticker: string) {
    importSession.update((prev) =>
      moveToDiscarded(
        prev,
        new Set(prev.pendingCandidates.filter((e) => normalizeTicker(e.candidate.ticker) === ticker).map((e) => e.key)),
      ),
    );
  }

  /**
   * Restores ALL dismissed, skipped, and discarded candidates for a specific
   * ticker back to pending — the inverse of the individual trash/skip actions.
   * Useful when a row was accidentally deleted: one tap brings back every
   * hidden row for that ticker so the user can re-evaluate them.
   */
  function restoreTickerCandidates(ticker: string) {
    importSession.update((prev) => {
      const tickerDiscarded = prev.discardedCandidates.filter(
        (e) => normalizeTicker(e.candidate.ticker) === ticker,
      );
      const tickerDiscardedKeys = new Set(tickerDiscarded.map((e) => e.key));
      const tickerPendingKeys = new Set(
        prev.pendingCandidates
          .filter((e) => normalizeTicker(e.candidate.ticker) === ticker)
          .map((e) => e.key),
      );
      const toRestore = new Set([...tickerDiscardedKeys, ...tickerPendingKeys]);
      return {
        ...prev,
        pendingCandidates: [...prev.pendingCandidates, ...tickerDiscarded],
        discardedCandidates: prev.discardedCandidates.filter((e) => !tickerDiscardedKeys.has(e.key)),
        skippedKeys: prev.skippedKeys.filter((k) => !toRestore.has(k)),
        dismissedKeys: prev.dismissedKeys.filter((k) => !toRestore.has(k)),
      };
    });
  }

  async function addDividend(entry: DividendEntry, ticker: string, batch?: ConfirmBatchState) {
    try {
      const portfolioId = portfolioForTicker(ticker);
      await recordDividend(repos, portfolioId, {
        ticker,
        amount: entry.dividend.amount,
        date: entry.dividend.date,
        notes: "Imported from screenshot/PDF",
      });
      if (batch) batch.addedKeys.push(entry.key);
      else {
        importSession.update((prev) => ({ ...prev, addedKeys: [...prev.addedKeys, entry.key] }));
        clearRowError(entry.key);
      }
    } catch (e) {
      setRowError(entry.key, e);
      if (batch) throw e;
    }
  }

  /**
   * OCR ticker resolution isn't perfect — a garbled/unrecognized company name
   * can still produce a low-confidence guess that's flat-out wrong (see
   * ThndrParser's header-ticker fallback). Rather than trying to make OCR
   * infallible, this gives the user a direct way to correct it: every
   * pending candidate/verification/dividend currently grouped under the
   * wrong ticker moves to the corrected one, AND — since auto-commit now
   * means a row is often already a real trade by the time a wrong ticker is
   * noticed — every already-recorded row under that ticker is corrected too
   * (`renameTickerEverywhere`, covering Trade/TradeAllocation/TimelineEvent/
   * PositionVerification). Correcting the pending pool first means anything
   * still waiting on a portfolio pick auto-commits under the right ticker
   * from the start, rather than needing this same fix run twice.
   */
  async function renameTickerGroup(oldTicker: string, newTickerRaw: string) {
    const newTicker = normalizeTicker(newTickerRaw);
    if (!newTicker || newTicker === oldTicker) return;
    importSession.update((prev) => {
      const tickerPortfolioNext = { ...prev.tickerPortfolio };
      if (prev.tickerPortfolio[oldTicker] && !tickerPortfolioNext[newTicker]) {
        tickerPortfolioNext[newTicker] = prev.tickerPortfolio[oldTicker];
      }
      return {
        ...prev,
        pendingCandidates: prev.pendingCandidates.map((e) =>
          normalizeTicker(e.candidate.ticker) === oldTicker ? { ...e, candidate: { ...e.candidate, ticker: newTicker } } : e,
        ),
        pendingVerifications: prev.pendingVerifications.map((e) =>
          normalizeTicker(e.verification.ticker) === oldTicker
            ? { ...e, verification: { ...e.verification, ticker: newTicker } }
            : e,
        ),
        pendingDividends: prev.pendingDividends.map((e) =>
          normalizeTicker(e.dividend.ticker) === oldTicker ? { ...e, dividend: { ...e.dividend, ticker: newTicker } } : e,
        ),
        pendingOrderEvidences: prev.pendingOrderEvidences.map((e) =>
          normalizeTicker(e.evidence.ticker) === oldTicker ? { ...e, evidence: { ...e.evidence, ticker: newTicker } } : e,
        ),
        discardedCandidates: prev.discardedCandidates.map((e) =>
          normalizeTicker(e.candidate.ticker) === oldTicker ? { ...e, candidate: { ...e.candidate, ticker: newTicker } } : e,
        ),
        tickerPortfolio: tickerPortfolioNext,
      };
    });
    try {
      await renameTickerEverywhere(repos, oldTicker, newTicker);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Failed to correct already-recorded rows for this ticker.");
    }
  }

  async function acceptVerification(entry: VerificationEntry, ticker: string, batch?: ConfirmBatchState) {
    try {
      const portfolioId = portfolioForTicker(ticker);
      await repos.verifications.save({
        ...entry.verification,
        id: generateId(),
        portfolioId,
        ticker: normalizeTicker(entry.verification.ticker),
      });
      if (batch) batch.acceptedKeys.push(entry.key);
      else {
        importSession.update((prev) => ({ ...prev, acceptedKeys: [...prev.acceptedKeys, entry.key] }));
        clearRowError(entry.key);
      }
    } catch (e) {
      setRowError(entry.key, e);
      if (batch) throw e;
    }
  }

  const tickerGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        buys: CandidateEntry[];
        sells: CandidateEntry[];
        verifications: VerificationEntry[];
        dividends: DividendEntry[];
        orderEvidences: OrderEvidenceEntry[];
      }
    >();
    const group = (ticker: string) => {
      const t = normalizeTicker(ticker);
      const g = map.get(t) ?? { buys: [], sells: [], verifications: [], dividends: [], orderEvidences: [] };
      map.set(t, g);
      return g;
    };
    for (const entry of pendingCandidates) {
      const g = group(entry.candidate.ticker);
      (entry.candidate.side === "BUY" ? g.buys : g.sells).push(entry);
    }
    for (const entry of pendingVerifications) {
      group(entry.verification.ticker).verifications.push(entry);
    }
    for (const entry of pendingDividends) {
      group(entry.dividend.ticker).dividends.push(entry);
    }
    for (const entry of pendingOrderEvidences) {
      group(entry.evidence.ticker).orderEvidences.push(entry);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences]);

  // Import sessions can contain thousands of rows. Index durable data once
  // per Dexie snapshot instead of rescanning the full arrays for every ticker
  // in each derived verification pass. This is a read-only representation;
  // matching, reconciliation and commit rules remain unchanged.
  const existingVerificationsByTicker = useMemo(() => {
    const map = new Map<string, typeof existingVerifications>();
    for (const verification of existingVerifications) {
      const ticker = normalizeTicker(verification.ticker);
      const rows = map.get(ticker) ?? [];
      rows.push(verification);
      map.set(ticker, rows);
    }
    return map;
  }, [existingVerifications]);

  /**
   * Nothing dedupes a pending Buy/Sell candidate against its own siblings in
   * the same batch the way processFiles already dedupes verifications and
   * dividends at extraction time — findDuplicateBuyMatch/findDuplicateSellMatch
   * (below, via duplicateMatch) only ever compare against trades already
   * committed to the ledger. An overlapping multi-file drop or a repeated PDF
   * page therefore piles up as separate pending rows with nothing flagging
   * the cause, inflating a ticker's extracted share total past its broker
   * screenshot with no way to fix it short of re-extracting from scratch.
   *
   * The same inflation happens for the opposite reason too: a pending
   * candidate can duplicate a trade already committed from an earlier import
   * (the same statement re-uploaded weeks later) — findDuplicateBuyMatch/
   * findDuplicateSellMatch already flag that with the amber/rose "Possible
   * duplicate"/"Duplicate" badge, but before this only ever informed the
   * user; there was no action to actually discard the redundant pending row,
   * so a ticker like this stayed permanently "Blocked" with its Mismatch
   * banner pointing at a duplicate nothing could remove. Folding both cases
   * into one set means "Clear suspected duplicates" and the per-row Discard
   * button resolve either kind the same way — discarding a pending row is
   * always safe regardless of which sibling or already-committed trade it
   * duplicates, since nothing has been committed for it yet.
   *
   * Computed only over rows still actually pending (excluding
   * added/skipped/dismissed) since those are already resolved one way or
   * another and out of this batch's editable pool.
   */
  const pendingDuplicateCandidateKeys = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    const siblingDuplicateKeys = suggestDuplicatePendingCandidateKeysToDelete(stillPending);
    const existingTradeDuplicateKeys = stillPending
      .filter((e) =>
        e.candidate.side === "BUY"
          ? findDuplicateBuyMatch(e.candidate, existingTrades) !== undefined
          : findDuplicateSellMatch(e.candidate, existingAllocations) !== undefined,
      )
      .map((e) => e.key);
    return [...new Set([...siblingDuplicateKeys, ...existingTradeDuplicateKeys])];
  }, [pendingCandidates, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingAllocations]);
  const pendingDuplicateCandidateKeySet = useMemo(() => new Set(pendingDuplicateCandidateKeys), [pendingDuplicateCandidateKeys]);

  /**
   * The dual-source rule, page-wide: every still-pending row whose exact
   * transaction (ticker/side/date/share count) was read from two DIFFERENT
   * document types — statement + invoice, statement + orders screenshot,
   * etc. (see findCrossSourceVerifiedKeys). Drives the per-row "Two
   * documents agree" badge and feeds the per-ticker verification gate.
   */
  const crossVerifiedKeys = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    // Discarded rows still corroborate: cleaning up the redundant copy of a
    // statement+orders-screenshot pair must not un-verify the row that stays.
    return findCrossSourceVerifiedKeys([...stillPending, ...session.discardedCandidates]);
  }, [pendingCandidates, session.discardedCandidates, addedKeys, skippedKeys, dismissedKeys]);

  /**
   * Statement Aggregate Reconciliation: Statement candidate key -> the
   * execution row keys (from Orders/an Orders screenshot/an Invoice/a CSV
   * export) whose shares sum exactly to it (see
   * findAggregateStatementMatches). Only searched for a Statement row
   * without a direct 1:1 cross-source match already (crossVerifiedKeys) —
   * Case 1 (one Statement row, one execution of the identical share count)
   * is already resolved by the dual-source rule above; this only covers
   * Case 2, a Statement row summarizing more than one execution.
   *
   * Deliberately NOT filtered by skippedKeys, unlike the other per-row
   * derivations above: the Statement row's own "skipped" state is the
   * OUTPUT of this exact match (see the aggregate auto-skip effect above),
   * so excluding skipped rows here would make the match — and therefore the
   * skip and the execution rows' "Confirmed by Statement" badge — disappear
   * the instant it succeeds. Same self-referential trap crossVerifiedKeys
   * avoids by re-including session.discardedCandidates after cleanup.
   */
  const aggregateStatementMatches = useMemo(() => {
    const stillPending = pendingCandidates.filter((e) => !addedKeys.has(e.key) && !dismissedKeys.has(e.key));
    return findAggregateStatementMatches(stillPending, crossVerifiedKeys);
  }, [pendingCandidates, addedKeys, dismissedKeys, crossVerifiedKeys]);

  /** Every execution row confirmed as part of a Statement aggregate — drives the "Confirmed by Statement" badge and lets the ticker verify without a broker screenshot the same way crossVerifiedKeys/orderConfirmedKeys already do. */
  const aggregateConfirmedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const executionKeys of aggregateStatementMatches.values()) {
      for (const key of executionKeys) keys.add(key);
    }
    return keys;
  }, [aggregateStatementMatches]);

  /** Per-execution-row breakdown text ("BUY 5,000 sh + BUY 3,000 sh") for the "Confirmed by Statement" badge's tooltip — the group of rows a Statement row aggregated this one with. */
  const aggregateGroupDetailByKey = useMemo(() => {
    const map = new Map<string, string>();
    if (aggregateStatementMatches.size === 0) return map;
    const byKey = new Map(pendingCandidates.map((e) => [e.key, e] as const));
    for (const executionKeys of aggregateStatementMatches.values()) {
      const rows = executionKeys.map((k) => byKey.get(k)).filter((e): e is CandidateEntry => e !== undefined);
      const summary = rows.map((e) => `${e.candidate.side} ${formatShares(e.candidate.shares)}`).join(" + ");
      for (const key of executionKeys) map.set(key, summary);
    }
    return map;
  }, [aggregateStatementMatches, pendingCandidates]);

  /**
   * Corroboration confidence bump, live: a still-pending row confirmed by
   * two independent document types (crossVerifiedKeys) or by a Statement
   * aggregate (aggregateConfirmedKeys) is raised to "high" confidence —
   * same philosophy as completeCandidateFieldsFromSiblings' one-shot patch
   * at upload time, generalized to (a) also cover the aggregate-match case,
   * which never shares an exact signature with what it summarizes so that
   * function can't see it, and (b) re-evaluate live on every render instead
   * of freezing at whatever was true the moment the file was processed — a
   * corroboration that only completes once a second document arrives later
   * (the first sat pending a while before the confirming one was uploaded)
   * now gets reflected instead of leaving the row stuck showing "Low-
   * confidence ticker guess" despite the badges right next to it already
   * proving the transaction is corroborated. See keysToRaiseToHighConfidence
   * (duplicateDetection.ts) for the actual raise decision; this effect only
   * decides WHEN to apply it and writes the patch into the session once.
   */
  useEffect(() => {
    const corroboratedKeys = new Set([...crossVerifiedKeys, ...aggregateConfirmedKeys]);
    const keysToRaise = keysToRaiseToHighConfidence(pendingCandidates, corroboratedKeys);
    if (keysToRaise.length === 0) return;
    const raiseSet = new Set(keysToRaise);
    importSession.update((prev) => ({
      ...prev,
      pendingCandidates: prev.pendingCandidates.map((e) =>
        raiseSet.has(e.key) ? { ...e, candidate: { ...e.candidate, confidence: "high" } } : e,
      ),
    }));
  }, [pendingCandidates, crossVerifiedKeys, aggregateConfirmedKeys]);

  /**
   * Pending Buy/Sell rows corroborated by a fulfilled order on the broker's
   * own account-wide "Orders" timeline screenshot (same ticker/side/share
   * count, price within tolerance — see findOrderConfirmedKeys). Drives the
   * per-row "Matches Orders history" badge, and — when EVERY still-pending
   * row of a ticker is confirmed one way or another — lets the ticker verify
   * without a "My Position" screenshot (checkTickerMatch's orders-verified).
   */
  const orderConfirmedKeys = useMemo(() => {
    if (pendingOrderEvidences.length === 0) return new Set<string>();
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findOrderConfirmedKeys(
      stillPending,
      pendingOrderEvidences.map((e) => e.evidence),
    );
  }, [pendingCandidates, pendingOrderEvidences, addedKeys, skippedKeys, dismissedKeys]);

  /**
   * Fulfilled evidence rows that had no matching pending candidate — grouped
   * by ticker. A verified ticker with orphaned evidence has transaction
   * history that isn't in the ledger yet (may be a historical buy that was
   * sold, or simply missing from the current batch). Surfaced as a warning
   * banner on the ticker card so the user knows to upload a Statement.
   */
  const orphanedEvidenceByTicker = useMemo(() => {
    if (pendingOrderEvidences.length === 0) return new Map<string, ParsedOrderEvidence[]>();
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findOrphanedFulfilledEvidence(
      stillPending,
      pendingOrderEvidences.map((e) => e.evidence),
    );
  }, [pendingCandidates, pendingOrderEvidences, addedKeys, skippedKeys, dismissedKeys]);

  /**
   * The verification gate (Step 2 of the two-phase workflow): a ticker's
   * pending buys/sells only get a green light once their net effect on its
   * share count exactly reconciles against a broker "My Position"
   * screenshot for that ticker — the most recent one, whether it was
   * accepted in an earlier session (existingVerifications) or is still
   * sitting in this batch's pending pool. A ticker with no pending buy/sell
   * candidates at all (a dividend-only or stray verification-only read) has
   * no share count to reconcile and is trivially matched. Nothing here
   * writes anything — see confirmAndDistributeAll for the one place that
   * actually commits, and only for tickers this reports as matched.
   */
  const tickerMatchStatuses = useMemo(() => {
    const map = new Map<string, TickerMatchStatus>();
    for (const [ticker, group] of tickerGroups) {
      const remainingBuys = group.buys.filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      const remainingSells = group.sells.filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      const pendingBuyShares = remainingBuys.reduce((sum, e) => sum + e.candidate.shares, 0);
      const pendingSellShares = remainingSells.reduce((sum, e) => sum + e.candidate.shares, 0);
      const remainingBuysAndSells = [...remainingBuys, ...remainingSells];
      // With nothing left pending, this ticker's verdict depends entirely
      // on isTickerFullyOfficialBrokerExcelSourced(existingRawTransactions,
      // ...) below — and existingRawTransactionsRaw is its own independent
      // useLiveQuery, which can still be `undefined` (not yet loaded, not
      // "genuinely empty") even after every OTHER read this component
      // depends on has already resolved. Deciding this ticker's verdict off
      // the default-empty `[]` in that window would read a fully
      // official-broker-excel-sourced, already-fully-committed ticker as
      // "closed-position"/"no-verification" — a real, reproducible instance
      // of the trust policy being bypassed by a data race, not by wrong
      // decision logic (see docs/ROADMAP.md). Leaving this ticker OUT of the
      // map entirely (ImportMatchBadge renders a neutral "checking…" state for an
      // absent entry, never "needs a screenshot") is strictly narrower than
      // gating the whole page: a ticker with real pending rows this batch
      // never depends on this query at all and is unaffected.
      if (remainingBuysAndSells.length === 0 && !rawTransactionsLoaded) continue;
      const allPendingFromInvoice =
        remainingBuysAndSells.length > 0 && remainingBuysAndSells.every((e) => e.candidate.source === "invoice");
      // While rows are still pending, only trust THIS batch's own sourcing —
      // never let the ticker's past history override a genuinely new,
      // not-yet-verified row from a different source (e.g. a fresh
      // screenshot-sourced buy on a ticker whose OLDER history happens to be
      // Excel-sourced must still go through ordinary verification). Only
      // once nothing is left pending at all (already fully committed, this
      // session or an earlier one) does the ticker's full committed history
      // matter — a closed position with zero remaining pending rows would
      // otherwise fall through to checkTickerMatch's "closed-position, no
      // corroboration" branch purely because there's nothing left pending to
      // check the source of, even though every real transaction behind it
      // came from the broker's own official export.
      const sessionCandidatesForTicker = [
        ...group.buys,
        ...group.sells,
        ...session.discardedCandidates.filter((entry) => normalizeTicker(entry.candidate.ticker) === ticker),
      ].map((entry) => entry.candidate);
      const allSessionCandidatesFromOfficialBrokerExcel =
        sessionCandidatesForTicker.length > 0 && sessionCandidatesForTicker.every((candidate) => candidate.source === "official-broker-excel");
      const durableOfficialCandidates = officialUploadCandidatesByTicker.get(ticker) ?? [];
      const tradesForTicker = existingTradesByTicker.get(ticker) ?? [];
      const existingRemainingShares = tradesForTicker
        .reduce((sum, t) => sum + t.remainingShares, 0);
      const allPendingFromOfficialBrokerExcel =
        remainingBuysAndSells.length > 0
          ? remainingBuysAndSells.every((e) => e.candidate.source === "official-broker-excel")
          : isTickerFullyOfficialBrokerExcelSourced(existingRawTransactions, ticker) ||
            (allSessionCandidatesFromOfficialBrokerExcel &&
              isTickerOfficialBrokerExcelCoveredByCandidates(existingRawTransactions, ticker, sessionCandidatesForTicker, existingRemainingShares)) ||
            isTickerOfficialBrokerExcelCoveredByCandidates(existingRawTransactions, ticker, durableOfficialCandidates, existingRemainingShares);
      const allPendingSelfVerified =
        remainingBuysAndSells.length > 0 &&
        remainingBuysAndSells.every(
          (e) =>
            e.candidate.source === "invoice" ||
            e.candidate.source === "official-broker-excel" ||
            crossVerifiedKeys.has(e.key) ||
            aggregateConfirmedKeys.has(e.key),
        );
      const allPendingOrderConfirmed =
        remainingBuysAndSells.length > 0 &&
        remainingBuysAndSells.every(
          (e) =>
            e.candidate.source === "invoice" ||
            e.candidate.source === "official-broker-excel" ||
            crossVerifiedKeys.has(e.key) ||
            aggregateConfirmedKeys.has(e.key) ||
            orderConfirmedKeys.has(e.key),
        );
      const verificationCandidates = [
        ...(existingVerificationsByTicker.get(ticker) ?? []),
        ...group.verifications.map((e) => e.verification),
      ];
      const latestVerification = verificationCandidates.length
        ? verificationCandidates.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b))
        : undefined;

      map.set(
        ticker,
        checkTickerMatch({
          // Reconciliation is about shares that still exist or rows that
          // still need a decision. Counting every historical row in the
          // card kept this true after all of them had already been added,
          // skipped, or dismissed. A fully-resolved ticker then reached
          // checkTickerMatch as `0 + 0 - 0` with hasShares=true and was
          // incorrectly labelled "Closed — needs corroborating evidence".
          hasShares: hasSharesToReconcile(remainingBuysAndSells.length, existingRemainingShares),
          pendingBuyShares,
          pendingSellShares,
          existingRemainingShares,
          verifiedUnits: latestVerification?.units,
          verifiedAvgCost: latestVerification?.avgCost,
          allPendingFromInvoice,
          allPendingFromOfficialBrokerExcel,
          allPendingSelfVerified,
          allPendingOrderConfirmed,
          ticker,
          diagnostics,
        }),
      );
    }
    return map;
  }, [
    tickerGroups,
    addedKeys,
    skippedKeys,
    dismissedKeys,
    existingTradesByTicker,
    existingVerificationsByTicker,
    existingRawTransactions,
    rawTransactionsLoaded,
    session.discardedCandidates,
    officialUploadCandidatesByTicker,
    crossVerifiedKeys,
    aggregateConfirmedKeys,
    orderConfirmedKeys,
  ]);

  /**
   * A ticker is "fully matched" once every buy/sell/dividend/verification row
   * extracted for it has reached a terminal state (committed, skipped as an
   * exact duplicate, or manually dismissed) and none is stuck on a row error
   * — i.e. there's nothing left here for the user to look at. Once true, its
   * card moves out of the active working list into the collapsed "Fully
   * matched" summary below, so the active list only ever shows tickers that
   * still need a decision (an unmatched share count, an unallocated sell, a
   * failed commit). A ticker with zero buy/sell rows (dividend/verification-
   * only) never resolves this way — there's no "sell = buy" question to
   * answer for it, so it stays visible like any other still-open card.
   */
  const rowErrorKeys = useMemo(() => new Set(Object.keys(rowErrors)), [rowErrors]);

  const tickerResolution = useMemo(() => {
    const map = new Map<string, { resolved: boolean; transactionCount: number }>();
    for (const [ticker, group] of tickerGroups) {
      const transactionKeys = [...group.buys, ...group.sells].map((e) => e.key);
      const resolved = isTickerFullyResolved({
        matched: Boolean(tickerMatchStatuses.get(ticker)?.matched),
        transactionKeys,
        dividendKeys: group.dividends.map((e) => e.key),
        verificationKeys: group.verifications.map((e) => e.key),
        addedKeys,
        skippedKeys,
        dismissedKeys,
        acceptedKeys,
        rowErrorKeys,
      });
      map.set(ticker, { resolved, transactionCount: transactionKeys.length });
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, addedKeys, skippedKeys, dismissedKeys, acceptedKeys, rowErrorKeys]);

  const activeTickerGroups = useMemo(
    () => tickerGroups.filter(([ticker]) => !tickerResolution.get(ticker)?.resolved),
    [tickerGroups, tickerResolution],
  );
  const completedTickerGroups = useMemo(
    () => tickerGroups.filter(([ticker]) => tickerResolution.get(ticker)?.resolved),
    [tickerGroups, tickerResolution],
  );
  const completedTickerTransactionCounts = useMemo(
    () => new Map([...tickerResolution.entries()].map(([ticker, r]) => [ticker, r.transactionCount])),
    [tickerResolution],
  );

  const unmatchedTickerCount = activeTickerGroups.filter(([ticker]) => !tickerMatchStatuses.get(ticker)?.matched).length;
  const matchedTickerCount = activeTickerGroups.length - unmatchedTickerCount;
  const allTickersMatched = activeTickerGroups.length > 0 && unmatchedTickerCount === 0;

  /**
   * The one duplicate shape every per-ticker check above is blind to: the
   * same physical execution OCR'd twice under two different guessed tickers
   * (an unmapped company-name fallback filed the real transaction under one
   * name, a fuzzy guess filed its phantom under another). Key -> the ticker
   * the row most likely belongs to, driving a badge on the phantom row.
   */
  const wrongTickerHints = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    const hints = findWrongTickerCandidateKeys(stillPending, existingTrades, existingAllocations);
    // The Orders timeline prints the REAL ticker code on every row, so it can
    // catch a misfiled read even when no committed/pending copy exists under
    // the right ticker. Ledger/pending-based hints take precedence — they
    // point at an actual duplicate record, not just a matching order.
    if (pendingOrderEvidences.length > 0) {
      const orderHints = findWrongTickerHintsFromOrders(
        stillPending,
        pendingOrderEvidences.map((e) => e.evidence),
      );
      for (const [key, ticker] of orderHints) {
        if (!hints.has(key)) hints.set(key, ticker);
      }
    }
    return hints;
  }, [pendingCandidates, pendingOrderEvidences, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingAllocations]);

  /**
   * A pending row whose ticker/side/shares/price closely match a trade
   * already on the ledger, but whose date differs by exactly a single-digit
   * OCR misread — real observed failure (RMDA): the same execution,
   * duplicated across a scroll-overlap pair of screenshots, read once with
   * the day intact and once misread, so the exact-date signature every
   * other duplicate check relies on never caught it. Advisory only (see
   * findDateMisreadDuplicateHints) — drives a badge, never an auto-skip.
   */
  const dateMisreadHints = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findDateMisreadDuplicateHints(stillPending, existingTrades, existingAllocations);
  }, [pendingCandidates, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingAllocations]);

  /**
   * For a mismatch none of the row-level checks can explain, the share
   * arithmetic itself often can: which subset of pending rows, removed,
   * leaves exactly the broker's verified count — ranked by the broker's own
   * avg cost when it was captured (see suggestRemovalsToReconcile). Ticker ->
   * the suggested removal, driving the banner's one-click fix. Skips
   * alreadyFullyRecorded tickers, which have their own bulk-discard action.
   */
  const reconcileSuggestions = useMemo(() => {
    const map = new Map<string, ReconcileSuggestion>();
    for (const [ticker, group] of tickerGroups) {
      // "mismatch" is only ever reached inside checkTickerMatch once a
      // verification was actually found — existingRemainingShares/
      // verifiedUnits/verifiedAvgCost are read straight off its own result
      // rather than re-selecting "the latest PositionVerification for this
      // ticker" a second time here (a real, found duplicate this consolidates
      // away — see importVerification.ts's verifiedAvgCost echo).
      const status = tickerMatchStatuses.get(ticker);
      if (!status || status.reason !== "mismatch" || status.alreadyFullyRecorded || status.verifiedUnits === undefined) continue;
      const stillPending = [...group.buys, ...group.sells].filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      // Still needed for cost basis (a quantity checkTickerMatch doesn't
      // track at all, unlike share counts) — the individual trades, not just
      // their remainingShares sum, are required to weight entryPrice per lot.
      const existingForTicker = existingTradesByTicker.get(ticker) ?? [];
      const suggestion = suggestRemovalsToReconcile({
        rows: stillPending.map((e) => ({
          key: e.key,
          side: e.candidate.side,
          shares: e.candidate.shares,
          price: e.candidate.price,
          confidence: e.candidate.confidence,
        })),
        existingRemainingShares: status.existingRemainingShares ?? 0,
        existingCostBasis: Money.sum(
          existingForTicker.map((t) => Money.from(t.entryPrice).multiply(t.remainingShares)),
        ).toNumber(),
        verifiedUnits: status.verifiedUnits,
        verifiedAvgCost: status.verifiedAvgCost,
      });
      if (suggestion) map.set(ticker, suggestion);
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, addedKeys, skippedKeys, dismissedKeys, existingTradesByTicker]);

  /**
   * The one case where alreadyFullyRecorded's "discard all pending" is the
   * WRONG direction: the ticker's recorded shares are opening-balance
   * placeholder lots (no real dates — see the retired Record-as-opening-
   * balance flow) and this batch carries the ticker's REAL dated
   * transactions adding up to the same broker-verified total. Discarding
   * the pending rows would keep the dateless placeholder and throw away the
   * real data — the right move is the exact opposite: delete the
   * placeholder lots and let the real rows verify and confirm. Only offered
   * for the clean swap (every existing share is a deletable placeholder AND
   * the pending rows alone reconcile with the broker), so the replacement
   * can never half-apply.
   */
  const placeholderReplacements = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [ticker] of tickerGroups) {
      const status = tickerMatchStatuses.get(ticker);
      if (!status || status.reason !== "mismatch" || !status.alreadyFullyRecorded || status.verifiedUnits === undefined) continue;
      const pendingNet = status.netShares - (status.existingRemainingShares ?? 0);
      if (Math.abs(pendingNet - status.verifiedUnits) >= 1e-6) continue;
      const existingOpen = (existingTradesByTicker.get(ticker) ?? []).filter((t) => t.remainingShares > 0);
      if (existingOpen.length === 0) continue;
      const allDeletablePlaceholders = existingOpen.every(
        (t) => t.notes?.startsWith("Opening balance") && t.remainingShares === t.shares,
      );
      if (allDeletablePlaceholders) map.set(ticker, existingOpen.map((t) => t.id));
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, existingTradesByTicker]);

  const [replacingPlaceholderFor, setReplacingPlaceholderFor] = useState<string | null>(null);
  async function replacePlaceholderLots(ticker: string, tradeIds: string[]) {
    setReplacingPlaceholderFor(ticker);
    try {
      for (const id of tradeIds) {
        await deleteTrade(repos, id);
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Failed to delete the placeholder lot.");
    } finally {
      setReplacingPlaceholderFor(null);
    }
  }

  /**
   * A ticker resolved from an unmapped company name (see ThndrParser's
   * header fallback) can still land on the wrong 4-letter guess, or the same
   * real stock can OCR to a different guess on a different upload — the
   * exact failure mode reported against this page. Rather than requiring a
   * manual rename for every one of these, this flags it automatically
   * whenever it can be verified mechanically: two ticker groups whose buy/sell
   * rows are byte-for-byte identical (same side/shares/price/date) are, for
   * all practical purposes, the same upload read under two different guessed
   * tickers. Only ever a suggestion — nothing merges without the user's
   * click, and a coincidental exact match is vanishingly unlikely for real
   * trade data.
   */
  const mergeSuggestions = useMemo(() => {
    const signature = (group: (typeof tickerGroups)[number][1]): string =>
      [...group.buys, ...group.sells]
        .map((e) => `${e.candidate.side}|${e.candidate.shares}|${e.candidate.price}|${e.candidate.date}`)
        .sort()
        .join(";");
    const allLowConfidence = (group: (typeof tickerGroups)[number][1]): boolean =>
      [...group.buys, ...group.sells].every((e) => e.candidate.confidence === "low");

    const bySignature = new Map<string, string[]>();
    for (const [ticker, group] of tickerGroups) {
      const sig = signature(group);
      if (!sig) continue;
      const list = bySignature.get(sig) ?? [];
      list.push(ticker);
      bySignature.set(sig, list);
    }

    const suggestions = new Map<string, string>();
    for (const [ticker, group] of tickerGroups) {
      if (!allLowConfidence(group)) continue;
      const sig = signature(group);
      if (!sig) continue;
      const siblings = (bySignature.get(sig) ?? []).filter((t) => t !== ticker);
      if (siblings.length === 0) continue;
      const preferred =
        siblings.find((t) => {
          const siblingGroup = tickerGroups.find(([tk]) => tk === t)?.[1];
          return siblingGroup && !allLowConfidence(siblingGroup);
        }) ?? siblings[0];
      suggestions.set(ticker, preferred);
    }
    return suggestions;
  }, [tickerGroups]);

  const totalPending = pendingCandidates.length + pendingVerifications.length + pendingDividends.length;

  const currentYear = new Date().getFullYear();
  const startYearOptions = useMemo(() => {
    const years: number[] = [];
    for (let y = currentYear; y >= 2020; y--) years.push(y);
    return years;
  }, [currentYear]);

  return (
    <div>
      <PageHeader
        title={t("importPage.title")}
        description={t("importPage.description")}
        actions={
          <button
            onClick={() => {
              if (confirm(t("importPage.clearAllConfirm"))) {
                void clearAll();
              }
            }}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <RotateCcw size={14} /> {t("importPage.clearAll")}
          </button>
        }
      />

      {portfolios.length === 0 ? (
        <EmptyState
          title={t("importPage.createPortfolioFirstTitle")}
          description={t("importPage.createPortfolioFirstDescription")}
          action={
            <Link href="/portfolios" className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              {t("importPage.createPortfolio")}
            </Link>
          }
        />
      ) : null}

      <ImportUploadPanel
        trackingStartDate={trackingStartDate}
        startYearOptions={startYearOptions}
        onStartYearChange={(year) => trackingStartDateStore.set(`${year}-01-01`)}
        dragOver={dragOver}
        onDragOver={() => setDragOver(true)}
        onDragLeave={() => setDragOver(false)}
        onDropFiles={(files) => void processFiles(files)}
        onChooseFiles={(files) => void processFiles(files)}
        queueProgress={queueProgress}
        stage={stage}
        errorMessage={errorMessage}
        recentFileResults={recentFileResults}
        totalPending={totalPending}
        pendingOrderEvidenceCount={pendingOrderEvidences.length}
        filesProcessed={filesProcessed}
      />

      {reviewDataSettled && tickerGroups.length > 0 ? (
        <div className="mt-4 space-y-4">
          <ImportReviewSummaryBar
            activeTickerCount={activeTickerGroups.length}
            allTickersMatched={allTickersMatched}
            matchedTickerCount={matchedTickerCount}
            unmatchedTickerCount={unmatchedTickerCount}
            pendingDuplicateCandidateCount={pendingDuplicateCandidateKeys.length}
            onClearSuspectedDuplicates={clearPendingDuplicateCandidates}
            distributing={distributing}
            confirmDisabled={matchedTickerCount === 0 || distributing || !initialDataLoaded}
            onConfirmAndDistributeAll={() => void confirmAndDistributeAll()}
          />

          <CompletedTickersPanel
            groups={completedTickerGroups}
            expanded={completedExpanded}
            onToggleExpanded={() => setCompletedExpanded((v) => !v)}
            transactionCounts={completedTickerTransactionCounts}
            onResetTicker={(ticker) => void resetTickerData(ticker)}
          />

          <div className="performance-list contents">
          {activeTickerGroups.map(([ticker, group]) => {
            const existingIds = existingPortfoliosByTicker.get(ticker);
            const existingNames = existingIds ? [...existingIds].map((id) => portfolios.find((p) => p.id === id)?.name ?? "?") : [];
            return (
              <TickerGroupCard
                key={ticker}
                ticker={ticker}
                group={group}
                portfolios={portfolios}
                portfolioId={resolvedPortfolioId(ticker) ?? ""}
                portfolioResolved={resolvedPortfolioId(ticker) !== undefined}
                matchStatus={tickerMatchStatuses.get(ticker)}
                distributing={distributing}
                onPortfolioChange={(portfolioId) => setTickerPortfolio(ticker, portfolioId)}
                addedKeys={addedKeys}
                acceptedKeys={acceptedKeys}
                skippedKeys={skippedKeys}
                dismissedKeys={dismissedKeys}
                rowErrors={rowErrors}
                duplicateMatch={duplicateMatch}
                addedTradeIds={session.addedTradeIds}
                addedAllocationIds={session.addedAllocationIds}
                suspectedDuplicateKeys={pendingDuplicateCandidateKeySet}
                crossVerifiedKeys={crossVerifiedKeys}
                aggregateConfirmedKeys={aggregateConfirmedKeys}
                aggregateGroupDetailByKey={aggregateGroupDetailByKey}
                orderConfirmedKeys={orderConfirmedKeys}
                onDiscardOrderEvidence={(entry) => discardOrderEvidence(entry.key)}
                wrongTickerHints={wrongTickerHints}
                dateMisreadHints={dateMisreadHints}
                reconcileSuggestion={reconcileSuggestions.get(ticker)}
                placeholderReplacement={placeholderReplacements.has(ticker)}
                replacingPlaceholder={replacingPlaceholderFor === ticker}
                onReplacePlaceholder={() => void replacePlaceholderLots(ticker, placeholderReplacements.get(ticker) ?? [])}
                onDeleteAutoAdded={(entry) => void deleteAutoAddedTrade(entry)}
                onDiscardPending={(entry) => discardPendingCandidate(entry.key)}
                onDiscardPendingKeys={discardPendingCandidateKeys}
                onDiscardAllPending={() => discardAllPendingForTicker(ticker)}
                onConfirmTicker={() => void confirmTicker(ticker)}
                onAllocateSell={(entry) => void allocateOrPendSell(entry, ticker)}
                onSmartAllocate={(entry) => smartAllocateSell(entry, ticker)}
                onRenameTicker={(newTicker) => void renameTickerGroup(ticker, newTicker)}
                onRestoreTicker={() => restoreTickerCandidates(ticker)}
                onResetTicker={() => void resetTickerData(ticker)}
                orphanedOrderEvidence={orphanedEvidenceByTicker.get(ticker)}
                existingPortfolioHint={
                  existingNames.length > 0 ? { multiple: existingNames.length > 1, names: existingNames } : undefined
                }
                mergeSuggestion={mergeSuggestions.get(ticker)}
                knownTickerSuggestion={tickerForCompanyNameFallback(ticker)}
                existingTradesForTicker={existingTradesByTicker.get(ticker) ?? []}
                onDeleteExistingTrade={(tradeId) => void deleteExistingTrade(tradeId)}
              />
            );
          })}
          </div>
        </div>
      ) : null}

      <Modal
        title={t("importPage.allocateSellModalTitle", { tickerSuffix: sellCandidate ? t("importPage.allocateSellTickerSuffix", { ticker: sellCandidate.ticker }) : "" })}
        open={sellCandidate !== null}
        onClose={() => setSellCandidate(null)}
        widthClassName="max-w-2xl"
      >
        {sellCandidate ? (
          <SellAllocationForm
            portfolioId={sellCandidate.portfolioId}
            ticker={sellCandidate.ticker}
            initial={{
              exitPrice: sellCandidate.candidate.price,
              fees: sellCandidate.candidate.fees ?? 0,
              taxes: sellCandidate.candidate.taxes ?? 0,
              executionDate: sellCandidate.candidate.date,
              executionTime: sellCandidate.candidate.time,
              transactionNumber: sellCandidate.candidate.transactionNumber,
              source: sellCandidate.candidate.source,
            }}
            onDone={(created) => {
              importSession.update((prev) => ({
                ...prev,
                addedKeys: [...prev.addedKeys, sellCandidate.key],
                addedAllocationIds: created?.allocationIds.length
                  ? { ...prev.addedAllocationIds, [sellCandidate.key]: created.allocationIds }
                  : prev.addedAllocationIds,
              }));
              setSellCandidate(null);
            }}
            onCancel={() => setSellCandidate(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

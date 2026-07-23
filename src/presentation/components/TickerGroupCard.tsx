import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { diagnostics } from "@presentation/lib/data";
import type { TickerMatchStatus } from "@application/services/importVerification";
import { MAX_RECONCILE_ROWS, type ReconcileSuggestion } from "@application/services/mismatchResolver";
import { findLastBalancedDate } from "@application/services/netShareTimeline";
import { buildTickerConstraintReport } from "@application/services/constraintValidation";
import { assessTickerCompleteness, type TickerCompletenessReport } from "@application/services/completenessEngine";
import type { TickerStatus } from "@application/services/verificationEngine";
import type { ParsedTradeCandidate, ParsedOrderEvidence } from "@domain/entities/Upload";
import type { Trade } from "@domain/entities/Trade";
import type { CandidateEntry, VerificationEntry, DividendEntry, OrderEvidenceEntry } from "@presentation/lib/importSession";
import { formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";
import { ConstraintReportPanel, RecoveryPlanPanel } from "@presentation/components/ImportReviewPanels";
import { TickerEvidenceRows } from "@presentation/components/TickerEvidenceRows";
import { RecordedTradesPanel } from "@presentation/components/RecordedTradesPanel";
import { TickerGroupHeader } from "@presentation/components/TickerGroupHeader";
import { TickerSuggestionBanners } from "@presentation/components/TickerSuggestionBanners";
import { TickerResolutionBanners } from "@presentation/components/TickerResolutionBanners";
import { TickerBuyRows } from "@presentation/components/TickerBuyRows";
import { TickerSellRows } from "@presentation/components/TickerSellRows";

export function TickerGroupCard({
  ticker,
  group,
  portfolios,
  portfolioId,
  portfolioResolved,
  matchStatus,
  distributing,
  onPortfolioChange,
  addedKeys,
  acceptedKeys,
  skippedKeys,
  dismissedKeys,
  rowErrors,
  duplicateMatch,
  addedTradeIds,
  addedAllocationIds,
  suspectedDuplicateKeys,
  crossVerifiedKeys,
  aggregateConfirmedKeys,
  aggregateGroupDetailByKey,
  orderConfirmedKeys,
  onDiscardOrderEvidence,
  wrongTickerHints,
  dateMisreadHints,
  reconcileSuggestion,
  placeholderReplacement = false,
  replacingPlaceholder = false,
  onReplacePlaceholder,
  onDeleteAutoAdded,
  onDiscardPending,
  onDiscardPendingKeys,
  onDiscardAllPending,
  onConfirmTicker,
  onAllocateSell,
  onSmartAllocate,
  onRenameTicker,
  onRestoreTicker,
  onResetTicker,
  orphanedOrderEvidence,
  existingPortfolioHint,
  mergeSuggestion,
  knownTickerSuggestion,
  existingTradesForTicker,
  onDeleteExistingTrade,
}: {
  ticker: string;
  group: {
    buys: CandidateEntry[];
    sells: CandidateEntry[];
    verifications: VerificationEntry[];
    dividends: DividendEntry[];
    orderEvidences?: OrderEvidenceEntry[];
  };
  portfolios: { id: string; name: string }[];
  portfolioId: string;
  /** False while the ticker's portfolio is still ambiguous (a brand-new ticker with more than one portfolio open) — commit waits on the user picking one below. */
  portfolioResolved: boolean;
  /** The verification gate's result for this ticker — nothing here commits until this is matched. */
  matchStatus: TickerMatchStatus | undefined;
  /** True while confirmAndDistributeAll is actively committing this batch — drives the row-level "Adding…" spinner. */
  distributing: boolean;
  onPortfolioChange: (portfolioId: string) => void;
  addedKeys: Set<string>;
  acceptedKeys: Set<string>;
  skippedKeys: Set<string>;
  dismissedKeys: Set<string>;
  rowErrors: Record<string, string>;
  duplicateMatch: (
    candidate: ParsedTradeCandidate,
    ownTradeId?: string,
    ownAllocationIds?: string[],
  ) => { matchType: "exact" | "possible"; matchedId: string } | undefined;
  /** Entry key -> the real Trade.id an added Buy became — excludes a row's own committed trade from its duplicateMatch check so a successful commit never shows a false "Duplicate" badge against itself. */
  addedTradeIds: Record<string, string>;
  /** Sell entry key -> the TradeAllocation ids its "Allocate Sell" created — the Sell-side twin of addedTradeIds for the same self-duplicate exclusion. */
  addedAllocationIds?: Record<string, string[]>;
  /** Keys of pending (not yet added/skipped/dismissed) candidates suggested for discard — either a duplicate of a sibling in this same batch, or of a trade already committed to the ledger. See ImportPage's pendingDuplicateCandidateKeys. */
  suspectedDuplicateKeys: Set<string>;
  /** Keys of pending rows whose transaction was read from two different document types (see findCrossSourceVerifiedKeys) — drives the "Two documents agree" badge. */
  crossVerifiedKeys?: Set<string>;
  /** Keys of pending rows confirmed as part of a Statement aggregate (see findAggregateStatementMatches) — drives the "Confirmed by Statement" badge. */
  aggregateConfirmedKeys?: Set<string>;
  /** Entry key -> a formatted breakdown ("BUY 5,000 sh + BUY 3,000 sh") of the execution group a Statement row aggregated it with — the "Confirmed by Statement" badge's tooltip detail. */
  aggregateGroupDetailByKey?: Map<string, string>;
  /** Keys of pending rows corroborated by a fulfilled order on the broker's Orders timeline screenshot (see findOrderConfirmedKeys) — drives the "Matches Orders history" badge, and its absence the "No matching order" hint on a mismatch. */
  orderConfirmedKeys?: Set<string>;
  /** Discards one misread order-evidence row (see ImportPage's discardOrderEvidence). */
  onDiscardOrderEvidence?: (entry: OrderEvidenceEntry) => void;
  /** Pending key -> the ticker a phantom wrong-ticker read most likely belongs to (see findWrongTickerCandidateKeys) — drives the "likely {other}'s transaction" badge. */
  wrongTickerHints?: Map<string, string>;
  /** Pending key -> the date (already on the ledger) this row's date was most likely misread from (see findDateMisreadDuplicateHints) — drives an advisory "possible duplicate, misread date" badge. Never auto-discards anything. */
  dateMisreadHints?: Map<string, string>;
  /** The mismatch auto-reconcile solver's suggested removal for this ticker, when one exists (see suggestRemovalsToReconcile) — drives the banner's one-click fix and the per-row highlight. */
  reconcileSuggestion?: ReconcileSuggestion;
  /** True when this ticker's recorded shares are all deletable opening-balance placeholders and this batch's rows alone reconcile with the broker — flips the alreadyFullyRecorded banner from "discard pending" to "replace the placeholder" (see ImportPage's placeholderReplacements). */
  placeholderReplacement?: boolean;
  /** True while the placeholder lots are being deleted. */
  replacingPlaceholder?: boolean;
  onReplacePlaceholder?: () => void;
  onDeleteAutoAdded: (entry: CandidateEntry) => void;
  onDiscardPending: (entry: CandidateEntry) => void;
  /** Discards a named set of still-pending rows in one shot — the reconcile suggestion's "Remove suggested rows" action. */
  onDiscardPendingKeys?: (keys: string[]) => void;
  /** Discards every still-pending Buy/Sell for this ticker in one shot — only surfaced when matchStatus.alreadyFullyRecorded is true (see checkTickerMatch). */
  onDiscardAllPending: () => void;
  /** Confirms and distributes just this ticker, independent of any other ticker in the batch still stuck — see ImportPage's confirmTicker. */
  onConfirmTicker: () => void;
  onAllocateSell: (entry: CandidateEntry) => void;
  /** Silently allocates a sell against its ticker's open lots in strict FIFO order through the same recordSell engine as onAllocateSell's manual dialog — the "Smart Allocate" button's handler. Returns its promise so the row can disable itself until the allocation finishes. Optional so call sites that construct CandidateRow/TickerGroupCard directly (tests) don't need to wire it — the button simply doesn't render without it. */
  onSmartAllocate?: (entry: CandidateEntry) => Promise<void>;
  onRenameTicker: (newTicker: string) => void;
  /** Restores all dismissed/skipped/discarded Buy/Sell rows for this ticker back to pending state. */
  onRestoreTicker?: () => void;
  /** Permanently erases everything recorded for this ticker (ledger + session) so it can be re-imported from scratch — see ImportPage's resetTickerData. */
  onResetTicker?: () => void;
  /** Fulfilled order-evidence rows for this ticker that had no matching pending candidate — signals unrecorded historical trades. */
  orphanedOrderEvidence?: ParsedOrderEvidence[];
  existingPortfolioHint: { multiple: boolean; names: string[] } | undefined;
  mergeSuggestion: string | undefined;
  /** The real EGX symbol this group's company-name-fallback "ticker" maps to (see tickerForCompanyNameFallback) — drives the one-click rename banner. */
  knownTickerSuggestion?: string;
  /**
   * Every real, already-committed Trade for this ticker (any portfolio) —
   * drives the "Recorded on the ledger" panel shown on a blocked ticker,
   * letting a duplicate/misread buy be found and deleted right here instead
   * of on the Trades page. Distinct from addedTradeIds, which only covers
   * trades this Import session itself just created.
   */
  existingTradesForTicker?: Trade[];
  /** Deletes one already-recorded trade directly from this panel (see ImportPage's deleteExistingTrade). Guarded server-side the same way the Trades page's own delete is — refused if any shares were already closed against it. */
  onDeleteExistingTrade?: (tradeId: string) => void;
}) {
  const t = useT();
  const matched = matchStatus?.matched ?? false;
  const [renaming, setRenaming] = useState(false);
  const [draftTicker, setDraftTicker] = useState(ticker);
  const orderEvidences = group.orderEvidences ?? [];
  // An evidence-only group (Orders-history rows and nothing else) is
  // trivially matched but has nothing to distribute — a Confirm button on it
  // would be a no-op pretending to be an action.
  const hasCommittable =
    group.buys.length + group.sells.length + group.verifications.length + group.dividends.length > 0;
  // "No matching order" is only a meaningful signal when the broker's order
  // history for this ticker was actually uploaded AND the ticker isn't
  // already matched — an absent screenshot proves nothing about any row.
  // Covers both "mismatch" (a broker position screenshot disagrees) and
  // "no-verification" (no screenshot at all, e.g. a fully closed position
  // with no "My Position" screen to ever upload) — either way, a row this
  // ticker's own uploaded order history doesn't corroborate is the likely
  // place a missing/misread/duplicate transaction is hiding, and unlike a
  // combinatorial "which subset reconciles" solver this scales to any
  // number of pending rows.
  const tickerHasFulfilledOrders = orderEvidences.some((e) => e.evidence.status === "fulfilled");
  // How many rows the mismatch subset-solver could actually consider — the
  // "no combination explains it" wording is only honest at or below the
  // solver's exhaustive-search cap (see MAX_RECONCILE_ROWS).
  const stillPendingCount = [...group.buys, ...group.sells].filter(
    (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
  ).length;
  const highlightUnmatchedByOrders =
    tickerHasFulfilledOrders && (matchStatus?.reason === "mismatch" || matchStatus?.reason === "no-verification");
  /**
   * A "no-verification" ticker's gap is almost always confined to a
   * specific stretch of dates, not spread evenly across the whole history
   * (see findLastBalancedDate) — narrows "which transaction is wrong"
   * beyond just badging every unconfirmed row, deterministically and
   * without a combinatorial search.
   */
  const lastBalanced = useMemo(() => {
    if (matchStatus?.matched) return undefined;
    const stillPendingRows = [...group.buys, ...group.sells].filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findLastBalancedDate({
      rows: stillPendingRows.map((e) => ({ key: e.key, side: e.candidate.side, shares: e.candidate.shares, date: e.candidate.date })),
      existingRemainingShares: matchStatus?.existingRemainingShares ?? 0,
    });
  }, [group.buys, group.sells, matchStatus, addedKeys, skippedKeys, dismissedKeys]);
  // Only meaningful for the "no-verification" shortfall banner below — a
  // pending Sell total that exceeds existing-ledger + pending-Buy shares
  // means the ledger is missing Buy history, not missing a screenshot. Read
  // directly off matchStatus (checkTickerMatch's own echoed inputs) rather
  // than re-deriving from group.buys/group.sells here — the single
  // canonical figure the match/mismatch decision was actually computed
  // against, so this display can never again silently drift from the
  // engine's own numbers the way it once did (see importVerification.ts).
  const pendingSellShares = matchStatus?.pendingSellShares ?? 0;
  const pendingBuyShares = matchStatus?.pendingBuyShares ?? 0;
  /**
   * Signed net effect of the still-pending rows flagged "Duplicate"
   * (+buys, -sells). Rows keep counting toward netShares until the user
   * discards them — the system deliberately never auto-deletes — so a
   * position that looks fully closed can still show a non-zero net purely
   * because of flagged duplicates. Surfacing "discarding them brings the
   * net to X" turns that from a mystery into one obvious action.
   */
  const duplicateFlaggedNet = useMemo(() => {
    const stillPending = (e: { key: string }) =>
      !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key) && suspectedDuplicateKeys.has(e.key);
    return (
      group.buys.filter(stillPending).reduce((sum, e) => sum + e.candidate.shares, 0) -
      group.sells.filter(stillPending).reduce((sum, e) => sum + e.candidate.shares, 0)
    );
  }, [group.buys, group.sells, addedKeys, skippedKeys, dismissedKeys, suspectedDuplicateKeys]);
  const netAfterDiscardingDuplicates = (matchStatus?.netShares ?? 0) - duplicateFlaggedNet;

  /**
   * Constraint Validation Layer: consumes checkTickerMatch's own already-
   * computed output (matchStatus) plus the other diagnosis signals this card
   * already has in scope (reconcileSuggestion, lastBalanced,
   * wrongTickerHints/dateMisreadHints, orphanedOrderEvidence) — recomputes
   * nothing. See constraintValidation.ts: facts first, objective
   * contradiction second, diagnosis only ever after that.
   */
  const constraintReport = useMemo(() => {
    if (!matchStatus || group.buys.length + group.sells.length === 0) return undefined;
    const stillPendingRows = [...group.buys, ...group.sells].filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return buildTickerConstraintReport(
      ticker,
      matchStatus,
      {
        reconcileSuggestion,
        lastBalancedDate: lastBalanced,
        wrongTickerHintCount: stillPendingRows.filter((e) => wrongTickerHints?.has(e.key)).length,
        dateMisreadHintCount: stillPendingRows.filter((e) => dateMisreadHints?.has(e.key)).length,
        orphanedOrderEvidenceCount: orphanedOrderEvidence?.length ?? 0,
        discrepancySide: matchStatus.discrepancySide,
      },
      diagnostics,
    );
  }, [
    ticker,
    matchStatus,
    group.buys,
    group.sells,
    addedKeys,
    skippedKeys,
    dismissedKeys,
    reconcileSuggestion,
    lastBalanced,
    wrongTickerHints,
    dateMisreadHints,
    orphanedOrderEvidence,
  ]);

  /**
   * Evidence Resolution's minimal-document recommendation (completenessEngine.ts)
   * for a still-unmatched ticker — reuses the exact same engine the
   * RawTransaction-based path already uses, fed from this card's own
   * already-computed signals (matchStatus, orphanedOrderEvidence,
   * lastBalanced) rather than a second, parallel implementation. Only
   * meaningful once unmatched — a matched ticker has nothing to recover.
   */
  const completenessReport = useMemo((): TickerCompletenessReport | undefined => {
    if (!matchStatus || matchStatus.matched || group.buys.length + group.sells.length === 0) return undefined;
    const status: TickerStatus = {
      ...matchStatus,
      ticker,
      orphanedOrderEvidence: orphanedOrderEvidence ?? [],
      wrongTickerHintCount: 0,
      dateMisreadHintCount: 0,
      lastBalancedDate: lastBalanced,
    };
    return assessTickerCompleteness(status);
  }, [matchStatus, group.buys, group.sells, ticker, orphanedOrderEvidence, lastBalanced]);

  function confirmRename() {
    onRenameTicker(draftTicker);
    setRenaming(false);
  }

  function cancelRename() {
    setDraftTicker(ticker);
    setRenaming(false);
  }

  function beginRename() {
    setDraftTicker(ticker);
    setRenaming(true);
  }

  return (
    <div
      className="rounded-xl border border-slate-800 bg-slate-900/60"
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 520px" }}
    >
      <TickerSuggestionBanners
        ticker={ticker}
        mergeSuggestion={mergeSuggestion}
        knownTickerSuggestion={knownTickerSuggestion}
        existingPortfolioHint={existingPortfolioHint}
        error={rowErrors[ticker]}
        onRenameTicker={onRenameTicker}
      />
      <TickerGroupHeader
        ticker={ticker}
        renaming={renaming}
        draftTicker={draftTicker}
        portfolios={portfolios}
        portfolioId={portfolioId}
        portfolioResolved={portfolioResolved}
        matchStatus={matchStatus}
        canConfirm={matched && portfolioResolved && hasCommittable}
        distributing={distributing}
        canReset={Boolean(onResetTicker)}
        onDraftTickerChange={setDraftTicker}
        onBeginRename={beginRename}
        onConfirmRename={confirmRename}
        onCancelRename={cancelRename}
        onRestoreTicker={onRestoreTicker}
        onResetTicker={onResetTicker}
        onPortfolioChange={onPortfolioChange}
        onConfirmTicker={onConfirmTicker}
      />
      {constraintReport ? <ConstraintReportPanel report={constraintReport} t={t} /> : null}
      {completenessReport?.recoveryPlan ? <RecoveryPlanPanel report={completenessReport} t={t} /> : null}
      {matchStatus?.reason === "matched" && (matchStatus.existingRemainingShares ?? 0) > 0 ? (
        <div className="border-b border-slate-800 bg-emerald-500/5 px-4 py-2 text-xs text-slate-400">
          {t("importPage.matchesBrokerBanner", {
            onLedger: formatShares(matchStatus.existingRemainingShares!),
            batch: formatShares(matchStatus.netShares - matchStatus.existingRemainingShares!),
            total: formatShares(matchStatus.verifiedUnits ?? matchStatus.netShares),
          })}
        </div>
      ) : null}
      {orphanedOrderEvidence && orphanedOrderEvidence.length > 0 && matchStatus?.reason === "matched" ? (
        <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          {t("importPage.orphanedEvidenceBanner", { n: orphanedOrderEvidence.length })}
        </div>
      ) : null}
      <TickerResolutionBanners
        ticker={ticker}
        matchStatus={matchStatus}
        pendingBuyShares={pendingBuyShares}
        pendingSellShares={pendingSellShares}
        hasFulfilledOrders={tickerHasFulfilledOrders}
        duplicateFlaggedNet={duplicateFlaggedNet}
        netAfterDiscardingDuplicates={netAfterDiscardingDuplicates}
        lastBalancedDate={lastBalanced?.date}
        placeholderReplacement={placeholderReplacement}
        replacingPlaceholder={replacingPlaceholder}
        reconcileSuggestion={reconcileSuggestion}
        reconcileSearchExhaustive={stillPendingCount <= MAX_RECONCILE_ROWS}
        portfolioResolved={portfolioResolved}
        onReplacePlaceholder={onReplacePlaceholder}
        onDiscardAllPending={onDiscardAllPending}
        onDiscardPendingKeys={onDiscardPendingKeys}
      />
      {!matched && (existingTradesForTicker?.length ?? 0) > 0 ? (
        <RecordedTradesPanel
          trades={existingTradesForTicker!.map((trade) => ({
            id: trade.id,
            shares: trade.shares,
            entryPrice: trade.entryPrice,
            executionDate: trade.executionDate,
            deletable: trade.remainingShares === trade.shares,
          }))}
          rowErrors={rowErrors}
          onDelete={onDeleteExistingTrade}
        />
      ) : null}
      <div className="divide-y divide-slate-800">
        <TickerBuyRows
          buys={group.buys}
          skippedKeys={skippedKeys}
          addedKeys={addedKeys}
          dismissedKeys={dismissedKeys}
          portfolioResolved={portfolioResolved}
          matched={matched}
          distributing={distributing}
          rowErrors={rowErrors}
          duplicateMatch={duplicateMatch}
          addedTradeIds={addedTradeIds}
          suspectedDuplicateKeys={suspectedDuplicateKeys}
          reconcileSuggestion={reconcileSuggestion}
          wrongTickerHints={wrongTickerHints}
          dateMisreadHints={dateMisreadHints}
          crossVerifiedKeys={crossVerifiedKeys}
          aggregateConfirmedKeys={aggregateConfirmedKeys}
          aggregateGroupDetailByKey={aggregateGroupDetailByKey}
          orderConfirmedKeys={orderConfirmedKeys}
          highlightUnmatchedByOrders={highlightUnmatchedByOrders}
          onDeleteAutoAdded={onDeleteAutoAdded}
          onDiscardPending={onDiscardPending}
        />
        <TickerSellRows
          sells={group.sells}
          skippedKeys={skippedKeys}
          addedKeys={addedKeys}
          matched={matched}
          portfolioResolved={portfolioResolved}
          rowErrors={rowErrors}
          duplicateMatch={duplicateMatch}
          addedAllocationIds={addedAllocationIds}
          suspectedDuplicateKeys={suspectedDuplicateKeys}
          reconcileSuggestion={reconcileSuggestion}
          wrongTickerHints={wrongTickerHints}
          dateMisreadHints={dateMisreadHints}
          crossVerifiedKeys={crossVerifiedKeys}
          aggregateConfirmedKeys={aggregateConfirmedKeys}
          aggregateGroupDetailByKey={aggregateGroupDetailByKey}
          orderConfirmedKeys={orderConfirmedKeys}
          highlightUnmatchedByOrders={highlightUnmatchedByOrders}
          onAllocateSell={onAllocateSell}
          onSmartAllocate={onSmartAllocate}
          onDiscardPending={onDiscardPending}
        />
        {(() => {
          const skippedCount = [...group.buys, ...group.sells].filter((e) => skippedKeys.has(e.key)).length;
          return skippedCount > 0 ? (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-slate-500">
              <CheckCircle2 size={13} className="text-slate-500" />
              {t("importPage.duplicatesHidden", { count: skippedCount })}
            </div>
          ) : null;
        })()}
        <TickerEvidenceRows
          verifications={group.verifications}
          dividends={group.dividends}
          orderEvidences={orderEvidences}
          acceptedKeys={acceptedKeys}
          addedKeys={addedKeys}
          rowErrors={rowErrors}
          matched={matched}
          portfolioResolved={portfolioResolved}
          distributing={distributing}
          onDiscardOrderEvidence={onDiscardOrderEvidence}
          t={t}
        />
      </div>
    </div>
  );
}

import type { TickerMatchStatus } from "@application/services/importVerification";
import type { ReconcileSuggestion } from "@application/services/mismatchResolver";
import { useT } from "@presentation/i18n/translations";
import { formatDate, formatShares } from "@presentation/lib/format";

interface TickerResolutionBannersProps {
  ticker: string;
  matchStatus: TickerMatchStatus | undefined;
  pendingBuyShares: number;
  pendingSellShares: number;
  hasFulfilledOrders: boolean;
  duplicateFlaggedNet: number;
  netAfterDiscardingDuplicates: number;
  lastBalancedDate: string | undefined;
  placeholderReplacement: boolean;
  replacingPlaceholder: boolean;
  reconcileSuggestion: ReconcileSuggestion | undefined;
  reconcileSearchExhaustive: boolean;
  portfolioResolved: boolean;
  onReplacePlaceholder: (() => void) | undefined;
  onDiscardAllPending: (() => void) | undefined;
  onDiscardPendingKeys: ((keys: string[]) => void) | undefined;
}

export function TickerResolutionBanners({
  ticker,
  matchStatus,
  pendingBuyShares,
  pendingSellShares,
  hasFulfilledOrders,
  duplicateFlaggedNet,
  netAfterDiscardingDuplicates,
  lastBalancedDate,
  placeholderReplacement,
  replacingPlaceholder,
  reconcileSuggestion,
  reconcileSearchExhaustive,
  portfolioResolved,
  onReplacePlaceholder,
  onDiscardAllPending,
  onDiscardPendingKeys,
}: TickerResolutionBannersProps) {
  const t = useT();
  const lastBalancedHint = lastBalancedDate ? (
    <p className="mt-1.5 text-cyan-300">{t("importPage.lastBalancedHint", { date: formatDate(lastBalancedDate) })}</p>
  ) : null;

  if (matchStatus?.reason === "no-verification" && matchStatus.netShares < -1e-6) {
    return (
      <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
        {t("importPage.missingBuyHistoryBanner", {
          ticker,
          pendingSellShares: formatShares(pendingSellShares),
          existing: formatShares(matchStatus.existingRemainingShares ?? 0),
          pendingBuy: formatShares(pendingBuyShares),
          available: formatShares((matchStatus.existingRemainingShares ?? 0) + pendingBuyShares),
          short: formatShares(-matchStatus.netShares),
        })}
      </div>
    );
  }

  if (matchStatus?.reason === "no-verification") {
    return (
      <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
        <p>
          {t("importPage.needsScreenshotBanner", {
            ticker,
            netShares: formatShares(matchStatus.netShares),
            suffix: hasFulfilledOrders
              ? t("importPage.needsScreenshotSuffixHasOrders")
              : t("importPage.needsScreenshotSuffixNoOrders"),
          })}
        </p>
        {Math.abs(matchStatus.existingRemainingShares ?? 0) > 1e-6 ? (
          <p className="mt-1.5">
            {t("importPage.netBreakdownHint", {
              existing: formatShares(matchStatus.existingRemainingShares ?? 0),
              pendingBuy: formatShares(pendingBuyShares),
              pendingSell: formatShares(pendingSellShares),
              net: formatShares(matchStatus.netShares),
            })}
          </p>
        ) : null}
        {matchStatus.discrepancySide ? (
          <p className="mt-1.5 font-medium">
            {"⚠ "}
            {matchStatus.discrepancySide === "buy" && pendingBuyShares < 1e-6
              ? t("importPage.discrepancySideLedgerBuy", { ticker, net: formatShares(matchStatus.netShares) })
              : matchStatus.discrepancySide === "buy"
                ? t("importPage.discrepancySideBuy")
                : t("importPage.discrepancySideSell")}
          </p>
        ) : null}
        {Math.abs(duplicateFlaggedNet) > 1e-6 ? (
          <p className="mt-1.5 text-cyan-300">
            {Math.abs(netAfterDiscardingDuplicates) < 1e-6
              ? t("importPage.duplicateDiscardHintZero", { dupNet: formatShares(duplicateFlaggedNet) })
              : t("importPage.duplicateDiscardHint", {
                  dupNet: formatShares(duplicateFlaggedNet),
                  after: formatShares(netAfterDiscardingDuplicates),
                })}
          </p>
        ) : null}
        {lastBalancedHint}
      </div>
    );
  }

  if (matchStatus?.reason === "mismatch" && matchStatus.alreadyFullyRecorded && placeholderReplacement) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-300">
        <span>{t("importPage.placeholderReplaceBanner", { ticker, verified: formatShares(matchStatus.verifiedUnits!) })}</span>
        <button onClick={onReplacePlaceholder} disabled={replacingPlaceholder}
          className="shrink-0 rounded-md border border-cyan-400/40 px-2.5 py-1 font-medium text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50">
          {replacingPlaceholder ? t("importPage.replacing") : t("importPage.replacePlaceholder")}
        </button>
      </div>
    );
  }

  if (matchStatus?.reason === "mismatch" && matchStatus.alreadyFullyRecorded) {
    return (
      <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("importPage.alreadyFullyRecordedBanner", {
            ticker,
            extra: formatShares(matchStatus.netShares - matchStatus.verifiedUnits!),
          })}</span>
          <button onClick={onDiscardAllPending}
            className="shrink-0 rounded-md border border-rose-400/40 px-2.5 py-1 font-medium text-rose-300 hover:bg-rose-500/10">
            {t("importPage.discardAllPendingFor", { ticker })}
          </button>
        </div>
        {lastBalancedHint}
      </div>
    );
  }

  if (matchStatus?.reason === "mismatch" && reconcileSuggestion) {
    return (
      <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("importPage.mismatchReconcileBanner", {
            existingSuffix: (matchStatus.existingRemainingShares ?? 0) > 0
              ? t("importPage.existingLedgerSuffix", { existing: formatShares(matchStatus.existingRemainingShares!) })
              : "",
            netShares: formatShares(matchStatus.netShares),
            verified: formatShares(matchStatus.verifiedUnits ?? 0),
            removeCount: reconcileSuggestion.keysToRemove.length,
            avgCostSuffix: reconcileSuggestion.rankedByAvgCost ? t("importPage.rankedByAvgCostSuffix") : "",
            alternativesSuffix: t("importPage.alternativesSuffix", { n: reconcileSuggestion.alternatives }),
          })}</span>
          <button onClick={() => onDiscardPendingKeys?.(reconcileSuggestion.keysToRemove)}
            className="shrink-0 rounded-md border border-rose-400/40 px-2.5 py-1 font-medium text-rose-300 hover:bg-rose-500/10">
            {t("importPage.removeSuggestedRows", { n: reconcileSuggestion.keysToRemove.length })}
          </button>
        </div>
        {lastBalancedHint}
      </div>
    );
  }

  if (matchStatus?.reason === "mismatch") {
    return (
      <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
        <p>{t("importPage.mismatchGenericBanner", {
          existingSuffix: (matchStatus.existingRemainingShares ?? 0) > 0
            ? t("importPage.existingLedgerSuffix", { existing: formatShares(matchStatus.existingRemainingShares!) })
            : "",
          netShares: formatShares(matchStatus.netShares),
          verified: formatShares(matchStatus.verifiedUnits ?? 0),
        })}</p>
        {matchStatus.discrepancySide ? (
          <p className="mt-1.5 font-medium">
            {"⚠ "}{matchStatus.discrepancySide === "buy" ? t("importPage.discrepancySideBuy") : t("importPage.discrepancySideSell")}
          </p>
        ) : null}
        {matchStatus.verifiedUnits !== undefined ? (
          <p className="mt-1.5 text-cyan-300">
            {t(reconcileSearchExhaustive ? "importPage.mismatchGapHint" : "importPage.mismatchGapHintLarge", {
              gap: formatShares(Math.abs(matchStatus.netShares - matchStatus.verifiedUnits)),
              direction: matchStatus.netShares > matchStatus.verifiedUnits
                ? t("importPage.mismatchGapTooMany")
                : t("importPage.mismatchGapTooFew"),
            })}
          </p>
        ) : null}
        {lastBalancedHint}
      </div>
    );
  }

  return !portfolioResolved ? (
    <div className="border-b border-slate-800 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-300">
      {t("importPage.newTickerAmbiguousBanner")}
    </div>
  ) : null;
}

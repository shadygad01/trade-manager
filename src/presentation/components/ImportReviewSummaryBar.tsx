import { Eraser, Loader2, ShieldCheck } from "lucide-react";
import { useT } from "@presentation/i18n/translations";

interface ImportReviewSummaryBarProps {
  activeTickerCount: number;
  allTickersMatched: boolean;
  matchedTickerCount: number;
  unmatchedTickerCount: number;
  pendingDuplicateCandidateCount: number;
  onClearSuspectedDuplicates: () => void;
  distributing: boolean;
  confirmDisabled: boolean;
  onConfirmAndDistributeAll: () => void;
}

/** Step 2's status line ("N of M matched") plus its two batch actions — clearing suspected duplicates and confirming/distributing every matched ticker. Which tickers count as matched/active and whether the confirm action is allowed are decided entirely by the parent. */
export function ImportReviewSummaryBar({
  activeTickerCount,
  allTickersMatched,
  matchedTickerCount,
  unmatchedTickerCount,
  pendingDuplicateCandidateCount,
  onClearSuspectedDuplicates,
  distributing,
  confirmDisabled,
  onConfirmAndDistributeAll,
}: ImportReviewSummaryBarProps) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">{t("importPage.step2Title")}</h3>
        <p className="mt-1 text-xs text-slate-400">
          {activeTickerCount === 0
            ? t("importPage.allDoneStatus")
            : allTickersMatched
              ? t("importPage.allMatchedStatus")
              : matchedTickerCount > 0
                ? t("importPage.someMatchedStatus", { matched: matchedTickerCount, total: activeTickerCount })
                : t("importPage.noneMatchedStatus", { unmatched: unmatchedTickerCount, total: activeTickerCount })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {pendingDuplicateCandidateCount > 0 ? (
          <button
            onClick={onClearSuspectedDuplicates}
            className="flex items-center gap-1.5 rounded-md border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-300 hover:bg-rose-500/10"
          >
            <Eraser size={14} />
            {t("importPage.clearSuspectedDuplicates", { n: pendingDuplicateCandidateCount })}
          </button>
        ) : null}
        {activeTickerCount > 0 ? (
          <button
            onClick={onConfirmAndDistributeAll}
            disabled={confirmDisabled}
            title={
              matchedTickerCount === 0
                ? t("importPage.noTickerVerified")
                : allTickersMatched
                  ? undefined
                  : t("importPage.confirmSubsetTitle", { matched: matchedTickerCount, total: activeTickerCount })
            }
            className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:hover:bg-slate-700"
          >
            {distributing ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {allTickersMatched ? t("importPage.confirmDistributeAll") : t("importPage.confirmAllVerified", { n: matchedTickerCount })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

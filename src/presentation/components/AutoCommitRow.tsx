import { CheckCircle2, History, Loader2, ShieldAlert, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { CandidateEntry } from "@presentation/lib/importSession";
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

/**
 * Buy rows commit as a batch once the user clicks "Confirm — Distribute to
 * Portfolios" (see ImportPage's confirmAndDistributeAll) — this only ever
 * shows status, never an action button. A "low" confidence row (an
 * unmapped-ticker guess, the tier most likely to be flat-out wrong) gets a
 * visually distinct amber-tinted treatment instead of the confirmation
 * checkbox this used to require, since there's no click left to gate — the
 * warning styling plus a one-click delete afterward is the replacement
 * safety net.
 */
export function AutoCommitRow({
  entry,
  match,
  added,
  skipped,
  dismissed,
  portfolioResolved,
  matched,
  distributing,
  error,
  suspectedDuplicate = false,
  suggestedRemoval = false,
  wrongTickerHint,
  dateMisreadHint,
  crossSourceVerified = false,
  aggregateConfirmed = false,
  aggregateMatchDetail,
  orderConfirmed = false,
  noMatchingOrder = false,
  onDelete,
  onDiscardPending,
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
  skipped: boolean;
  dismissed: boolean;
  portfolioResolved: boolean;
  /** Whether this row's ticker has reconciled against a broker position screenshot yet — nothing commits until it does. */
  matched: boolean;
  /** True while confirmAndDistributeAll is actively committing this row's batch. */
  distributing: boolean;
  error?: string;
  /** Flags a still-pending row as a suggested duplicate — of a sibling still pending in this batch, or of a trade already committed to the ledger (see ImportPage's pendingDuplicateCandidateKeys). Drives the "Discard" action regardless of which; the badge itself is only shown when `match` isn't already showing its own duplicate pill for the same row. */
  suspectedDuplicate?: boolean;
  /** True when the mismatch auto-reconcile solver picked this row for removal (see suggestRemovalsToReconcile) — highlights the row the banner's one-click fix would discard. */
  suggestedRemoval?: boolean;
  /** The ticker this row most likely belongs to, when it looks like a phantom wrong-ticker read of another ticker's transaction (see findWrongTickerCandidateKeys). */
  wrongTickerHint?: string;
  /** The ledger date this row's date was most likely misread from (see findDateMisreadDuplicateHints) — advisory only, never auto-discards. */
  dateMisreadHint?: string;
  /** True when this exact transaction was read from two different document types (statement + invoice, statement + orders screenshot, …) — the dual-source verification rule (see findCrossSourceVerifiedKeys). */
  crossSourceVerified?: boolean;
  /** True when this row is part of an execution group a Statement row's aggregate quantity confirmed (see findAggregateStatementMatches) — the Statement row itself never renders as a separate candidate once matched, so this row carries the confirmation instead. */
  aggregateConfirmed?: boolean;
  /** Formatted breakdown ("BUY 5,000 sh + BUY 3,000 sh") of the execution group this row belongs to — the aggregateConfirmed badge's tooltip detail. */
  aggregateMatchDetail?: string;
  /** True when a fulfilled order on the broker's Orders timeline screenshot corroborates this exact row (see findOrderConfirmedKeys). */
  orderConfirmed?: boolean;
  /** True on a mismatch when this ticker's Orders history was uploaded and no fulfilled order matches this row — the likely extra/wrong row behind the mismatch. */
  noMatchingOrder?: boolean;
  onDelete: () => void;
  /**
   * Discards this row from the pending pool outright — available on every
   * still-pending row, not just ones auto-flagged as a suspected duplicate.
   * A Mismatch banner's cause isn't always machine-detectable (see
   * checkTickerMatch's alreadyFullyRecorded and the sibling/existing-trade
   * duplicate checks — none catch every shape), so the user can manually
   * try removing whichever row they judge to be the wrong/extra one and see
   * if the ticker's total then reconciles against its broker screenshot.
   */
  onDiscardPending?: () => void;
}) {
  const t = useT();
  const c = entry.candidate;
  const isLowConfidence = c.confidence === "low";
  const stillPending = !added && !skipped && !dismissed;
  const canDiscard = suspectedDuplicate && stillPending;
  const flaggedForRemoval = stillPending && (suggestedRemoval || wrongTickerHint !== undefined);
  return (
    <div
      className={`px-4 py-2.5 text-sm ${canDiscard || flaggedForRemoval ? "bg-rose-500/5" : isLowConfidence ? "bg-amber-500/[0.04]" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
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

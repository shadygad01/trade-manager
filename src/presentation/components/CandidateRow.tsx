import { useState } from "react";
import { CheckCircle2, History, Loader2, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
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
 * Sell is the one row type Import never batch-commits (see ImportPage's
 * commitTickerGroup doc comment) — which lot(s) it closes is an explicit
 * financial decision (ADR-002), so "Allocate Sell" always opens the
 * allocation modal for the user to review and submit. Because that modal
 * is itself the review step, a low-confidence sell doesn't need a separate
 * confirmation gate the way a batch-committed buy did — it's flagged with
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
  /** True when this row was auto-resolved as an exact duplicate of an already-recorded transaction (see the exact-duplicate-sell auto-skip effect) — replaces the action button with a "Skipped — duplicate" state so nothing invites a double-count. */
  skipped?: boolean;
  actionLabel: string;
  actionClassName: string;
  onAction: () => void;
  /** Label/handler for the optional "Smart Allocate" action, shown immediately before the main action button — see ImportPage's smartAllocateSell. Omitted entirely (no button rendered) when the row has no smart-allocate handler. */
  smartActionLabel?: string;
  onSmartAction?: () => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  /** Flags a still-pending row as a suggested duplicate — of a sibling still pending in this batch, or of a trade already committed to the ledger (see ImportPage's pendingDuplicateCandidateKeys). Drives the "Discard" action regardless of which; the badge itself is only shown when `match` isn't already showing its own duplicate pill for the same row. */
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
  /** Set when onAction/onSmartAction threw (see ImportPage's rowErrors/setRowError) — previously silently swallowed for a Sell row (unlike AutoCommitRow's own twin prop), which made a failing Smart Allocate/Allocate Sell click look like a no-op with zero feedback. */
  error?: string;
  /** Discards this row from the pending pool outright — available on every still-pending row, not just ones auto-flagged as a suspected duplicate (see AutoCommitRow's onDiscardPending). */
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

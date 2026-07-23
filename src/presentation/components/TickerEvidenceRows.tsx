import { CheckCircle2, CircleDollarSign, History, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import type { DividendEntry, OrderEvidenceEntry, VerificationEntry } from "@presentation/lib/importSession";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import type { TFunction } from "@presentation/i18n/translations";

interface TickerEvidenceRowsProps {
  verifications: VerificationEntry[];
  dividends: DividendEntry[];
  orderEvidences: OrderEvidenceEntry[];
  acceptedKeys: Set<string>;
  addedKeys: Set<string>;
  rowErrors: Record<string, string>;
  matched: boolean;
  portfolioResolved: boolean;
  distributing: boolean;
  onDiscardOrderEvidence?: (entry: OrderEvidenceEntry) => void;
  t: TFunction;
}

export function TickerEvidenceRows({
  verifications,
  dividends,
  orderEvidences,
  acceptedKeys,
  addedKeys,
  rowErrors,
  matched,
  portfolioResolved,
  distributing,
  onDiscardOrderEvidence,
  t,
}: TickerEvidenceRowsProps) {
  return (
    <>
      {verifications.map((entry) => (
        <div key={entry.key} className="px-4 py-2.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-slate-300">
              <ShieldCheck size={14} className="text-cyan-400" />
              {t("importPage.brokerPositionCheck", {
                units: formatShares(entry.verification.units),
                avgCostSuffix:
                  entry.verification.avgCost !== undefined
                    ? t("importPage.avgCostSuffix", { avgCost: formatMoney(entry.verification.avgCost) })
                    : "",
              })}
            </span>
            {acceptedKeys.has(entry.key) ? (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <CheckCircle2 size={14} /> {t("importPage.accepted")}
              </span>
            ) : !matched ? (
              <span className="text-xs text-amber-300">{t("importPage.blockedNeedsVerification")}</span>
            ) : !portfolioResolved ? (
              <span className="text-xs text-slate-500">{t("importPage.waitingForPortfolio")}</span>
            ) : distributing ? (
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <Loader2 size={13} className="animate-spin" /> {t("importPage.accepting")}
              </span>
            ) : (
              <span className="text-xs text-slate-500">{t("importPage.readyClickConfirm")}</span>
            )}
          </div>
          {rowErrors[entry.key] ? <p className="mt-1.5 text-xs text-rose-400">{rowErrors[entry.key]}</p> : null}
        </div>
      ))}

      {dividends.map((entry) => (
        <div key={entry.key} className="px-4 py-2.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-slate-300">
              <CircleDollarSign size={14} className="text-emerald-400" />
              {t("importPage.dividendRow", {
                amount: formatMoney(entry.dividend.amount),
                date: formatDate(entry.dividend.date),
              })}
            </span>
            {addedKeys.has(entry.key) ? (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <CheckCircle2 size={14} /> {t("importPage.added")}
              </span>
            ) : !matched ? (
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
          </div>
          {rowErrors[entry.key] ? <p className="mt-1.5 text-xs text-rose-400">{rowErrors[entry.key]}</p> : null}
        </div>
      ))}

      {orderEvidences
        .filter((entry) => entry.evidence.status === "fulfilled")
        .map((entry) => (
          <div key={entry.key} className="px-4 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <History size={13} className="text-cyan-400" />
                {entry.evidence.date
                  ? t("importPage.transactionsHistoryRow", {
                      side: entry.evidence.side,
                      date: formatDate(entry.evidence.date),
                      total: formatMoney(entry.evidence.totalValue),
                    })
                  : t("importPage.ordersHistoryRow", {
                      side: entry.evidence.side,
                      shares: formatShares(entry.evidence.shares ?? 0),
                      price: formatMoney(entry.evidence.price ?? 0),
                      orderType: entry.evidence.orderType ?? "",
                      total: formatMoney(entry.evidence.totalValue),
                    })}
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                  {t("importPage.fulfilled")}
                </span>
              </span>
              <button
                onClick={() => onDiscardOrderEvidence?.(entry)}
                title={t("importPage.discardOrderEvidenceTitle")}
                className="rounded p-1 text-slate-600 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
    </>
  );
}

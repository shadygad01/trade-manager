import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import type { TickerMatchStatus } from "@application/services/importVerification";
import { useT } from "@presentation/i18n/translations";

/** The verification-gate badge on a ticker card's header. */
export function ImportMatchBadge({ status }: { status: TickerMatchStatus | undefined }) {
  const t = useT();

  if (!status) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-700/40 px-2 py-0.5 text-[11px] font-medium text-slate-400">
        <Loader2 size={11} className="animate-spin" /> {t("importPage.matchChecking")}
      </span>
    );
  }

  if (status.reason === "no-verification") {
    if (status.netShares < -1e-6) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400">
          <ShieldAlert size={11} /> {t("importPage.matchMissingBuyHistory")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
        <ShieldAlert size={11} /> {t("importPage.matchNeedsScreenshot")}
      </span>
    );
  }

  if (status.reason === "mismatch") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400">
        <ShieldAlert size={11} /> {t("importPage.matchMismatch")}
      </span>
    );
  }

  if (status.reason === "closed-position") {
    if (!status.matched) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
          <ShieldAlert size={11} /> {t("importPage.matchClosedNeedsEvidence")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchSoldOut")}
      </span>
    );
  }

  if (status.reason === "invoice-verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchInvoiceVerified")}
      </span>
    );
  }

  if (status.reason === "broker-excel-verified") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
          <ShieldCheck size={11} /> {t("importPage.matchBrokerExcelVerified")}
        </span>
        {status.secondaryMismatch && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            title={t("importPage.matchSecondaryMismatchTooltip")}
          >
            <ShieldAlert size={11} /> {t("importPage.matchSecondaryMismatch")}
          </span>
        )}
      </span>
    );
  }

  if (status.reason === "cross-verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchCrossVerified")}
      </span>
    );
  }

  if (status.reason === "orders-verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchOrdersVerified")}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
      <ShieldCheck size={11} /> {t("importPage.matchVerified")}
    </span>
  );
}

import { Loader2, Pencil, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import type { TickerMatchStatus } from "@application/services/importVerification";
import { ImportMatchBadge } from "@presentation/components/ImportMatchBadge";
import { useT } from "@presentation/i18n/translations";

interface TickerGroupHeaderProps {
  ticker: string;
  renaming: boolean;
  draftTicker: string;
  portfolios: { id: string; name: string }[];
  portfolioId: string;
  portfolioResolved: boolean;
  matchStatus: TickerMatchStatus | undefined;
  canConfirm: boolean;
  distributing: boolean;
  canReset: boolean;
  onDraftTickerChange: (ticker: string) => void;
  onBeginRename: () => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onRestoreTicker: (() => void) | undefined;
  onResetTicker: (() => void) | undefined;
  onPortfolioChange: (portfolioId: string) => void;
  onConfirmTicker: () => void;
}

export function TickerGroupHeader({
  ticker, renaming, draftTicker, portfolios, portfolioId, portfolioResolved,
  matchStatus, canConfirm, distributing, canReset, onDraftTickerChange,
  onBeginRename, onConfirmRename, onCancelRename, onRestoreTicker,
  onResetTicker, onPortfolioChange, onConfirmTicker,
}: TickerGroupHeaderProps) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
      {renaming ? (
        <div className="flex items-center gap-1.5">
          <input autoFocus value={draftTicker}
            onChange={(event) => onDraftTickerChange(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter") onConfirmRename();
              if (event.key === "Escape") onCancelRename();
            }}
            className="w-24 rounded border border-cyan-500/50 bg-slate-800 px-2 py-1 text-sm font-semibold text-slate-100" />
          <button onClick={onConfirmRename}
            className="rounded-md bg-cyan-500 px-2 py-1 text-xs font-medium text-slate-950 hover:bg-cyan-400">
            {t("importPage.save")}
          </button>
          <button onClick={onCancelRename}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">
            {t("importPage.cancel")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button onClick={onBeginRename} title={t("importPage.renameTitle")}
            className="flex items-center gap-1.5 text-sm font-semibold text-slate-100 hover:text-cyan-400">
            {ticker}<Pencil size={12} className="text-slate-500" />
          </button>
          {!matchStatus?.matched ? (
            <button onClick={onRestoreTicker} title={t("importPage.restoreTickerRows", { ticker })}
              className="rounded p-0.5 text-slate-500 hover:bg-amber-500/10 hover:text-amber-400">
              <RotateCcw size={12} />
            </button>
          ) : null}
          {canReset && onResetTicker ? (
            <button onClick={onResetTicker} title={t("importPage.resetTickerTitle", { ticker })}
              className="rounded p-0.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400">
              <Trash2 size={12} />
            </button>
          ) : null}
        </div>
      )}
      <div className="flex items-center gap-3">
        <ImportMatchBadge status={matchStatus} />
        <label className="flex items-center gap-2 text-xs text-slate-400">
          {t("importPage.portfolioLabel")}
          <select value={portfolioId} onChange={(event) => onPortfolioChange(event.target.value)}
            className={`rounded border px-2 py-1 text-xs ${portfolioResolved
              ? "border-slate-700 bg-slate-800 text-slate-100"
              : "border-cyan-500/50 bg-slate-800 text-cyan-300"}`}>
            {!portfolioResolved ? <option value="" disabled>{t("importPage.selectPortfolioPlaceholder")}</option> : null}
            {portfolios.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>)}
          </select>
        </label>
        {canConfirm ? (
          <button onClick={onConfirmTicker} disabled={distributing}
            title={t("importPage.confirmTickerTitle", { ticker })}
            className="flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
            {distributing ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            {t("importPage.confirmTickerButton", { ticker })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

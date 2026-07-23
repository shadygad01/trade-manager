import { Trash2 } from "lucide-react";
import { useT } from "@presentation/i18n/translations";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";

export interface RecordedTradeListItem {
  id: string;
  shares: number;
  entryPrice: number;
  executionDate: string;
  deletable: boolean;
}

interface RecordedTradesPanelProps {
  trades: RecordedTradeListItem[];
  rowErrors: Record<string, string>;
  onDelete?: (tradeId: string) => void;
}

export function RecordedTradesPanel({ trades, rowErrors, onDelete }: RecordedTradesPanelProps) {
  const t = useT();
  const failedId = trades.find((trade) => rowErrors[trade.id])?.id;

  return (
    <div className="border-b border-slate-800 bg-slate-950/40 px-4 py-2 text-xs">
      <p className="text-slate-400">{t("importPage.existingTradesPanelTitle", { n: trades.length })}</p>
      <ul className="mt-1.5 space-y-1">
        {trades.map((trade) => (
          <li key={trade.id} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-slate-400">
            <span className="tabular-nums">
              {formatShares(trade.shares)} sh @ {formatMoney(trade.entryPrice)} · {formatDate(trade.executionDate)}
            </span>
            {trade.deletable ? (
              <button
                onClick={() => onDelete?.(trade.id)}
                title={t("importPage.deleteTradeTitle")}
                className="shrink-0 rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            ) : (
              <span title={t("importPage.cannotDeleteHasSells")} className="shrink-0 text-slate-700">
                <Trash2 size={12} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {failedId ? <p className="mt-1 text-rose-400">{rowErrors[failedId]}</p> : null}
    </div>
  );
}

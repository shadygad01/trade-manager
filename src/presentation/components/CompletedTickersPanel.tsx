import { ChevronDown, ShieldCheck, Trash2 } from "lucide-react";
import type { CandidateEntry } from "@presentation/lib/importSession";
import { useT } from "@presentation/i18n/translations";

interface CompletedTickersPanelProps {
  groups: [string, { buys: CandidateEntry[]; sells: CandidateEntry[] }][];
  expanded: boolean;
  onToggleExpanded: () => void;
  transactionCounts: Map<string, number>;
  onResetTicker: (ticker: string) => void;
}

/** Collapsible summary of tickers whose review is fully resolved this session — each entry can be reset back to re-importable from scratch. All resolution/reset logic stays owned by the parent. */
export function CompletedTickersPanel({
  groups,
  expanded,
  onToggleExpanded,
  transactionCounts,
  onResetTicker,
}: CompletedTickersPanelProps) {
  const t = useT();
  if (groups.length === 0) return null;
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <button onClick={onToggleExpanded} className="flex w-full items-center justify-between gap-2 text-start">
        <span className="flex items-center gap-2 text-sm font-medium text-emerald-300">
          <ShieldCheck size={15} />
          {t("importPage.completedSectionTitle", { n: groups.length })}
        </span>
        <ChevronDown size={16} className={`shrink-0 text-emerald-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded ? (
        <ul className="mt-3 space-y-1.5 text-sm text-emerald-200/90">
          {groups.map(([ticker, group]) => {
            const companyName = group.buys[0]?.candidate.companyName ?? group.sells[0]?.candidate.companyName ?? "";
            const count = transactionCounts.get(ticker) ?? 0;
            return (
              <li key={ticker} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-emerald-500/10 px-3 py-1.5">
                <span>{t("importPage.completedTickerEntry", { ticker, company: companyName, count })}</span>
                <button
                  onClick={() => onResetTicker(ticker)}
                  title={t("importPage.resetTickerTitle", { ticker })}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-rose-500/40 px-2 py-0.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
                >
                  <Trash2 size={12} /> {t("importPage.resetTicker")}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

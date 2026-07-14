import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { repos } from "@presentation/lib/data";
import {
  buildTickerReconciliationEvidence,
  listAllTickers,
  summarizeTicker,
  type CanonicalGroupLabel,
} from "@application/services/diagnostics/canonicalGroupEvidence";

const LABEL_TONE: Record<CanonicalGroupLabel, string> = {
  "singleton group": "border-slate-600 text-slate-300",
  "orphaned backfill": "border-amber-600 text-amber-300",
  "duplicate-authority group": "border-emerald-600 text-emerald-300",
  "skipped: tie": "border-rose-600 text-rose-300",
  "skipped: multiple live Trades": "border-rose-600 text-rose-300",
  "skipped: conflicting execution time": "border-rose-600 text-rose-300",
  "matching retracted higher-authority fact": "border-fuchsia-600 text-fuchsia-300",
};

function LabelChip({ label }: { label: CanonicalGroupLabel }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${LABEL_TONE[label]}`}>{label}</span>;
}

/**
 * TEMPORARY — pure evidence surface for the "why did the Sweep report zero
 * duplicate groups while TickerAuthorityPanel still shows a contradiction"
 * investigation. Never calls reconciliation.ts, commitEngine.ts, or
 * reconciliationSweep.ts — read-only, decides nothing, retracts nothing.
 * See canonicalGroupEvidence.ts's own doc comment for what it mirrors and
 * why. Delete this file and its usage in DiagnosticsPage.tsx once the
 * investigation is closed.
 */
export function CanonicalGroupEvidencePanel() {
  const allRawTransactions = useLiveQuery(() => repos.rawTransactions.getAll(), []);
  const allTrades = useLiveQuery(() => repos.trades.getAll(), []);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  const loading = allRawTransactions === undefined || allTrades === undefined;

  const overview = useMemo(() => {
    if (loading) return [];
    const tickers = listAllTickers(allRawTransactions);
    return tickers.map((ticker) => summarizeTicker(buildTickerReconciliationEvidence(allRawTransactions, allTrades, ticker)));
  }, [allRawTransactions, allTrades, loading]);

  const detail = useMemo(() => {
    if (loading || !selectedTicker) return null;
    return buildTickerReconciliationEvidence(allRawTransactions, allTrades, selectedTicker);
  }, [allRawTransactions, allTrades, loading, selectedTicker]);

  if (loading) {
    return <p className="text-sm text-slate-500">Loading raw transactions and trades…</p>;
  }

  return (
    <div className="space-y-4 rounded-md border border-violet-700/50 bg-violet-950/20 p-4">
      <h2 className="text-sm font-semibold text-violet-300">TEMPORARY — Canonical Group Evidence</h2>
      <p className="text-xs text-slate-400">
        Evidence only — never calls reconciliation.ts, commitEngine.ts, or reconciliationSweep.ts. Every ticker with
        any live or retracted Buy/Sell fact appears below; none are hidden by a zero-result filter.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-left text-slate-400">
              <th className="py-1 pr-3">ticker</th>
              <th className="py-1 pr-3">in sweep pipeline?</th>
              <th className="py-1 pr-3">live facts</th>
              <th className="py-1 pr-3">retracted facts</th>
              <th className="py-1 pr-3">groups</th>
              <th className="py-1 pr-3">singleton</th>
              <th className="py-1 pr-3">duplicate-authority</th>
              <th className="py-1 pr-3">orphaned backfill</th>
              <th className="py-1 pr-3">matching retracted higher-authority</th>
            </tr>
          </thead>
          <tbody>
            {overview.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-2 text-slate-500">
                  No Buy/Sell facts in the database.
                </td>
              </tr>
            ) : (
              overview.map((s) => (
                <tr
                  key={s.ticker}
                  onClick={() => setSelectedTicker(s.ticker)}
                  className={`cursor-pointer border-b border-slate-800 text-slate-300 hover:bg-slate-900 ${selectedTicker === s.ticker ? "bg-slate-900" : ""}`}
                >
                  <td className="py-1 pr-3 font-mono">{s.ticker}</td>
                  <td className={`py-1 pr-3 font-semibold ${s.wouldEnterSweepPipeline ? "text-emerald-400" : "text-rose-400"}`}>
                    {s.wouldEnterSweepPipeline ? "yes" : "NEVER ENTERS"}
                  </td>
                  <td className="py-1 pr-3">{s.liveFactCount}</td>
                  <td className="py-1 pr-3">{s.retractedFactCount}</td>
                  <td className="py-1 pr-3">{s.groupCount}</td>
                  <td className="py-1 pr-3">{s.singletonGroupCount}</td>
                  <td className="py-1 pr-3 text-emerald-400">{s.duplicateAuthorityGroupCount}</td>
                  <td className="py-1 pr-3 text-amber-400">{s.orphanedBackfillGroupCount}</td>
                  <td className="py-1 pr-3 text-fuchsia-400">{s.matchingRetractedHigherAuthorityGroupCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">Click a row for the full per-group, per-fact breakdown below.</p>

      {detail ? (
        <div className="space-y-3 border-t border-violet-800/50 pt-3">
          <h3 className="text-sm font-semibold text-violet-300">
            {detail.ticker} — {detail.wouldEnterSweepPipeline ? "would enter the sweep pipeline right now" : "would NEVER enter the sweep pipeline — no live fact has a resolved portfolio"}
          </h3>

          {detail.groups.length === 0 ? (
            <p className="text-xs text-slate-500">No canonical groups for this ticker.</p>
          ) : (
            detail.groups.map((group) => (
              <div key={group.canonicalKey} className="rounded border border-slate-800 bg-slate-900/60 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-200">{group.canonicalKey}</span>
                  <span className="text-[10px] text-slate-500">
                    ({group.liveCount} live, {group.retractedCount} retracted)
                  </span>
                  {group.labels.map((label) => (
                    <LabelChip key={label} label={label} />
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-slate-500">
                        <th className="py-1 pr-3">id</th>
                        <th className="py-1 pr-3">kind</th>
                        <th className="py-1 pr-3">source</th>
                        <th className="py-1 pr-3">authorityRank</th>
                        <th className="py-1 pr-3">retracted</th>
                        <th className="py-1 pr-3">executionDate</th>
                        <th className="py-1 pr-3">executionTime</th>
                        <th className="py-1 pr-3">shares</th>
                        <th className="py-1 pr-3">price</th>
                        <th className="py-1 pr-3">portfolioId</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.facts.map((f) => (
                        <tr key={f.id} className="border-b border-slate-800/60 text-slate-300">
                          <td className="py-1 pr-3 font-mono">{f.id}</td>
                          <td className="py-1 pr-3">{f.kind}</td>
                          <td className="py-1 pr-3">{f.source}</td>
                          <td className="py-1 pr-3">{f.authorityRank}</td>
                          <td className={`py-1 pr-3 font-semibold ${f.retracted ? "text-rose-400" : "text-emerald-400"}`}>
                            {String(f.retracted)}
                          </td>
                          <td className="py-1 pr-3">{f.executionDate}</td>
                          <td className="py-1 pr-3">{f.executionTime ?? "—"}</td>
                          <td className="py-1 pr-3">{f.shares}</td>
                          <td className="py-1 pr-3">{f.price}</td>
                          <td className="py-1 pr-3 font-mono">{f.portfolioId ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No ticker selected.</p>
      )}
    </div>
  );
}

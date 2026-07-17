import { useState } from "react";
import { repos } from "@presentation/lib/data";
import { runReconciliationSweep, type ReconciliationSweepReport } from "@application/services/reconciliationSweep";

/**
 * TEMPORARY — manual maintenance operation for the gap this codebase's
 * investigation found: `reconcileDuplicateAuthority` (commitEngine.ts) only
 * ever runs reactively, inside `commitTicker`, on a NEW write for a ticker —
 * it never retroactively swept the duplicate-authority pairs already sitting
 * in the database (most notably every `source: "backfill"` fact written by
 * the one-time silent boot backfill, which never triggers a commit). This
 * button is that missing retroactive pass: user-initiated only, no startup
 * hook, no background job — reuses `commitTicker`/`reconcileDuplicateAuthority`
 * exactly as-is for every ticker with live Buy/Sell facts (see
 * reconciliationSweep.ts's own doc comment). Delete this file and its one
 * import/usage line in DiagnosticsPage.tsx once the user has verified it
 * against production data and it either graduates into a permanent
 * migration or is decided to remain a standing maintenance tool.
 */
export function ReconciliationSweepPanel() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ReconciliationSweepReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const confirmed = confirm(
      "Run the reconciliation sweep now?\n\n" +
        "This calls commitTicker (the same production commit pipeline every real write already goes through) for every ticker with live Buy/Sell facts. " +
        "Where a lower-authority fact (e.g. a backfill fact) duplicates an already-live higher-authority fact (e.g. an official-broker-excel fact) for the same execution, the lower-authority fact is retracted — never a real delete, always reversible via the fact log.\n\n" +
        "Safe to run more than once; a ticker with nothing left to converge reports zero.",
    );
    if (!confirmed) return;

    setRunning(true);
    setError(null);
    try {
      const result = await runReconciliationSweep(repos);
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconciliation sweep failed.");
    } finally {
      setRunning(false);
    }
  }

  const rowsToShow =
    report?.perTicker.filter(
      (r) =>
        r.duplicateGroupsFound > 0 ||
        r.officialBrokerDuplicatesRetracted > 0 ||
        r.officialBrokerAllocationsRepaired > 0 ||
        r.error,
    ) ?? [];

  return (
    <div className="space-y-4 rounded-md border border-cyan-700/50 bg-cyan-950/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-cyan-300">TEMPORARY — Reconciliation Sweep (manual maintenance)</h2>
        <button
          onClick={() => void run()}
          disabled={running}
          className="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {running ? "Running…" : "Run reconciliation sweep"}
        </button>
      </div>
      <p className="text-xs text-slate-400">
        User-initiated only. No automatic startup sweep, no background rewrite. Reuses commitTicker /
        reconcileDuplicateAuthority (commitEngine.ts) for every ticker — the same production pipeline, not a second
        reconciliation algorithm. Idempotent: safe to run repeatedly.
      </p>

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}

      {report ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-7">
            <Stat label="tickers scanned" value={report.tickersScanned} />
            <Stat label="duplicate groups found" value={report.duplicateGroupsFound} />
            <Stat label="facts retracted" value={report.factsRetracted} tone="text-emerald-400" />
            <Stat label="facts skipped" value={report.factsSkipped} tone="text-amber-400" />
            <Stat label="broker duplicates removed" value={report.officialBrokerDuplicatesRetracted} tone="text-emerald-400" />
            <Stat label="sell allocations repaired" value={report.officialBrokerAllocationsRepaired} tone="text-emerald-400" />
            <Stat label="errors" value={report.errors.length} tone={report.errors.length > 0 ? "text-rose-400" : undefined} />
          </div>

          {rowsToShow.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="py-1 pr-3">portfolioId</th>
                    <th className="py-1 pr-3">ticker</th>
                    <th className="py-1 pr-3">duplicate groups</th>
                    <th className="py-1 pr-3">retracted</th>
                    <th className="py-1 pr-3">skipped</th>
                    <th className="py-1 pr-3">broker duplicates removed</th>
                    <th className="py-1 pr-3">sell allocations repaired</th>
                    <th className="py-1 pr-3">error</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsToShow.map((r) => (
                    <tr key={`${r.portfolioId}|${r.ticker}`} className="border-b border-slate-800 text-slate-300">
                      <td className="py-1 pr-3 font-mono">{r.portfolioId}</td>
                      <td className="py-1 pr-3">{r.ticker}</td>
                      <td className="py-1 pr-3">{r.duplicateGroupsFound}</td>
                      <td className="py-1 pr-3 text-emerald-400">{r.factsRetracted}</td>
                      <td className="py-1 pr-3 text-amber-400">{r.factsSkipped}</td>
                      <td className="py-1 pr-3 text-emerald-400">{r.officialBrokerDuplicatesRetracted}</td>
                      <td className="py-1 pr-3 text-emerald-400">{r.officialBrokerAllocationsRepaired}</td>
                      <td className="py-1 pr-3 text-rose-400">{r.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-500">No ticker had a duplicate-authority group this run.</p>
          )}

          {rowsToShow.some((r) => r.errorDetail) ? (
            <div className="space-y-2">
              {rowsToShow
                .filter((r) => r.errorDetail)
                .map((r) => (
                  <details key={`${r.portfolioId}|${r.ticker}|detail`} className="rounded border border-rose-900/50 bg-rose-950/10 p-2">
                    <summary className="cursor-pointer text-xs font-medium text-rose-300">{r.ticker} — full error detail (copy this)</summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px] text-rose-200/80">{r.errorDetail}</pre>
                  </details>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5">
      <div className={`text-sm font-semibold ${tone ?? "text-slate-100"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

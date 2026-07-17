import { useState } from "react";
import { repos } from "@presentation/lib/data";
import {
  findDuplicateTradeGroups,
  cleanupDuplicateTrades,
  type DuplicateTradeGroup,
  type DuplicateTradeCleanupReport,
} from "@application/services/duplicateTradeCleanup";

/**
 * TEMPORARY — manual maintenance for a real, reproduced bug: re-uploading
 * the same broker Excel export across separate past sessions committed the
 * same real Buy execution as a brand-new `Trade` row each time (confirmed
 * directly from a user-provided Trades-page screenshot showing exact
 * duplicate rows — same ticker/date/time/shares/price). Some duplicate
 * pairs had their Sell applied to only ONE copy, leaving the other stuck
 * open forever — the exact mechanism behind a "this position is genuinely
 * fully closed per the broker, but Holdings still shows shares open" report
 * for several tickers at once. See duplicateTradeCleanup.ts's own doc
 * comment for the full trace.
 *
 * Two-step, preview-first flow (never a one-click delete): Scan is fully
 * read-only and shows exactly which trades would be removed and why before
 * anything happens; Apply only then calls the real, unmodified `deleteTrade`
 * (TradeService.ts) for each one, reusing its own cash-refund/timeline/
 * raw-transaction-retraction logic and its own safety guard (refuses
 * anything with real sell history) as an independent second check on top of
 * this module's own classification.
 */
export function DuplicateTradeCleanupPanel() {
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [groups, setGroups] = useState<DuplicateTradeGroup[] | null>(null);
  const [report, setReport] = useState<DuplicateTradeCleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    setReport(null);
    try {
      const allTrades = await repos.trades.getAll();
      setGroups(findDuplicateTradeGroups(allTrades));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setScanning(false);
    }
  }

  async function apply() {
    if (!groups) return;
    const removableCount = groups.reduce((sum, g) => sum + g.removable.length, 0);
    const confirmed = confirm(
      `Delete ${removableCount} duplicate Trade row(s) across ${groups.filter((g) => !g.ambiguous).length} group(s)?\n\n` +
        "Each deletion goes through the real deleteTrade function — it refunds the exact cash it cost, removes its Buy timeline event, and refuses outright if the trade has any real sell history (already double-checked by the scan above, but never trusted blindly). Ambiguous groups are never touched.",
    );
    if (!confirmed) return;

    setApplying(true);
    setError(null);
    try {
      const result = await cleanupDuplicateTrades(repos, groups);
      setReport(result);
      setGroups(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cleanup failed.");
    } finally {
      setApplying(false);
    }
  }

  const removableCount = groups?.reduce((sum, g) => sum + g.removable.length, 0) ?? 0;
  const resolvedGroups = groups?.filter((g) => !g.ambiguous && g.removable.length > 0) ?? [];
  const ambiguousGroups = groups?.filter((g) => g.ambiguous) ?? [];

  return (
    <div className="space-y-4 rounded-md border border-amber-700/50 bg-amber-950/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-amber-300">TEMPORARY — Duplicate Trade Cleanup (manual maintenance)</h2>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => void scan()}
            disabled={scanning || applying}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan for duplicate trades"}
          </button>
          {groups && removableCount > 0 ? (
            <button
              onClick={() => void apply()}
              disabled={applying}
              className="rounded-md border border-rose-700 bg-rose-950/40 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-900/40 disabled:opacity-50"
            >
              {applying ? "Deleting…" : `Delete ${removableCount} duplicate row(s)`}
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Read-only scan first — nothing is deleted until you review the list below and explicitly confirm. Only ever
        removes a Trade with `remainingShares === shares` (never touched by any sell); every deletion goes through the
        real `deleteTrade`, which independently refuses anything else.
      </p>

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}

      {groups && groups.length === 0 ? (
        <p className="text-xs text-slate-500">No duplicate trades found.</p>
      ) : null}

      {resolvedGroups.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-left text-slate-400">
                <th className="py-1 pr-3">ticker</th>
                <th className="py-1 pr-3">date</th>
                <th className="py-1 pr-3">time</th>
                <th className="py-1 pr-3">shares</th>
                <th className="py-1 pr-3">price</th>
                <th className="py-1 pr-3">copies</th>
                <th className="py-1 pr-3">removable</th>
              </tr>
            </thead>
            <tbody>
              {resolvedGroups.map((g, i) => (
                <tr key={i} className="border-b border-slate-800 text-slate-300">
                  <td className="py-1 pr-3 font-medium">{g.ticker}</td>
                  <td className="py-1 pr-3">{g.executionDate}</td>
                  <td className="py-1 pr-3">{g.executionTime}</td>
                  <td className="py-1 pr-3">{g.shares}</td>
                  <td className="py-1 pr-3">{g.entryPrice}</td>
                  <td className="py-1 pr-3">{g.keep.length + g.removable.length}</td>
                  <td className="py-1 pr-3 text-amber-400">{g.removable.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {ambiguousGroups.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-slate-400">
            {ambiguousGroups.length} group(s) left untouched — multiple copies each have DIFFERENT real sell history,
            so which one is genuine can't be decided automatically. Needs manual review in the Lot Manager.
          </p>
          <ul className="space-y-0.5 text-xs text-slate-500">
            {ambiguousGroups.map((g, i) => (
              <li key={i}>
                {g.ticker} · {g.executionDate} {g.executionTime} · {g.shares} sh @ {g.entryPrice}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="groups resolved" value={report.groupsFound} />
            <Stat label="trades deleted" value={report.tradesDeleted} tone="text-emerald-400" />
            <Stat label="ambiguous (skipped)" value={report.ambiguousGroups.length} tone="text-amber-400" />
            <Stat label="errors" value={report.errors.length} tone={report.errors.length > 0 ? "text-rose-400" : undefined} />
          </div>
          {report.errors.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-rose-400">
              {report.errors.map((e, i) => (
                <li key={i}>
                  {e.tradeId}: {e.error}
                </li>
              ))}
            </ul>
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

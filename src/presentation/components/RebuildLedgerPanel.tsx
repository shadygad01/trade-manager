import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { RefreshCw, Wrench, AlertTriangle } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { dryRunLedgerRebuild, applyLedgerRebuild, type LedgerRebuildReport } from "@application/services/ledgerRebuild";
import { formatShares, formatDate } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

/**
 * Dry-run-first UI for the Ledger Rebuild Engine (ledgerRebuild.ts): a
 * report is always computed and shown before any button that writes to the
 * database exists at all — "Apply" only appears once a report is on screen,
 * and itself requires a final confirm() naming exactly what it's about to
 * do. Only the safe subset of a diff (see ledgerRebuild.ts's
 * applyLedgerRebuild) is ever offered as an action; sell/allocation-related
 * findings are always informational-only, never a button.
 */
export function RebuildLedgerPanel() {
  const t = useT();
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []) ?? [];
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<LedgerRebuildReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addPortfolio, setAddPortfolio] = useState<Record<string, string>>({});
  const [removeChecked, setRemoveChecked] = useState<Set<string>>(new Set());
  const [modifyChecked, setModifyChecked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  /** Fetches a fresh report without disturbing applyResult/error — used both by the Run Dry Run button (which separately clears them first) and to refresh the diff right after Apply (which needs its own success message to survive the refresh). */
  async function refreshReport() {
    const result = await dryRunLedgerRebuild(repos);
    setReport(result);
    setAddPortfolio({});
    setRemoveChecked(new Set());
    setModifyChecked(new Set(result.tradesToModify.filter((m) => m.autoApplicable).map((m) => m.trade.id)));
  }

  async function runDryRun() {
    setRunning(true);
    setError(null);
    setApplyResult(null);
    try {
      await refreshReport();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("rebuild.dryRunFailed"));
    } finally {
      setRunning(false);
    }
  }

  async function apply() {
    if (!report) return;
    const removeTradeIds = report.tradesToRemove.filter((r) => !r.blockedByAllocations && removeChecked.has(r.trade.id)).map((r) => r.trade.id);
    const modifyTradeIds = report.tradesToModify.filter((m) => m.autoApplicable && modifyChecked.has(m.trade.id)).map((m) => m.trade.id);
    const addCount = Object.keys(addPortfolio).length;
    if (!confirm(t("rebuild.applyConfirm", { add: addCount, remove: removeTradeIds.length, modify: modifyTradeIds.length }))) return;

    setApplying(true);
    setError(null);
    try {
      const result = await applyLedgerRebuild(repos, report, { addToPortfolioByKey: addPortfolio, removeTradeIds, modifyTradeIds });
      await refreshReport();
      setApplyResult(t("rebuild.applyResult", { added: result.added, removed: result.removed, modified: result.modified, skipped: result.skipped.length }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("rebuild.applyFailed"));
    } finally {
      setApplying(false);
    }
  }

  const hasAnySelection = report ? Object.keys(addPortfolio).length > 0 || removeChecked.size > 0 || modifyChecked.size > 0 : false;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <Wrench size={16} /> {t("rebuild.title")}
      </h3>
      <p className="mb-4 text-sm text-slate-400">{t("rebuild.description")}</p>

      <button
        onClick={() => void runDryRun()}
        disabled={running}
        className="flex items-center gap-1.5 rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        <RefreshCw size={16} className={running ? "animate-spin" : ""} /> {running ? t("rebuild.running") : t("rebuild.runDryRun")}
      </button>
      {error ? <p className="mt-2 text-sm text-rose-400">{error}</p> : null}
      {applyResult ? <p className="mt-2 text-sm text-emerald-400">{applyResult}</p> : null}

      {report ? (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-xs text-slate-500">{t("rebuild.generatedAt", { date: formatDate(report.generatedAt.slice(0, 10)) })}</p>

          <Section title={t("rebuild.tradesToAdd", { n: report.tradesToAdd.length })}>
            {report.tradesToAdd.map((a) => (
              <div key={a.canonical.key} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 py-1.5 last:border-0">
                <span>
                  {a.canonical.ticker} · {t("rebuild.buySide")} {formatShares(a.canonical.shares)} @ {a.canonical.price} · {formatDate(a.canonical.executionDate)}
                </span>
                <select
                  value={addPortfolio[a.canonical.key] ?? ""}
                  onChange={(e) => setAddPortfolio((prev) => (e.target.value ? { ...prev, [a.canonical.key]: e.target.value } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== a.canonical.key))))}
                  className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
                >
                  <option value="">{t("rebuild.skipAdd")}</option>
                  {portfolios.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </Section>

          <Section title={t("rebuild.tradesToRemove", { n: report.tradesToRemove.length })}>
            {report.tradesToRemove.map((r) => (
              <label key={r.trade.id} className={`flex items-center gap-2 border-b border-slate-800 py-1.5 last:border-0 ${r.blockedByAllocations ? "text-slate-600" : ""}`}>
                <input
                  type="checkbox"
                  disabled={r.blockedByAllocations}
                  checked={removeChecked.has(r.trade.id)}
                  onChange={(e) =>
                    setRemoveChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(r.trade.id);
                      else next.delete(r.trade.id);
                      return next;
                    })
                  }
                />
                <span>
                  {r.trade.ticker} · {formatShares(r.trade.shares)} @ {r.trade.entryPrice} · {formatDate(r.trade.executionDate)}
                  {r.blockedByAllocations ? ` — ${t("rebuild.blockedByAllocations")}` : ""}
                </span>
              </label>
            ))}
          </Section>

          <Section title={t("rebuild.tradesToModify", { n: report.tradesToModify.length })}>
            {report.tradesToModify.map((m) => (
              <label key={m.trade.id} className={`flex items-center gap-2 border-b border-slate-800 py-1.5 last:border-0 ${!m.autoApplicable ? "text-slate-600" : ""}`}>
                <input
                  type="checkbox"
                  disabled={!m.autoApplicable}
                  checked={modifyChecked.has(m.trade.id)}
                  onChange={(e) =>
                    setModifyChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.trade.id);
                      else next.delete(m.trade.id);
                      return next;
                    })
                  }
                />
                <span>
                  {m.trade.ticker}: {m.changes.map((c) => `${c.field} ${c.existing ?? "—"} → ${c.canonical ?? "—"}`).join(", ")}
                  {!m.autoApplicable ? ` — ${t("rebuild.requiresManualCorrection")}` : ""}
                </span>
              </label>
            ))}
          </Section>

          <Section title={t("rebuild.sellsToAdd", { n: report.sellsToAdd.length })} info={t("rebuild.sellsInfo")}>
            {report.sellsToAdd.map((s, i) => (
              <div key={i} className="border-b border-slate-800 py-1.5 last:border-0">
                {s.canonical.ticker} · {formatShares(s.canonical.shares)} @ {s.canonical.price} · {formatDate(s.canonical.executionDate)}
              </div>
            ))}
          </Section>

          <Section title={t("rebuild.sellsExtraneous", { n: report.sellsExtraneous.length })} info={t("rebuild.sellsInfo")}>
            {report.sellsExtraneous.map((s, i) => (
              <div key={i} className="border-b border-slate-800 py-1.5 last:border-0">
                {s.ticker} · {formatShares(s.group.totalShares)} @ {s.group.price} · {formatDate(s.group.date)}
              </div>
            ))}
          </Section>

          <Section title={t("rebuild.holdingsMismatches", { n: report.holdingsMismatches.length })}>
            {report.holdingsMismatches.map((h) => (
              <div key={h.ticker} className="border-b border-slate-800 py-1.5 last:border-0">
                {h.ticker}: {t("rebuild.holdingsLine", { calculated: formatShares(h.calculatedRemaining), verified: formatShares(h.verifiedUnits ?? 0) })}
              </div>
            ))}
          </Section>

          <div>
            <p className="mb-2 flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {t("rebuild.applyWarning")}
            </p>
            <button
              onClick={() => void apply()}
              disabled={applying || !hasAnySelection}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applying ? t("rebuild.applying") : t("rebuild.applyButton")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, info, children }: { title: string; info?: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      {info ? <p className="mb-1 text-xs text-slate-500">{info}</p> : null}
      <div className="text-xs text-slate-300">{children}</div>
    </div>
  );
}

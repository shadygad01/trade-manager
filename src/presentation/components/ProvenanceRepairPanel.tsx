import { useState } from "react";
import { ShieldCheck, RefreshCw, AlertTriangle } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { dryRunProvenanceRepair, applyProvenanceRepair, type ProvenanceRepairReport } from "@application/services/provenanceRepair";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

/**
 * One-time repair UI for data written before ensureSellFacts (TradeService.ts)
 * was fixed to adopt an already-existing, correctly-sourced SellExecution
 * fact instead of always minting one with source "manual". Same dry-run-first
 * convention as RebuildLedgerPanel: a report is always computed and shown
 * before the one write action (Repair) exists at all, and Repair itself
 * requires a final confirm() naming exactly how many sells it's about to fix.
 */
export function ProvenanceRepairPanel() {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ProvenanceRepairReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function runCheck() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const report = await dryRunProvenanceRepair(repos);
      setReport(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("provenanceRepair.checkFailed"));
    } finally {
      setRunning(false);
    }
  }

  async function repair() {
    if (!report || report.findings.length === 0) return;
    if (!confirm(t("provenanceRepair.repairConfirm", { n: report.findings.length }))) return;

    setRepairing(true);
    setError(null);
    try {
      const outcome = await applyProvenanceRepair(repos, report.findings);
      setResult(t("provenanceRepair.repairResult", { repaired: outcome.repaired, skipped: outcome.skipped.length }));
      setReport(await dryRunProvenanceRepair(repos));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("provenanceRepair.repairFailed"));
    } finally {
      setRepairing(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-200">
        <ShieldCheck size={16} /> {t("provenanceRepair.title")}
      </h3>
      <p className="mb-4 text-sm text-slate-400">{t("provenanceRepair.description")}</p>

      <button
        onClick={() => void runCheck()}
        disabled={running}
        className="flex items-center gap-1.5 rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        <RefreshCw size={16} className={running ? "animate-spin" : ""} /> {running ? t("provenanceRepair.checking") : t("provenanceRepair.runCheck")}
      </button>
      {error ? <p className="mt-2 text-sm text-rose-400">{error}</p> : null}
      {result ? <p className="mt-2 text-sm text-emerald-400">{result}</p> : null}

      {report ? (
        report.findings.length === 0 ? (
          <p className="mt-4 text-sm text-emerald-400">{t("provenanceRepair.noneFound")}</p>
        ) : (
          <div className="mt-4 space-y-3 text-sm">
            <div className="text-xs text-slate-300">
              {report.findings.map((f) => (
                <div key={f.decisionId} className="border-b border-slate-800 py-1.5 last:border-0">
                  {f.ticker} · {formatShares(f.shares)} @ {formatMoney(f.price)} · {formatDate(f.executionDate)} —{" "}
                  {t("provenanceRepair.findingLine", { wrongSource: f.wrongSource, correctSource: f.correctSource })}
                </div>
              ))}
            </div>
            <p className="flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {t("provenanceRepair.repairWarning")}
            </p>
            <button
              onClick={() => void repair()}
              disabled={repairing}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {repairing ? t("provenanceRepair.repairing") : t("provenanceRepair.repairButton", { n: report.findings.length })}
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

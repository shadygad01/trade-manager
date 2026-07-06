import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, Upload, AlertTriangle, HardDriveDownload } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { exportLedger, importLedger, parseLedgerSnapshot } from "@application/services/BackupService";
import { PageHeader } from "@presentation/components/PageHeader";
import { formatDate } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataPage() {
  const t = useT();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const stats = useLiveQuery(async () => {
    const [portfolios, trades, timelineEvents] = await Promise.all([
      repos.portfolios.getAll(),
      repos.trades.getAll(),
      repos.timeline.getAll(),
    ]);
    return { portfolios: portfolios.length, trades: trades.length, events: timelineEvents.length };
  }, []);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const snapshot = await exportLedger(repos);
      const stamp = snapshot.exportedAt.slice(0, 10);
      downloadJson(`portfolio-os-backup-${stamp}.json`, snapshot);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t("data.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(file: File) {
    setImportError(null);
    setImportSuccess(null);
    let snapshot;
    try {
      const text = await file.text();
      snapshot = parseLedgerSnapshot(text);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : t("data.couldntReadFile"));
      return;
    }

    const summary = t("data.backupSummary", {
      portfolios: snapshot.portfolios.length,
      trades: snapshot.trades.length,
      date: formatDate(snapshot.exportedAt.slice(0, 10)),
    });
    if (!confirm(t("data.restoreConfirm", { summary }))) {
      return;
    }

    setImporting(true);
    try {
      await importLedger(repos, snapshot);
      setImportSuccess(t("data.restoredSuccess", { summary }));
    } catch (e) {
      setImportError(e instanceof Error ? e.message : t("data.restoreFailed"));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("data.title")}
        description={t("data.description")}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Download size={16} /> {t("data.backupTitle")}
          </h3>
          <p className="mb-4 text-sm text-slate-400">
            {t("data.backupDescription")}
          </p>
          {stats ? (
            <p className="mb-4 text-xs text-slate-500">
              {t("data.statsSummary", { portfolios: stats.portfolios, trades: stats.trades, events: stats.events })}
            </p>
          ) : null}
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            <HardDriveDownload size={16} /> {exporting ? t("data.preparing") : t("data.downloadBackup")}
          </button>
          {exportError ? <p className="mt-2 text-sm text-rose-400">{exportError}</p> : null}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Upload size={16} /> {t("data.restoreTitle")}
          </h3>
          <p className="mb-2 text-sm text-slate-400">
            {t("data.restoreDescription")}
          </p>
          <p className="mb-4 flex items-start gap-1.5 text-xs text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {t("data.restoreWarning")}
          </p>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">
            <Upload size={16} /> {importing ? t("data.restoring") : t("data.chooseBackupFile")}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              disabled={importing}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = "";
              }}
            />
          </label>
          {importError ? <p className="mt-2 text-sm text-rose-400">{importError}</p> : null}
          {importSuccess ? <p className="mt-2 text-sm text-emerald-400">{importSuccess}</p> : null}
        </div>
      </div>
    </div>
  );
}

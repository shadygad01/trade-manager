import { UploadCloud, FileText, CheckCircle2, Loader2 } from "lucide-react";
import { useT } from "@presentation/i18n/translations";

type Stage = "idle" | "reading" | "error";

interface ImportUploadPanelProps {
  trackingStartDate: string;
  startYearOptions: number[];
  onStartYearChange: (year: string) => void;
  dragOver: boolean;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDropFiles: (files: File[]) => void;
  onChooseFiles: (files: File[]) => void;
  queueProgress: { index: number; total: number; fileName: string } | null;
  stage: Stage;
  errorMessage: string;
  recentFileResults: { fileName: string; warnings: string[]; duplicate: boolean }[];
  totalPending: number;
  pendingOrderEvidenceCount: number;
  filesProcessed: number;
}

/** Step 1: tracking-start-date picker, drag/drop-or-choose upload dropzone, per-file results, and the extracted-rows summary line. All file handling and tracking-date persistence stay owned by the parent. */
export function ImportUploadPanel({
  trackingStartDate,
  startYearOptions,
  onStartYearChange,
  dragOver,
  onDragOver,
  onDragLeave,
  onDropFiles,
  onChooseFiles,
  queueProgress,
  stage,
  errorMessage,
  recentFileResults,
  totalPending,
  pendingOrderEvidenceCount,
  filesProcessed,
}: ImportUploadPanelProps) {
  const t = useT();
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">{t("importPage.step1Title")}</h3>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
        <label htmlFor="import-start-year" className="font-medium text-slate-300">
          {t("importPage.startDateLabel")}
        </label>
        <select
          id="import-start-year"
          value={trackingStartDate.slice(0, 4)}
          onChange={(e) => onStartYearChange(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
        >
          {startYearOptions.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span>{t("importPage.startDateHint", { date: trackingStartDate })}</span>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          onDragOver();
        }}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
          e.preventDefault();
          onDragLeave();
          const dropped = Array.from(e.dataTransfer.files ?? []);
          if (dropped.length > 0) onDropFiles(dropped);
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver ? "border-cyan-400 bg-cyan-500/5" : "border-slate-800 bg-slate-950/40"
        }`}
      >
        <UploadCloud size={28} className="text-slate-500" />
        <p className="text-sm font-medium text-slate-200">{t("importPage.dropzoneText")}</p>
        <p className="text-xs text-slate-500">{t("importPage.or")}</p>
        <label className="cursor-pointer rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400">
          {t("importPage.chooseFiles")}
          <input
            type="file"
            multiple
            accept="image/*,application/pdf,text/csv,.csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              if (chosen.length > 0) onChooseFiles(chosen);
              e.target.value = "";
            }}
          />
        </label>
        {queueProgress ? (
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-300">
            <Loader2 size={14} className="animate-spin" />
            <FileText size={14} /> {t("importPage.processingProgress", { index: queueProgress.index, total: queueProgress.total, fileName: queueProgress.fileName })}
          </div>
        ) : null}
        {stage === "error" ? <p className="text-sm text-rose-400">{errorMessage}</p> : null}
      </div>

      {recentFileResults.length > 0 && stage !== "reading" ? (
        <div className="mt-3 space-y-1.5">
          {recentFileResults.map((r, i) => (
            <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
              <span className="font-medium text-slate-300">{r.fileName}</span>
              {r.duplicate ? (
                <span className="ms-2 text-cyan-400">{t("importPage.duplicateFileSkipped")}</span>
              ) : r.warnings.length > 0 ? (
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-300/80">
                  {r.warnings.map((w, wi) => (
                    <li key={wi}>{w}</li>
                  ))}
                </ul>
              ) : (
                <span className="ms-2 text-emerald-400">{t("importPage.extractedSuccessfully")}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <p className="mt-3 flex items-center gap-2 text-sm text-slate-300">
        {totalPending > 0 || pendingOrderEvidenceCount > 0 ? <CheckCircle2 size={15} className="text-emerald-400" /> : null}
        {t("importPage.extractedSummary", { n: totalPending, orderRows: pendingOrderEvidenceCount, files: filesProcessed })}
      </p>
    </div>
  );
}

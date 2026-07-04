import { useState } from "react";
import { useParams } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { UploadCloud, FileText, AlertTriangle, ShieldCheck, ShieldAlert, CheckCircle2, Loader2 } from "lucide-react";
import { repos, importOrchestrator } from "@presentation/lib/data";
import type { ImportResult } from "@infrastructure/ocr/ImportOrchestrator";
import { recordBuy } from "@application/services/TradeService";
import { findDuplicateBuyMatch, findDuplicateSellMatch } from "@application/services/duplicateDetection";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { ParsedTradeCandidate, Upload } from "@domain/entities/Upload";
import { PageHeader } from "@presentation/components/PageHeader";
import { Modal } from "@presentation/components/Modal";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";

type Stage = "idle" | "reading" | "done" | "error";

export function ImportPage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [outcome, setOutcome] = useState<ImportResult | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<Upload | null>(null);
  const [addedTickers, setAddedTickers] = useState<Set<number>>(new Set());
  const [sellCandidate, setSellCandidate] = useState<{ index: number; candidate: ParsedTradeCandidate } | null>(null);
  const [acceptedVerifications, setAcceptedVerifications] = useState<Set<number>>(new Set());

  // Loaded once outcome is available so each candidate row can be checked
  // against trades/allocations already on the ledger — the same "possible
  // duplicate" safety net as the original Thndr import, ported here instead
  // of only deduping within a single OCR pass.
  const existingTrades = useLiveQuery(() => repos.trades.getByPortfolio(portfolioId), [portfolioId]) ?? [];
  const existingAllocations = useLiveQuery(() => repos.allocations.getByPortfolio(portfolioId), [portfolioId]) ?? [];

  function duplicateMatch(candidate: ParsedTradeCandidate) {
    return candidate.side === "BUY"
      ? findDuplicateBuyMatch(candidate, existingTrades)
      : findDuplicateSellMatch(candidate, existingAllocations);
  }

  function pickFile(f: File) {
    setFile(f);
    setOutcome(null);
    setDuplicateOf(null);
    setAddedTickers(new Set());
    setAcceptedVerifications(new Set());
    setStage("idle");
    setStatusMessage("");
  }

  async function runImport() {
    if (!file) return;
    setStage("reading");
    setStatusMessage("Running OCR and parsing document…");
    try {
      const result = await importOrchestrator.importFile(file);

      const existingUpload = await repos.uploads.getByHash(portfolioId, result.fileHash);
      if (existingUpload) {
        setDuplicateOf(existingUpload);
      } else {
        const upload: Upload = {
          id: generateId(),
          portfolioId,
          fileName: file.name,
          fileHash: result.fileHash,
          contentType: file.type || "application/octet-stream",
          status: result.status === "failed" ? "failed" : "parsed",
          candidates: result.candidates,
          rawText: result.rawText,
          createdAt: new Date().toISOString(),
          parsedAt: new Date().toISOString(),
        };
        await repos.uploads.save(upload);
      }

      setOutcome(result);
      setStage("done");
      setStatusMessage("");
    } catch (e) {
      setStage("error");
      setStatusMessage(e instanceof Error ? e.message : "Import failed.");
    }
  }

  async function addBuyCandidate(index: number, candidate: ParsedTradeCandidate) {
    const ticker = normalizeTicker(candidate.ticker);
    // recordBuy already debits portfolio cash and writes the Buy timeline event.
    await recordBuy(repos, {
      portfolioId,
      ticker,
      shares: candidate.shares,
      entryPrice: candidate.price,
      fees: candidate.fees ?? 0,
      executionDate: candidate.date,
      executionTime: candidate.time ?? "00:00",
      notes: "Imported from screenshot/PDF",
    });
    setAddedTickers((prev) => new Set(prev).add(index));
  }

  async function acceptVerification(index: number, verification: ImportResult["verifications"][number]) {
    await repos.verifications.save({
      ...verification,
      id: generateId(),
      portfolioId,
      ticker: normalizeTicker(verification.ticker),
    });
    setAcceptedVerifications((prev) => new Set(prev).add(index));
  }

  return (
    <div>
      <PageHeader
        title="Import"
        description="Drop a broker statement screenshot or PDF and turn it into trades and position checks."
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) pickFile(dropped);
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragOver ? "border-cyan-400 bg-cyan-500/5" : "border-slate-800 bg-slate-900/40"
        }`}
      >
        <UploadCloud size={32} className="text-slate-500" />
        <div>
          <p className="text-sm font-medium text-slate-200">Drag & drop a screenshot or PDF here</p>
          <p className="text-xs text-slate-500">or</p>
        </div>
        <label className="cursor-pointer rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400">
          Choose file
          <input
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFile(f);
            }}
          />
        </label>
        {file ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-300">
            <FileText size={14} /> {file.name}
          </div>
        ) : null}
        {file ? (
          <button
            onClick={() => void runImport()}
            disabled={stage === "reading"}
            className="mt-2 flex items-center gap-2 rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {stage === "reading" ? <Loader2 size={14} className="animate-spin" /> : null}
            {stage === "reading" ? statusMessage || "Processing…" : "Run Import"}
          </button>
        ) : null}
        {stage === "error" ? <p className="text-sm text-rose-400">{statusMessage}</p> : null}
      </div>

      {outcome ? (
        <div className="mt-6 space-y-6">
          {duplicateOf ? (
            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4 text-sm text-cyan-200/80">
              This file matches a previously imported upload ({formatDate(duplicateOf.createdAt)}) — showing the freshly
              parsed result below, but it was not saved as a new upload.
            </div>
          ) : null}

          {outcome.warnings.length > 0 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
                <AlertTriangle size={16} /> Warnings
              </p>
              <ul className="list-inside list-disc space-y-1 text-sm text-amber-200/80">
                {outcome.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="border-b border-slate-800 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-200">
                Parsed Candidates {outcome.docType ? `· ${outcome.docType}` : ""}
              </h3>
            </div>
            {outcome.candidates.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No trade candidates were detected in this document.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Ticker</th>
                    <th className="px-4 py-2">Side</th>
                    <th className="px-4 py-2 text-right">Shares</th>
                    <th className="px-4 py-2 text-right">Price</th>
                    <th className="px-4 py-2 text-right">Fees</th>
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {outcome.candidates.map((c, i) => {
                    const match = duplicateMatch(c);
                    return (
                    <tr key={i}>
                      <td className="px-4 py-2.5 font-medium text-slate-100">
                        {normalizeTicker(c.ticker)}
                        {match ? (
                          <span
                            title={
                              match.matchType === "exact"
                                ? "Same ticker, date, shares and price as an existing trade."
                                : "Same ticker, date and shares as an existing trade, but a different price — may be the same trade parsed twice."
                            }
                            className={`ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              match.matchType === "exact"
                                ? "bg-rose-500/10 text-rose-400"
                                : "bg-amber-500/10 text-amber-400"
                            }`}
                          >
                            <ShieldAlert size={11} /> {match.matchType === "exact" ? "Duplicate" : "Possible duplicate"}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            c.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                          }`}
                        >
                          {c.side}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatShares(c.shares)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatMoney(c.price)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatMoney(c.fees ?? 0)}</td>
                      <td className="px-4 py-2.5 text-slate-300">{formatDate(c.date)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {addedTickers.has(i) ? (
                          <span className="flex items-center justify-end gap-1 text-xs text-emerald-400">
                            <CheckCircle2 size={14} /> Added
                          </span>
                        ) : c.side === "BUY" ? (
                          <button
                            onClick={() => void addBuyCandidate(i, c)}
                            className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400"
                          >
                            {match ? "Add anyway" : "Add as Trade"}
                          </button>
                        ) : (
                          <button
                            onClick={() => setSellCandidate({ index: i, candidate: c })}
                            className="rounded-md bg-rose-500 px-3 py-1 text-xs font-medium text-slate-950 hover:bg-rose-400"
                          >
                            {match ? "Allocate anyway" : "Allocate Sell"}
                          </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {outcome.verifications.length > 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60">
              <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
                <ShieldCheck size={16} className="text-cyan-400" />
                <h3 className="text-sm font-semibold text-slate-200">Position Verification</h3>
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Ticker</th>
                    <th className="px-4 py-2 text-right">Units</th>
                    <th className="px-4 py-2 text-right">Avg Cost</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {outcome.verifications.map((v, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2.5 font-medium text-slate-100">
                        {normalizeTicker(v.ticker)}
                        {v.companyName ? <span className="ml-2 text-xs text-slate-500">{v.companyName}</span> : null}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatShares(v.units)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                        {v.avgCost !== undefined ? formatMoney(v.avgCost) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {acceptedVerifications.has(i) ? (
                          <span className="flex items-center justify-end gap-1 text-xs text-emerald-400">
                            <CheckCircle2 size={14} /> Accepted
                          </span>
                        ) : (
                          <button
                            onClick={() => void acceptVerification(i, v)}
                            className="rounded-md border border-cyan-500/40 px-3 py-1 text-xs font-medium text-cyan-400 hover:bg-cyan-500/10"
                          >
                            Accept as ground truth
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <Modal
        title={`Allocate Sell${sellCandidate ? ` · ${normalizeTicker(sellCandidate.candidate.ticker)}` : ""}`}
        open={sellCandidate !== null}
        onClose={() => setSellCandidate(null)}
        widthClassName="max-w-2xl"
      >
        {sellCandidate ? (
          <SellAllocationForm
            portfolioId={portfolioId}
            ticker={normalizeTicker(sellCandidate.candidate.ticker)}
            initial={{
              exitPrice: sellCandidate.candidate.price,
              fees: sellCandidate.candidate.fees ?? 0,
              executionDate: sellCandidate.candidate.date,
              executionTime: sellCandidate.candidate.time,
            }}
            onDone={() => {
              setAddedTickers((prev) => new Set(prev).add(sellCandidate.index));
              setSellCandidate(null);
            }}
            onCancel={() => setSellCandidate(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

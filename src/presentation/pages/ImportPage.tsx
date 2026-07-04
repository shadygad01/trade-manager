import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { UploadCloud, FileText, ShieldCheck, ShieldAlert, CheckCircle2, Loader2 } from "lucide-react";
import { repos, getImportOrchestrator } from "@presentation/lib/data";
import { recordBuy } from "@application/services/TradeService";
import { findDuplicateBuyMatch, findDuplicateSellMatch } from "@application/services/duplicateDetection";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { ParsedTradeCandidate, Upload } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { PageHeader } from "@presentation/components/PageHeader";
import { Modal } from "@presentation/components/Modal";
import { EmptyState } from "@presentation/components/EmptyState";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { STATUS } from "@presentation/lib/chartColors";

const CONFIDENCE_STYLE: Record<"high" | "medium" | "low", { label: string; color: string }> = {
  high: { label: "High", color: STATUS.good },
  medium: { label: "Medium", color: STATUS.warning },
  low: { label: "Low", color: STATUS.critical },
};

type Stage = "idle" | "reading" | "error";
type VerificationDraft = Omit<PositionVerification, "id" | "portfolioId">;

interface CandidateEntry {
  key: string;
  candidate: ParsedTradeCandidate;
}
interface VerificationEntry {
  key: string;
  verification: VerificationDraft;
}

/**
 * Import runs as a strict two-phase workflow: (1) extract — drop as many
 * files as needed; every candidate/verification accumulates into one pool,
 * confirmed complete by the running "N transactions from M files" count —
 * then (2) distribute — group everything by ticker and assign ONE portfolio
 * per ticker, so a stock's sells automatically travel with its buys to the
 * same portfolio (they're the same decision, not two).
 */
export function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [uploadSeq, setUploadSeq] = useState(0);
  const [filesProcessed, setFilesProcessed] = useState(0);
  const [lastFileWarnings, setLastFileWarnings] = useState<{ fileName: string; warnings: string[]; duplicate: boolean } | null>(null);

  const [pendingCandidates, setPendingCandidates] = useState<CandidateEntry[]>([]);
  const [pendingVerifications, setPendingVerifications] = useState<VerificationEntry[]>([]);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(new Set());
  const [sellCandidate, setSellCandidate] = useState<{ key: string; ticker: string; portfolioId: string; candidate: ParsedTradeCandidate } | null>(null);

  // One portfolio choice per ticker — shared by every buy, sell and
  // verification row for that ticker, so assigning a ticker's buys to a
  // portfolio automatically carries its sells along.
  const [tickerPortfolio, setTickerPortfolio] = useState<Record<string, string>>({});

  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []) ?? [];

  // Loaded across every portfolio so a candidate is flagged as a possible
  // duplicate regardless of which portfolio it's ultimately assigned to.
  const existingTrades = useLiveQuery(() => repos.trades.getAll(), []) ?? [];
  const existingAllocations = useLiveQuery(() => repos.allocations.getAll(), []) ?? [];

  function duplicateMatch(candidate: ParsedTradeCandidate) {
    return candidate.side === "BUY"
      ? findDuplicateBuyMatch(candidate, existingTrades)
      : findDuplicateSellMatch(candidate, existingAllocations);
  }

  function portfolioForTicker(ticker: string): string {
    return tickerPortfolio[ticker] ?? portfolios[0]?.id ?? "";
  }

  async function runImport() {
    if (!file) return;
    setStage("reading");
    setStatusMessage("Running OCR and parsing document…");
    try {
      const orchestrator = await getImportOrchestrator();
      const result = await orchestrator.importFile(file);
      const existingUpload = await repos.uploads.getByHash(result.fileHash);
      const isDuplicateFile = Boolean(existingUpload);

      if (!isDuplicateFile) {
        const upload: Upload = {
          id: generateId(),
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

        const seq = uploadSeq;
        setUploadSeq((s) => s + 1);
        setPendingCandidates((prev) => [
          ...prev,
          ...result.candidates.map((candidate, i) => ({ key: `${seq}-c${i}`, candidate })),
        ]);
        setPendingVerifications((prev) => [
          ...prev,
          ...result.verifications.map((verification, i) => ({ key: `${seq}-v${i}`, verification })),
        ]);
      }

      setFilesProcessed((n) => n + 1);
      setLastFileWarnings({ fileName: file.name, warnings: result.warnings, duplicate: isDuplicateFile });
      setFile(null);
      setStage("idle");
      setStatusMessage("");
    } catch (e) {
      setStage("error");
      setStatusMessage(e instanceof Error ? e.message : "Import failed.");
    }
  }

  async function addBuyCandidate(entry: CandidateEntry, ticker: string) {
    const portfolioId = portfolioForTicker(ticker);
    await recordBuy(repos, {
      portfolioId,
      ticker,
      companyName: entry.candidate.companyName,
      shares: entry.candidate.shares,
      entryPrice: entry.candidate.price,
      fees: entry.candidate.fees ?? 0,
      taxes: entry.candidate.taxes ?? 0,
      executionDate: entry.candidate.date,
      executionTime: entry.candidate.time ?? "00:00",
      notes: "Imported from screenshot/PDF",
    });
    setAddedKeys((prev) => new Set(prev).add(entry.key));
  }

  async function acceptVerification(entry: VerificationEntry, ticker: string) {
    const portfolioId = portfolioForTicker(ticker);
    await repos.verifications.save({
      ...entry.verification,
      id: generateId(),
      portfolioId,
      ticker: normalizeTicker(entry.verification.ticker),
    });
    setAcceptedKeys((prev) => new Set(prev).add(entry.key));
  }

  const tickerGroups = useMemo(() => {
    const map = new Map<string, { buys: CandidateEntry[]; sells: CandidateEntry[]; verifications: VerificationEntry[] }>();
    const group = (ticker: string) => {
      const t = normalizeTicker(ticker);
      const g = map.get(t) ?? { buys: [], sells: [], verifications: [] };
      map.set(t, g);
      return g;
    };
    for (const entry of pendingCandidates) {
      const g = group(entry.candidate.ticker);
      (entry.candidate.side === "BUY" ? g.buys : g.sells).push(entry);
    }
    for (const entry of pendingVerifications) {
      group(entry.verification.ticker).verifications.push(entry);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pendingCandidates, pendingVerifications]);

  const totalPending = pendingCandidates.length + pendingVerifications.length;

  return (
    <div>
      <PageHeader
        title="Import"
        description="Step 1: extract every transaction from as many screenshots/PDFs/CSVs as you need. Step 2: assign each stock to a portfolio."
      />

      {portfolios.length === 0 ? (
        <EmptyState
          title="Create a portfolio first"
          description="Distributing extracted trades needs at least one portfolio to assign them to."
          action={
            <Link href="/portfolios" className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              Create a portfolio
            </Link>
          }
        />
      ) : null}

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Step 1 — Extract</h3>
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
            if (dropped) setFile(dropped);
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragOver ? "border-cyan-400 bg-cyan-500/5" : "border-slate-800 bg-slate-950/40"
          }`}
        >
          <UploadCloud size={28} className="text-slate-500" />
          <p className="text-sm font-medium text-slate-200">Drag & drop a screenshot, PDF, or CSV here</p>
          <p className="text-xs text-slate-500">or</p>
          <label className="cursor-pointer rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400">
            Choose file
            <input
              type="file"
              accept="image/*,application/pdf,text/csv,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {file ? (
            <div className="mt-1 flex items-center gap-2 text-sm text-slate-300">
              <FileText size={14} /> {file.name}
            </div>
          ) : null}
          {file ? (
            <button
              onClick={() => void runImport()}
              disabled={stage === "reading"}
              className="mt-1 flex items-center gap-2 rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {stage === "reading" ? <Loader2 size={14} className="animate-spin" /> : null}
              {stage === "reading" ? statusMessage || "Processing…" : "Extract transactions"}
            </button>
          ) : null}
          {stage === "error" ? <p className="text-sm text-rose-400">{statusMessage}</p> : null}
        </div>

        {lastFileWarnings ? (
          <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
            <span className="font-medium text-slate-300">{lastFileWarnings.fileName}</span>
            {lastFileWarnings.duplicate ? (
              <span className="ml-2 text-cyan-400">already imported before — skipped as a duplicate file.</span>
            ) : lastFileWarnings.warnings.length > 0 ? (
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-300/80">
                {lastFileWarnings.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <span className="ml-2 text-emerald-400">extracted successfully.</span>
            )}
          </div>
        ) : null}

        <p className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          {totalPending > 0 ? <CheckCircle2 size={15} className="text-emerald-400" /> : null}
          <span className="font-medium">{totalPending}</span> transaction{totalPending === 1 ? "" : "s"} extracted so far
          {filesProcessed > 0 ? ` from ${filesProcessed} file${filesProcessed === 1 ? "" : "s"}` : ""}. Drop another file, or
          move on to Step 2 once you're done.
        </p>
      </div>

      {tickerGroups.length > 0 ? (
        <div className="mt-4 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200">Step 2 — Distribute to portfolios</h3>
          {tickerGroups.map(([ticker, group]) => (
            <TickerGroupCard
              key={ticker}
              ticker={ticker}
              group={group}
              portfolios={portfolios}
              portfolioId={portfolioForTicker(ticker)}
              onPortfolioChange={(portfolioId) => setTickerPortfolio((prev) => ({ ...prev, [ticker]: portfolioId }))}
              addedKeys={addedKeys}
              acceptedKeys={acceptedKeys}
              duplicateMatch={duplicateMatch}
              onAddBuy={(entry) => void addBuyCandidate(entry, ticker)}
              onAllocateSell={(entry) => setSellCandidate({ key: entry.key, ticker, portfolioId: portfolioForTicker(ticker), candidate: entry.candidate })}
              onAcceptVerification={(entry) => void acceptVerification(entry, ticker)}
            />
          ))}
        </div>
      ) : null}

      <Modal
        title={`Allocate Sell${sellCandidate ? ` · ${sellCandidate.ticker}` : ""}`}
        open={sellCandidate !== null}
        onClose={() => setSellCandidate(null)}
        widthClassName="max-w-2xl"
      >
        {sellCandidate ? (
          <SellAllocationForm
            portfolioId={sellCandidate.portfolioId}
            ticker={sellCandidate.ticker}
            initial={{
              exitPrice: sellCandidate.candidate.price,
              fees: sellCandidate.candidate.fees ?? 0,
              taxes: sellCandidate.candidate.taxes ?? 0,
              executionDate: sellCandidate.candidate.date,
              executionTime: sellCandidate.candidate.time,
            }}
            onDone={() => {
              setAddedKeys((prev) => new Set(prev).add(sellCandidate.key));
              setSellCandidate(null);
            }}
            onCancel={() => setSellCandidate(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function TickerGroupCard({
  ticker,
  group,
  portfolios,
  portfolioId,
  onPortfolioChange,
  addedKeys,
  acceptedKeys,
  duplicateMatch,
  onAddBuy,
  onAllocateSell,
  onAcceptVerification,
}: {
  ticker: string;
  group: { buys: CandidateEntry[]; sells: CandidateEntry[]; verifications: VerificationEntry[] };
  portfolios: { id: string; name: string }[];
  portfolioId: string;
  onPortfolioChange: (portfolioId: string) => void;
  addedKeys: Set<string>;
  acceptedKeys: Set<string>;
  duplicateMatch: (candidate: ParsedTradeCandidate) => { matchType: "exact" | "possible"; matchedId: string } | undefined;
  onAddBuy: (entry: CandidateEntry) => void;
  onAllocateSell: (entry: CandidateEntry) => void;
  onAcceptVerification: (entry: VerificationEntry) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h4 className="text-sm font-semibold text-slate-100">{ticker}</h4>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Portfolio
          <select
            value={portfolioId}
            onChange={(e) => onPortfolioChange(e.target.value)}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
          >
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="divide-y divide-slate-800">
        {group.buys.map((entry) => {
          const match = duplicateMatch(entry.candidate);
          const added = addedKeys.has(entry.key);
          return (
            <CandidateRow
              key={entry.key}
              entry={entry}
              match={match}
              added={added}
              actionLabel={match ? "Add anyway" : "Add as Trade"}
              actionClassName="bg-emerald-500 hover:bg-emerald-400"
              onAction={() => onAddBuy(entry)}
            />
          );
        })}
        {group.sells.map((entry) => {
          const match = duplicateMatch(entry.candidate);
          const added = addedKeys.has(entry.key);
          return (
            <CandidateRow
              key={entry.key}
              entry={entry}
              match={match}
              added={added}
              actionLabel={match ? "Allocate anyway" : "Allocate Sell"}
              actionClassName="bg-rose-500 hover:bg-rose-400"
              onAction={() => onAllocateSell(entry)}
            />
          );
        })}
        {group.verifications.map((entry) => (
          <div key={entry.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2 text-slate-300">
              <ShieldCheck size={14} className="text-cyan-400" />
              Broker position check: {formatShares(entry.verification.units)} units
              {entry.verification.avgCost !== undefined ? ` @ ${formatMoney(entry.verification.avgCost)} avg` : ""}
            </span>
            {acceptedKeys.has(entry.key) ? (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <CheckCircle2 size={14} /> Accepted
              </span>
            ) : (
              <button
                onClick={() => onAcceptVerification(entry)}
                className="rounded-md border border-cyan-500/40 px-3 py-1 text-xs font-medium text-cyan-400 hover:bg-cyan-500/10"
              >
                Accept as ground truth
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CandidateRow({
  entry,
  match,
  added,
  actionLabel,
  actionClassName,
  onAction,
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
  actionLabel: string;
  actionClassName: string;
  onAction: () => void;
}) {
  const c = entry.candidate;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            c.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
          }`}
        >
          {c.side}
        </span>
        <span className="tabular-nums text-slate-300">{formatShares(c.shares)} sh</span>
        <span className="tabular-nums text-slate-300">@ {formatMoney(c.price)}</span>
        <span className="text-slate-400">{formatDate(c.date)}</span>
        {c.confidence ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_STYLE[c.confidence].color }} />
            {CONFIDENCE_STYLE[c.confidence].label}
          </span>
        ) : null}
        {match ? (
          <span
            title={
              match.matchType === "exact"
                ? "Same ticker, date, shares and price as an existing trade."
                : "Same ticker, date and shares as an existing trade, but a different price."
            }
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
            }`}
          >
            <ShieldAlert size={11} /> {match.matchType === "exact" ? "Duplicate" : "Possible duplicate"}
          </span>
        ) : null}
      </div>
      {added ? (
        <span className="flex items-center gap-1 text-xs text-emerald-400">
          <CheckCircle2 size={14} /> Added
        </span>
      ) : (
        <button onClick={onAction} className={`rounded-md px-3 py-1 text-xs font-medium text-slate-950 ${actionClassName}`}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

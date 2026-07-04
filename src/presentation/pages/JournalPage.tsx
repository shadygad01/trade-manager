import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import { BookOpen, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { createJournalEntry } from "@domain/entities/JournalEntry";
import { generateId } from "@domain/value-objects/id";
import type { Trade } from "@domain/entities/Trade";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function JournalPage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);

  const trades = useLiveQuery(async () => {
    const all = await repos.trades.getByPortfolio(portfolioId);
    return [...all].sort((a, b) => b.executionDate.localeCompare(a.executionDate));
  }, [portfolioId]);

  const entries = useLiveQuery(() => repos.journal.getByPortfolio(portfolioId), [portfolioId]);

  const entryByTrade = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const e of entries ?? []) map.set(e.tradeId, true);
    return map;
  }, [entries]);

  const activeTradeId = selectedTradeId ?? trades?.[0]?.id ?? null;
  const activeTrade = trades?.find((t) => t.id === activeTradeId);

  return (
    <div>
      <PageHeader title="Journal" description="Reflections per trade: why you took it, why you exited, and what you learned." />

      {!trades || trades.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={28} />}
          title="No trades to journal yet"
          description="Record a buy trade first, then come back here to journal it."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-800">
              {trades.map((trade) => (
                <button
                  key={trade.id}
                  onClick={() => setSelectedTradeId(trade.id)}
                  className={`block w-full px-4 py-3 text-left transition-colors ${
                    trade.id === activeTradeId ? "bg-cyan-500/10" : "hover:bg-slate-800/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-100">{trade.ticker}</span>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        entryByTrade.has(trade.id) ? "bg-cyan-400" : "bg-slate-700"
                      }`}
                    />
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatDate(trade.executionDate)} · {formatShares(trade.shares)} @ {formatMoney(trade.entryPrice)}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {activeTrade ? (
            <JournalEditor key={activeTrade.id} portfolioId={portfolioId} trade={activeTrade} />
          ) : (
            <EmptyState title="Select a trade" description="Pick a trade from the list to view or write its journal entry." />
          )}
        </div>
      )}
    </div>
  );
}

function JournalEditor({ portfolioId, trade }: { portfolioId: string; trade: Trade }) {
  const existing = useLiveQuery(() => repos.journal.getByTrade(trade.id), [trade.id]);

  const [entryReason, setEntryReason] = useState("");
  const [exitReason, setExitReason] = useState("");
  const [lessonsLearned, setLessonsLearned] = useState("");
  const [notes, setNotes] = useState("");
  const [strategyTags, setStrategyTags] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (existing !== undefined && hydratedFor !== trade.id) {
    setHydratedFor(trade.id);
    setEntryReason(existing?.entryReason ?? "");
    setExitReason(existing?.exitReason ?? "");
    setLessonsLearned(existing?.lessonsLearned ?? "");
    setNotes(existing?.notes ?? "");
    setStrategyTags((existing?.strategyTags ?? []).join(", "));
    setImages(existing?.images ?? []);
    setAttachments(existing?.attachments ?? []);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const base = existing ?? createJournalEntry({ id: generateId(), tradeId: trade.id, portfolioId });
      await repos.journal.save({
        ...base,
        entryReason: entryReason.trim() || undefined,
        exitReason: exitReason.trim() || undefined,
        lessonsLearned: lessonsLearned.trim() || undefined,
        notes: notes.trim() || undefined,
        strategyTags: strategyTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        images,
        attachments,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleAddImage(file: File) {
    const dataUrl = await readAsDataUrl(file);
    setImages((prev) => [...prev, dataUrl]);
  }

  async function handleAddAttachment(file: File) {
    const dataUrl = await readAsDataUrl(file);
    setAttachments((prev) => [...prev, `${file.name}::${dataUrl}`]);
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-100">
            {trade.ticker} · {formatShares(trade.shares)} @ {formatMoney(trade.entryPrice)}
          </p>
          <p className="text-xs text-slate-500">{formatDate(trade.executionDate)}</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Entry"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-400 space-y-1">
          Entry reason
          <textarea
            value={entryReason}
            onChange={(e) => setEntryReason(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Exit reason
          <textarea
            value={exitReason}
            onChange={(e) => setExitReason(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="sm:col-span-2 text-xs text-slate-400 space-y-1">
          Lessons learned
          <textarea
            value={lessonsLearned}
            onChange={(e) => setLessonsLearned(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="sm:col-span-2 text-xs text-slate-400 space-y-1">
          Strategy tags (comma separated)
          <input
            value={strategyTags}
            onChange={(e) => setStrategyTags(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="sm:col-span-2 text-xs text-slate-400 space-y-1">
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <ImageIcon size={13} /> Images
            </p>
            <label className="cursor-pointer text-xs text-cyan-400 hover:text-cyan-300">
              Add
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleAddImage(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {images.length === 0 ? (
            <p className="text-xs text-slate-600">No images attached.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((src, i) => (
                <div key={i} className="group relative overflow-hidden rounded-md border border-slate-800">
                  <img src={src} alt="Journal attachment" className="h-20 w-full object-cover" />
                  <button
                    onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute right-1 top-1 rounded-full bg-slate-950/80 p-0.5 text-slate-300 opacity-0 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Paperclip size={13} /> Attachments
            </p>
            <label className="cursor-pointer text-xs text-cyan-400 hover:text-cyan-300">
              Add
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleAddAttachment(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {attachments.length === 0 ? (
            <p className="text-xs text-slate-600">No attachments.</p>
          ) : (
            <ul className="space-y-1">
              {attachments.map((entry, i) => {
                const [name] = entry.split("::");
                return (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-md border border-slate-800 px-2 py-1 text-xs text-slate-300"
                  >
                    <span className="truncate">{name}</span>
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      <X size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

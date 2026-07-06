import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import { BookOpen, Image as ImageIcon, Paperclip, X, Lightbulb, Download } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { createJournalEntry, type JournalEntry } from "@domain/entities/JournalEntry";
import { generateId } from "@domain/value-objects/id";
import type { Trade } from "@domain/entities/Trade";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

type JournalTab = "byTrade" | "lessons";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function JournalPage() {
  const t = useT();
  const { id: portfolioId } = useParams<{ id: string }>();
  const portfolio = useLiveQuery(() => repos.portfolios.getById(portfolioId), [portfolioId]);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [tab, setTab] = useState<JournalTab>("byTrade");

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

  const tradesById = useMemo(() => new Map((trades ?? []).map((t) => [t.id, t])), [trades]);

  const lessons = useMemo(() => {
    return (entries ?? [])
      .filter((e) => e.lessonsLearned && e.lessonsLearned.trim().length > 0)
      .map((e) => ({ entry: e, trade: tradesById.get(e.tradeId) }))
      .filter((row): row is { entry: JournalEntry; trade: Trade } => row.trade !== undefined)
      .sort((a, b) => b.trade.executionDate.localeCompare(a.trade.executionDate));
  }, [entries, tradesById]);

  const activeTradeId = selectedTradeId ?? trades?.[0]?.id ?? null;
  const activeTrade = trades?.find((t) => t.id === activeTradeId);

  return (
    <div>
      <PageHeader
        title={portfolio ? t("journal.titleWithPortfolio", { name: portfolio.name }) : t("journal.title")}
        description={t("journal.description")}
        actions={
          <div className="flex rounded-md border border-slate-700 p-0.5 text-xs">
            <button
              onClick={() => setTab("byTrade")}
              className={`rounded px-3 py-1.5 ${tab === "byTrade" ? "bg-cyan-500 text-slate-950 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
            >
              {t("journal.byTrade")}
            </button>
            <button
              onClick={() => setTab("lessons")}
              className={`flex items-center gap-1 rounded px-3 py-1.5 ${tab === "lessons" ? "bg-cyan-500 text-slate-950 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
            >
              <Lightbulb size={12} /> {t("journal.lessonsLearned")}
            </button>
          </div>
        }
      />

      {!trades || trades.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={28} />}
          title={t("journal.noTradesTitle")}
          description={t("journal.noTradesDescription")}
        />
      ) : tab === "lessons" ? (
        <LessonsLearnedView lessons={lessons} onOpenTrade={(tradeId) => { setSelectedTradeId(tradeId); setTab("byTrade"); }} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-800">
              {trades.map((trade) => (
                <button
                  key={trade.id}
                  onClick={() => setSelectedTradeId(trade.id)}
                  className={`block w-full px-4 py-3 text-start transition-colors ${
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
            <EmptyState title={t("journal.selectTradeTitle")} description={t("journal.selectTradeDescription")} />
          )}
        </div>
      )}
    </div>
  );
}

function LessonsLearnedView({
  lessons,
  onOpenTrade,
}: {
  lessons: { entry: { lessonsLearned?: string; strategyTags: string[] }; trade: Trade }[];
  onOpenTrade: (tradeId: string) => void;
}) {
  const t = useT();
  if (lessons.length === 0) {
    return (
      <EmptyState
        icon={<Lightbulb size={28} />}
        title={t("journal.noLessonsTitle")}
        description={t("journal.noLessonsDescription")}
      />
    );
  }

  return (
    <div className="space-y-3">
      {lessons.map(({ entry, trade }) => (
        <button
          key={trade.id}
          onClick={() => onOpenTrade(trade.id)}
          className="block w-full rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-start hover:border-slate-700"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-100">
              {trade.ticker}
              {trade.companyName ? <span className="ms-2 text-xs font-normal text-slate-500">{trade.companyName}</span> : null}
            </span>
            <span className="text-xs text-slate-500">{formatDate(trade.executionDate)}</span>
          </div>
          <p className="text-sm text-slate-300">{entry.lessonsLearned}</p>
          {entry.strategyTags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.strategyTags.map((tag) => (
                <span key={tag} className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function JournalEditor({ portfolioId, trade }: { portfolioId: string; trade: Trade }) {
  const t = useT();
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
          {saving ? t("journal.saving") : t("journal.saveEntry")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-400 space-y-1">
          {t("journal.entryReason")}
          <textarea
            value={entryReason}
            onChange={(e) => setEntryReason(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("journal.exitReason")}
          <textarea
            value={exitReason}
            onChange={(e) => setExitReason(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="sm:col-span-2 text-xs text-slate-400 space-y-1">
          {t("journal.lessonsLearnedLabel")}
          <textarea
            value={lessonsLearned}
            onChange={(e) => setLessonsLearned(e.target.value)}
            rows={3}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="sm:col-span-2 text-xs text-slate-400 space-y-1">
          {t("journal.strategyTagsLabel")}
          <input
            value={strategyTags}
            onChange={(e) => setStrategyTags(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="sm:col-span-2 text-xs text-slate-400 space-y-1">
          {t("journal.notesLabel")}
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
              <ImageIcon size={13} /> {t("journal.images")}
            </p>
            <label className="cursor-pointer text-xs text-cyan-400 hover:text-cyan-300">
              {t("journal.add")}
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
            <p className="text-xs text-slate-600">{t("journal.noImages")}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((src, i) => (
                <div key={i} className="group relative overflow-hidden rounded-md border border-slate-800">
                  <a href={src} target="_blank" rel="noopener noreferrer" title={t("journal.openFullSize")}>
                    <img src={src} alt="Journal attachment" className="h-20 w-full cursor-pointer object-cover" />
                  </a>
                  <div className="absolute end-1 top-1 flex gap-1 opacity-0 group-hover:opacity-100">
                    <a
                      href={src}
                      download={`journal-image-${i + 1}.png`}
                      title={t("journal.saveToDevice")}
                      className="rounded-full bg-slate-950/80 p-0.5 text-slate-300 hover:text-cyan-400"
                    >
                      <Download size={12} />
                    </a>
                    <button
                      onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                      title={t("journal.remove")}
                      className="rounded-full bg-slate-950/80 p-0.5 text-slate-300 hover:text-rose-400"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Paperclip size={13} /> {t("journal.attachments")}
            </p>
            <label className="cursor-pointer text-xs text-cyan-400 hover:text-cyan-300">
              {t("journal.add")}
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
            <p className="text-xs text-slate-600">{t("journal.noAttachments")}</p>
          ) : (
            <ul className="space-y-1">
              {attachments.map((entry, i) => {
                const sep = entry.indexOf("::");
                const name = entry.slice(0, sep);
                const dataUrl = entry.slice(sep + 2);
                return (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-md border border-slate-800 px-2 py-1 text-xs text-slate-300"
                  >
                    <a
                      href={dataUrl}
                      download={name}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t("journal.openSaveToDevice")}
                      className="flex-1 truncate hover:text-cyan-400"
                    >
                      {name}
                    </a>
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      className="ms-2 shrink-0 text-slate-500 hover:text-rose-400"
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

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "wouter";
import { Plus, Briefcase, ArrowRight, Archive, ArchiveRestore, ChevronDown, ChevronRight, ShieldAlert, FolderSymlink } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { createPortfolioAndSave, unarchivePortfolio } from "@application/services/PortfolioService";
import type { Portfolio, PortfolioKind } from "@domain/entities/Portfolio";
import {
  computePositions,
  findTickersSplitAcrossPortfolios,
  consolidateTicker,
  findMisnamedTickers,
  renameTickerEverywhere,
  type SplitTickerEntry,
  type MisnamedTickerEntry,
} from "@application/services/TradeService";
import { PageHeader } from "@presentation/components/PageHeader";
import { PriceFreshness } from "@presentation/components/PriceFreshness";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { formatMoney, formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

const KINDS: PortfolioKind[] = ["Investment", "Trading", "Swing", "Experiments", "Retirement", "Education", "Custom"];

export function PortfoliosPage() {
  const t = useT();
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []);
  const [modalOpen, setModalOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const { active, archived } = useMemo(() => {
    const active: Portfolio[] = [];
    const archived: Portfolio[] = [];
    for (const p of portfolios ?? []) {
      (p.archivedAt ? archived : active).push(p);
    }
    return { active, archived };
  }, [portfolios]);

  const summaries = useLiveQuery(async () => {
    if (!portfolios) return undefined;
    const priceMap = await repos.prices.getAllPrices();
    const map = new Map<string, number>();
    for (const p of portfolios) {
      const positions = await computePositions(repos, p.id, priceMap);
      const marketValue = positions.reduce((sum: number, pos) => sum + (pos.marketValue ?? pos.costBasis), 0);
      map.set(p.id, marketValue);
    }
    return map;
  }, [portfolios]);

  const splitTickers = useLiveQuery(async () => {
    const trades = await repos.trades.getAll();
    return findTickersSplitAcrossPortfolios(trades);
  }, []);

  const misnamedTickers = useLiveQuery(async () => {
    const trades = await repos.trades.getAll();
    return findMisnamedTickers(trades);
  }, []);

  return (
    <div>
      <PageHeader
        title={t("portfolios.title")}
        description={t("portfolios.description")}
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400"
          >
            <Plus size={16} /> {t("portfolios.newPortfolio")}
          </button>
        }
      />
      <PriceFreshness />

      {misnamedTickers && misnamedTickers.length > 0 ? (
        <MisnamedTickersBanner misnamedTickers={misnamedTickers} />
      ) : null}

      {splitTickers && splitTickers.length > 0 ? (
        <SplitTickersBanner splitTickers={splitTickers} portfolios={portfolios ?? []} />
      ) : null}

      {portfolios && active.length === 0 && archived.length === 0 ? (
        <EmptyState
          icon={<Briefcase size={28} />}
          title={t("portfolios.noPortfoliosTitle")}
          description={t("portfolios.noPortfoliosDescription")}
          action={
            <button
              onClick={() => setModalOpen(true)}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950"
            >
              {t("portfolios.createFirstPortfolio")}
            </button>
          }
        />
      ) : portfolios && active.length === 0 ? (
        <EmptyState
          icon={<Archive size={28} />}
          title={t("portfolios.noActiveTitle")}
          description={t("portfolios.allArchivedDescription", { n: archived.length })}
          action={
            <button onClick={() => setShowArchived(true)} className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              {t("portfolios.showArchived")}
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((p) => (
            <PortfolioCard key={p.id} portfolio={p} marketValue={summaries?.get(p.id) ?? 0} />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <div className="mt-6">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
          >
            {showArchived ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t("portfolios.archivedCount", { n: archived.length })}
          </button>
          {showArchived ? (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((p) => (
                <PortfolioCard key={p.id} portfolio={p} marketValue={summaries?.get(p.id) ?? 0} archived />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <CreatePortfolioModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

function SplitTickersBanner({
  splitTickers,
  portfolios,
}: {
  splitTickers: SplitTickerEntry[];
  portfolios: Portfolio[];
}) {
  const t = useT();
  const portfolioName = (id: string) => portfolios.find((p) => p.id === id)?.name ?? "?";
  const [targetByTicker, setTargetByTicker] = useState<Record<string, string>>({});
  const [consolidating, setConsolidating] = useState<string | null>(null);
  const [error, setError] = useState<{ ticker: string; message: string } | null>(null);

  async function handleConsolidate(entry: SplitTickerEntry) {
    // Defaults to whichever portfolio already holds the most shares — the
    // smaller holding(s) are more likely the accidental one to fold in.
    const defaultTarget = [...entry.portfolios].sort((a, b) => b.shares - a.shares)[0].portfolioId;
    const target = targetByTicker[entry.ticker] ?? defaultTarget;
    if (!confirm(t("portfolios.consolidateConfirm", { ticker: entry.ticker, target: portfolioName(target) }))) {
      return;
    }
    setError(null);
    setConsolidating(entry.ticker);
    try {
      await consolidateTicker(repos, entry.ticker, target);
    } catch (e) {
      setError({ ticker: entry.ticker, message: e instanceof Error ? e.message : t("portfolios.consolidationFailed") });
    } finally {
      setConsolidating(null);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
        <ShieldAlert size={16} /> {t("portfolios.splitBannerTitle")}
      </p>
      <p className="mb-3 text-xs text-amber-300/70">
        {t("portfolios.splitBannerDescription")}
      </p>
      <ul className="space-y-2">
        {splitTickers.map((entry) => {
          const defaultTarget = [...entry.portfolios].sort((a, b) => b.shares - a.shares)[0].portfolioId;
          const target = targetByTicker[entry.ticker] ?? defaultTarget;
          return (
            <li key={entry.ticker} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-900/40 px-3 py-2 text-sm">
              <span className="text-slate-200">
                <span className="font-semibold">{entry.ticker}</span>{" "}
                <span className="text-slate-400">
                  ({entry.portfolios.map((p) => `${formatShares(p.shares)} sh in ${portfolioName(p.portfolioId)}`).join(", ")})
                </span>
              </span>
              <span className="flex items-center gap-2">
                <select
                  value={target}
                  onChange={(e) => setTargetByTicker((prev) => ({ ...prev, [entry.ticker]: e.target.value }))}
                  className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
                >
                  {entry.portfolios.map((p) => (
                    <option key={p.portfolioId} value={p.portfolioId}>
                      {t("portfolios.consolidateInto", { name: portfolioName(p.portfolioId) })}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void handleConsolidate(entry)}
                  disabled={consolidating === entry.ticker}
                  className="flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                >
                  <FolderSymlink size={12} />
                  {consolidating === entry.ticker ? t("portfolios.consolidating") : t("portfolios.consolidate")}
                </button>
              </span>
              {error && error.ticker === entry.ticker ? <p className="w-full text-[11px] text-rose-400">{error.message}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MisnamedTickersBanner({ misnamedTickers }: { misnamedTickers: MisnamedTickerEntry[] }) {
  const t = useT();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<{ ticker: string; message: string } | null>(null);

  async function handleRename(entry: MisnamedTickerEntry) {
    if (!confirm(t("portfolios.renameConfirm", { wrongTicker: entry.wrongTicker, realTicker: entry.realTicker }))) {
      return;
    }
    setError(null);
    setRenaming(entry.wrongTicker);
    try {
      await renameTickerEverywhere(repos, entry.wrongTicker, entry.realTicker);
    } catch (e) {
      setError({ ticker: entry.wrongTicker, message: e instanceof Error ? e.message : t("portfolios.renameFailed") });
    } finally {
      setRenaming(null);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
        <ShieldAlert size={16} /> {t("portfolios.misnamedBannerTitle")}
      </p>
      <p className="mb-3 text-xs text-amber-300/70">
        {t("portfolios.misnamedBannerDescription")}
      </p>
      <ul className="space-y-2">
        {misnamedTickers.map((entry) => (
          <li
            key={entry.wrongTicker}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-900/40 px-3 py-2 text-sm"
          >
            <span className="text-slate-200">
              <span className="font-semibold">"{entry.wrongTicker}"</span>{" "}
              <span className="text-slate-400">
                {t("portfolios.remainingSharesPrefix", { shares: formatShares(entry.shares) })}{" "}
                <span className="font-semibold text-slate-200">{entry.realTicker}</span>
              </span>
            </span>
            <button
              onClick={() => void handleRename(entry)}
              disabled={renaming === entry.wrongTicker}
              className="flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
            >
              <FolderSymlink size={12} />
              {renaming === entry.wrongTicker ? t("portfolios.renaming") : t("portfolios.renameTo", { ticker: entry.realTicker })}
            </button>
            {error && error.ticker === entry.wrongTicker ? <p className="w-full text-[11px] text-rose-400">{error.message}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PortfolioCard({
  portfolio: p,
  marketValue,
  archived,
}: {
  portfolio: Portfolio;
  marketValue: number;
  archived?: boolean;
}) {
  const t = useT();
  return (
    <div className={`group relative rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition-colors hover:border-cyan-500/40 hover:bg-slate-900 ${archived ? "opacity-60" : ""}`}>
      <Link href={`/portfolios/${p.id}`} className="block">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-50">{p.name}</p>
            <span className="mt-1 inline-block rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
              {p.kind === "Custom" ? p.customKindLabel || t("portfolioKind.Custom") : t(`portfolioKind.${p.kind}`)}
            </span>
          </div>
          <ArrowRight size={16} className="text-slate-600 group-hover:text-cyan-400" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t("portfolios.cash")}</p>
            <p className="tabular-nums text-slate-200">{formatMoney(p.cash)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t("portfolios.invested")}</p>
            <p className="tabular-nums text-slate-200">{formatMoney(marketValue)}</p>
          </div>
        </div>
        {p.notes ? <p className="mt-3 line-clamp-2 text-xs text-slate-500">{p.notes}</p> : null}
      </Link>
      {archived ? (
        <button
          onClick={(e) => {
            e.preventDefault();
            void unarchivePortfolio(repos, p.id);
          }}
          className="mt-3 flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          <ArchiveRestore size={12} /> {t("portfolios.unarchive")}
        </button>
      ) : null}
    </div>
  );
}

function CreatePortfolioModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PortfolioKind>("Investment");
  const [customKindLabel, setCustomKindLabel] = useState("");
  const [initialCash, setInitialCash] = useState("0");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setKind("Investment");
    setCustomKindLabel("");
    setInitialCash("0");
    setNotes("");
    setError(null);
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError(t("portfolios.nameRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createPortfolioAndSave(repos, {
        name: name.trim(),
        kind,
        customKindLabel: kind === "Custom" ? customKindLabel.trim() || undefined : undefined,
        initialCash: Number.parseFloat(initialCash) || 0,
        notes: notes.trim() || undefined,
      });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("portfolios.createFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t("portfolios.createModalTitle")}
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolios.nameLabel")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            placeholder={t("portfolios.namePlaceholder")}
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolios.kindLabel")}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PortfolioKind)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`portfolioKind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {kind === "Custom" ? (
          <label className="block text-xs text-slate-400 space-y-1">
            {t("portfolios.customLabelLabel")}
            <input
              value={customKindLabel}
              onChange={(e) => setCustomKindLabel(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        ) : null}
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolios.initialCashLabel")}
          <input
            type="number"
            value={initialCash}
            onChange={(e) => setInitialCash(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolios.notesLabel")}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? t("common.creating") : t("common.create")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

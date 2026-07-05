import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "wouter";
import { Plus, Briefcase, ArrowRight, Archive, ArchiveRestore, ChevronDown, ChevronRight, ShieldAlert, FolderSymlink, Wallet, Pencil } from "lucide-react";
import { repos } from "@presentation/lib/data";
import {
  createPortfolioAndSave,
  unarchivePortfolio,
  findPortfoliosMissingFundingRecord,
  backfillInitialFunding,
  getInitialFundingRecord,
  type MissingFundingEntry,
} from "@application/services/PortfolioService";
import { TRACKING_START_DATE } from "@domain/value-objects/trackingWindow";
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

const KINDS: PortfolioKind[] = ["Investment", "Trading", "Swing", "Experiments", "Retirement", "Education", "Custom"];

/** A portfolio can have been created before the tracking window opened (see TRACKING_START_DATE) — defaulting straight to its createdAt would make backfillInitialFunding reject the very date this page pre-fills. */
function defaultFundingDate(createdAt: string): string {
  const createdDate = createdAt.slice(0, 10);
  return createdDate < TRACKING_START_DATE ? TRACKING_START_DATE : createdDate;
}

export function PortfoliosPage() {
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []);
  const [modalOpen, setModalOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingFundingId, setEditingFundingId] = useState<string | null>(null);

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

  const missingFunding = useLiveQuery(async () => {
    if (!portfolios) return undefined;
    const [trades, allocations, timelineEvents] = await Promise.all([
      repos.trades.getAll(),
      repos.allocations.getAll(),
      repos.timeline.getAll(),
    ]);
    return findPortfoliosMissingFundingRecord(portfolios, trades, allocations, timelineEvents);
  }, [portfolios]);

  return (
    <div>
      <PageHeader
        title="Portfolios"
        description="Every book you track, from long-term investing to short-term swing trades."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400"
          >
            <Plus size={16} /> New Portfolio
          </button>
        }
      />
      <PriceFreshness />

      {missingFunding && missingFunding.length > 0 ? (
        <MissingFundingBanner missingFunding={missingFunding} portfolios={portfolios ?? []} />
      ) : null}

      {misnamedTickers && misnamedTickers.length > 0 ? (
        <MisnamedTickersBanner misnamedTickers={misnamedTickers} />
      ) : null}

      {splitTickers && splitTickers.length > 0 ? (
        <SplitTickersBanner splitTickers={splitTickers} portfolios={portfolios ?? []} />
      ) : null}

      {portfolios && active.length === 0 && archived.length === 0 ? (
        <EmptyState
          icon={<Briefcase size={28} />}
          title="No portfolios yet"
          description="Create a portfolio to start recording trades, cash movements and analytics."
          action={
            <button
              onClick={() => setModalOpen(true)}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950"
            >
              Create your first portfolio
            </button>
          }
        />
      ) : portfolios && active.length === 0 ? (
        <EmptyState
          icon={<Archive size={28} />}
          title="No active portfolios"
          description={`All ${archived.length} portfolio${archived.length === 1 ? " is" : "s are"} archived.`}
          action={
            <button onClick={() => setShowArchived(true)} className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              Show archived
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((p) => (
            <PortfolioCard
              key={p.id}
              portfolio={p}
              marketValue={summaries?.get(p.id) ?? 0}
              onEditFunding={() => setEditingFundingId(p.id)}
            />
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
            Archived ({archived.length})
          </button>
          {showArchived ? (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((p) => (
                <PortfolioCard
                  key={p.id}
                  portfolio={p}
                  marketValue={summaries?.get(p.id) ?? 0}
                  archived
                  onEditFunding={() => setEditingFundingId(p.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <CreatePortfolioModal open={modalOpen} onClose={() => setModalOpen(false)} />

      {editingFundingId
        ? (() => {
            const editingPortfolio = (portfolios ?? []).find((p) => p.id === editingFundingId);
            return editingPortfolio ? (
              <EditStartingBalanceModal portfolio={editingPortfolio} onClose={() => setEditingFundingId(null)} />
            ) : null;
          })()
        : null}
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
  const portfolioName = (id: string) => portfolios.find((p) => p.id === id)?.name ?? "?";
  const [targetByTicker, setTargetByTicker] = useState<Record<string, string>>({});
  const [consolidating, setConsolidating] = useState<string | null>(null);
  const [error, setError] = useState<{ ticker: string; message: string } | null>(null);

  async function handleConsolidate(entry: SplitTickerEntry) {
    // Defaults to whichever portfolio already holds the most shares — the
    // smaller holding(s) are more likely the accidental one to fold in.
    const defaultTarget = [...entry.portfolios].sort((a, b) => b.shares - a.shares)[0].portfolioId;
    const target = targetByTicker[entry.ticker] ?? defaultTarget;
    if (
      !confirm(
        `Move every ${entry.ticker} trade (and any broker verification for it) from every other portfolio into "${portfolioName(target)}"? Cash moves with each trade. This can't be undone.`
      )
    ) {
      return;
    }
    setError(null);
    setConsolidating(entry.ticker);
    try {
      await consolidateTicker(repos, entry.ticker, target);
    } catch (e) {
      setError({ ticker: entry.ticker, message: e instanceof Error ? e.message : "Consolidation failed." });
    } finally {
      setConsolidating(null);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
        <ShieldAlert size={16} /> Stocks split across portfolios
      </p>
      <p className="mb-3 text-xs text-amber-300/70">
        Each of these is held in more than one portfolio — usually a mistake, since a broker account is one real
        position regardless of which portfolio a buy landed in. Consolidating moves every trade for that ticker (and
        any broker verification) into one portfolio.
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
                      Consolidate into {portfolioName(p.portfolioId)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void handleConsolidate(entry)}
                  disabled={consolidating === entry.ticker}
                  className="flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                >
                  <FolderSymlink size={12} />
                  {consolidating === entry.ticker ? "Consolidating…" : "Consolidate"}
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

function MissingFundingBanner({
  missingFunding,
  portfolios,
}: {
  missingFunding: MissingFundingEntry[];
  portfolios: Portfolio[];
}) {
  const [amountByPortfolio, setAmountByPortfolio] = useState<Record<string, string>>({});
  const [dateByPortfolio, setDateByPortfolio] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<{ portfolioId: string; message: string } | null>(null);

  async function handleRecord(entry: MissingFundingEntry) {
    const portfolio = portfolios.find((p) => p.id === entry.portfolioId);
    const amount = Number.parseFloat(amountByPortfolio[entry.portfolioId] ?? String(entry.missingAmount));
    const date = dateByPortfolio[entry.portfolioId] ?? (portfolio ? defaultFundingDate(portfolio.createdAt) : "");
    if (!amount || amount <= 0) {
      setError({ portfolioId: entry.portfolioId, message: "Enter how much cash actually funded this portfolio." });
      return;
    }
    setError(null);
    setRecording(entry.portfolioId);
    try {
      await backfillInitialFunding(repos, entry.portfolioId, amount, date);
    } catch (e) {
      setError({ portfolioId: entry.portfolioId, message: e instanceof Error ? e.message : "Failed to record funding." });
    } finally {
      setRecording(null);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
        <ShieldAlert size={16} /> Portfolios missing an initial funding record
      </p>
      <p className="mb-3 text-xs text-amber-300/70">
        These portfolios hold cash that nothing on their ledger explains — usually because the starting cash was set
        when the portfolio was created, before that got tracked as a dated event. Every realized/dividend % on the
        Dashboard and Analytics pages reads as 0% (or wrong) for these until the true starting capital is recorded
        below. The amount is pre-filled from the exact gap between the cash balance and everything the ledger
        accounts for — review it, adjust if needed, and confirm. This never touches the cash balance already shown
        on the portfolio card — it only backfills the missing dated record the % calculators need.
      </p>
      <ul className="space-y-2">
        {missingFunding.map((entry) => {
          const portfolio = portfolios.find((p) => p.id === entry.portfolioId);
          return (
            <li
              key={entry.portfolioId}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-900/40 px-3 py-2 text-sm"
            >
              <span className="text-slate-200">
                <span className="font-semibold">{entry.portfolioName}</span>
              </span>
              <input
                type="number"
                placeholder="Original funding (EGP)"
                value={amountByPortfolio[entry.portfolioId] ?? String(entry.missingAmount)}
                onChange={(e) => setAmountByPortfolio((prev) => ({ ...prev, [entry.portfolioId]: e.target.value }))}
                className="w-40 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
              />
              <input
                type="date"
                value={dateByPortfolio[entry.portfolioId] ?? (portfolio ? defaultFundingDate(portfolio.createdAt) : "")}
                onChange={(e) => setDateByPortfolio((prev) => ({ ...prev, [entry.portfolioId]: e.target.value }))}
                className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
              />
              <button
                onClick={() => void handleRecord(entry)}
                disabled={recording === entry.portfolioId}
                className="flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
              >
                <Wallet size={12} />
                {recording === entry.portfolioId ? "Recording…" : "Record funding"}
              </button>
              {error && error.portfolioId === entry.portfolioId ? (
                <p className="w-full text-[11px] text-rose-400">{error.message}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MisnamedTickersBanner({ misnamedTickers }: { misnamedTickers: MisnamedTickerEntry[] }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<{ ticker: string; message: string } | null>(null);

  async function handleRename(entry: MisnamedTickerEntry) {
    if (
      !confirm(
        `Rename every "${entry.wrongTicker}" trade to ${entry.realTicker}? This fixes the ticker identity everywhere (trades, sells, timeline, verifications) — nothing else about these rows changes.`
      )
    ) {
      return;
    }
    setError(null);
    setRenaming(entry.wrongTicker);
    try {
      await renameTickerEverywhere(repos, entry.wrongTicker, entry.realTicker);
    } catch (e) {
      setError({ ticker: entry.wrongTicker, message: e instanceof Error ? e.message : "Rename failed." });
    } finally {
      setRenaming(null);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
        <ShieldAlert size={16} /> Tickers filed under the wrong name
      </p>
      <p className="mb-3 text-xs text-amber-300/70">
        These are the same real stock as an already-known EGX ticker, but some trades were recorded under the raw
        company name instead — usually from an import that predates that company being recognized. Renaming fixes
        the identity everywhere (trades, sells, timeline, verifications); nothing about shares/prices/dates changes.
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
                ({formatShares(entry.shares)} sh remaining) is really <span className="font-semibold text-slate-200">{entry.realTicker}</span>
              </span>
            </span>
            <button
              onClick={() => void handleRename(entry)}
              disabled={renaming === entry.wrongTicker}
              className="flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
            >
              <FolderSymlink size={12} />
              {renaming === entry.wrongTicker ? "Renaming…" : `Rename to ${entry.realTicker}`}
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
  onEditFunding,
}: {
  portfolio: Portfolio;
  marketValue: number;
  archived?: boolean;
  onEditFunding: () => void;
}) {
  return (
    <div className={`group relative rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition-colors hover:border-cyan-500/40 hover:bg-slate-900 ${archived ? "opacity-60" : ""}`}>
      <Link href={`/portfolios/${p.id}`} className="block">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-50">{p.name}</p>
            <span className="mt-1 inline-block rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
              {p.kind === "Custom" ? p.customKindLabel || "Custom" : p.kind}
            </span>
          </div>
          <ArrowRight size={16} className="text-slate-600 group-hover:text-cyan-400" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Cash</p>
            <p className="tabular-nums text-slate-200">{formatMoney(p.cash)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Invested</p>
            <p className="tabular-nums text-slate-200">{formatMoney(marketValue)}</p>
          </div>
        </div>
        {p.notes ? <p className="mt-3 line-clamp-2 text-xs text-slate-500">{p.notes}</p> : null}
      </Link>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={(e) => {
            e.preventDefault();
            onEditFunding();
          }}
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          <Pencil size={12} /> Edit starting balance
        </button>
        {archived ? (
          <button
            onClick={(e) => {
              e.preventDefault();
              void unarchivePortfolio(repos, p.id);
            }}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <ArchiveRestore size={12} /> Unarchive
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Always available per portfolio — not gated on the missing-funding banner —
 * since a user may want to correct the starting balance later even after
 * it's been recorded once (e.g. they mis-typed it, or want to adjust the
 * date). Explicitly framed as "starting balance," not deposit/withdrawal:
 * under the hood it's the same one dated record `backfillInitialFunding`
 * edits in place, but nothing here implies new or removed money.
 */
function EditStartingBalanceModal({ portfolio, onClose }: { portfolio: Portfolio; onClose: () => void }) {
  const defaultDate = defaultFundingDate(portfolio.createdAt);

  const suggestion = useLiveQuery(async () => {
    const [timelineEvents, trades, allocations] = await Promise.all([
      repos.timeline.getByPortfolio(portfolio.id),
      repos.trades.getByPortfolio(portfolio.id),
      repos.allocations.getByPortfolio(portfolio.id),
    ]);
    const existing = getInitialFundingRecord(timelineEvents, portfolio.id);
    if (existing) return existing;
    const [entry] = findPortfoliosMissingFundingRecord([portfolio], trades, allocations, timelineEvents);
    return { amount: entry ? entry.missingAmount : 0, date: defaultDate };
  }, [portfolio.id]);

  const [amount, setAmount] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountValue = amount ?? (suggestion ? String(suggestion.amount) : "");
  const dateValue = date ?? suggestion?.date ?? defaultDate;

  async function handleSubmit() {
    const parsed = Number.parseFloat(amountValue);
    if (!parsed || parsed <= 0) {
      setError("Enter the portfolio's real starting balance.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await backfillInitialFunding(repos, portfolio.id, parsed, dateValue);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Edit starting balance — ${portfolio.name}`} open onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          The amount this portfolio actually started with — not a deposit or a withdrawal, just the baseline every
          realized/dividend % is measured against. This never touches the cash balance shown on the portfolio card.
        </p>
        <label className="block text-xs text-slate-400 space-y-1">
          Starting balance (EGP)
          <input
            type="number"
            value={amountValue}
            onChange={(e) => setAmount(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          Date
          <input
            type="date"
            value={dateValue}
            onChange={(e) => setDate(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CreatePortfolioModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      setError("Give the portfolio a name.");
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
      setError(e instanceof Error ? e.message : "Failed to create portfolio.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Create Portfolio"
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <label className="block text-xs text-slate-400 space-y-1">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            placeholder="e.g. Core Egyptian Equities"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PortfolioKind)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {kind === "Custom" ? (
          <label className="block text-xs text-slate-400 space-y-1">
            Custom label
            <input
              value={customKindLabel}
              onChange={(e) => setCustomKindLabel(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        ) : null}
        <label className="block text-xs text-slate-400 space-y-1">
          Initial cash (EGP)
          <input
            type="number"
            value={initialCash}
            onChange={(e) => setInitialCash(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          Notes
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
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

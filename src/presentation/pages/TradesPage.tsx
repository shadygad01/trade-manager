import { Fragment, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useLocation } from "wouter";
import { Plus, ArrowLeftRight, ChevronDown, ChevronRight, FolderSymlink, Pencil, Check, X, Trash2 } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { recordBuy, moveTrade, deleteTrade, correctTradeExecutionDate } from "@application/services/TradeService";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { getTradeStatus } from "@domain/entities/Trade";
import { useTrackingStartDate } from "@presentation/lib/trackingStartDateStore";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { PageHeader } from "@presentation/components/PageHeader";
import { PriceFreshness } from "@presentation/components/PriceFreshness";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { BuyZoneChart } from "@presentation/components/BuyZoneChart";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

export function TradesPage() {
  const t = useT();
  const trackingStartDate = useTrackingStartDate();
  const { id: portfolioId } = useParams<{ id: string }>();
  const [buyOpen, setBuyOpen] = useState(false);
  const [sellOpen, setSellOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [buyZoneTicker, setBuyZoneTicker] = useState<string | undefined>(undefined);
  const [moveTradeTarget, setMoveTradeTarget] = useState<Trade | null>(null);
  const [editingDate, setEditingDate] = useState<{ tradeId: string; value: string } | null>(null);
  const [dateError, setDateError] = useState<{ tradeId: string; message: string } | null>(null);

  async function saveCorrectedDate() {
    if (!editingDate) return;
    try {
      await correctTradeExecutionDate(repos, editingDate.tradeId, editingDate.value);
      setDateError(null);
      setEditingDate(null);
    } catch (e) {
      setDateError({ tradeId: editingDate.tradeId, message: e instanceof Error ? e.message : t("trades.correctDateFailed") });
    }
  }

  async function handleDeleteTrade(trade: Trade) {
    if (
      !confirm(
        t("trades.deleteTradeConfirm", { ticker: trade.ticker, shares: formatShares(trade.shares), price: formatMoney(trade.entryPrice) }),
      )
    ) {
      return;
    }
    try {
      await deleteTrade(repos, trade.id);
      setDateError(null);
    } catch (e) {
      setDateError({ tradeId: trade.id, message: e instanceof Error ? e.message : t("trades.deleteTradeFailed") });
    }
  }

  const trades = useLiveQuery(() => repos.trades.getByPortfolio(portfolioId), [portfolioId]);
  const allocations = useLiveQuery(() => repos.tradeAllocations.getByPortfolio(portfolioId), [portfolioId]);
  const priceMap = useLiveQuery(() => repos.prices.getAllPrices(), []);
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []) ?? [];
  const otherPortfolios = useMemo(() => portfolios.filter((p) => p.id !== portfolioId), [portfolios, portfolioId]);
  const portfolio = useMemo(() => portfolios.find((p) => p.id === portfolioId), [portfolios, portfolioId]);

  const allocationsByTrade = useMemo(() => {
    const map = new Map<string, TradeAllocation[]>();
    for (const a of allocations ?? []) {
      const arr = map.get(a.tradeId) ?? [];
      arr.push(a);
      map.set(a.tradeId, arr);
    }
    return map;
  }, [allocations]);

  const sorted = useMemo(
    () => [...(trades ?? [])].sort((a, b) => b.executionDate.localeCompare(a.executionDate)),
    [trades],
  );

  const openTickers = useMemo(
    () => Array.from(new Set((trades ?? []).filter((t) => t.remainingShares > 0).map((t) => t.ticker))).sort(),
    [trades],
  );

  const allTickers = useMemo(
    () => Array.from(new Set((trades ?? []).map((t) => t.ticker))).sort(),
    [trades],
  );
  const activeBuyZoneTicker = buyZoneTicker ?? allTickers[0];
  const buyZoneTrades = useMemo(
    () => (trades ?? []).filter((t) => t.ticker === activeBuyZoneTicker),
    [trades, activeBuyZoneTicker],
  );

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title={portfolio ? t("trades.titleWithPortfolio", { name: portfolio.name }) : t("trades.title")}
        description={t("trades.description")}
        actions={
          <>
            <button
              onClick={() => setBuyOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
            >
              <Plus size={16} /> {t("trades.recordBuy")}
            </button>
            <button
              onClick={() => setSellOpen(true)}
              disabled={openTickers.length === 0}
              className="flex items-center gap-1.5 rounded-md bg-rose-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeftRight size={16} /> {t("trades.recordSell")}
            </button>
          </>
        }
      />
      <PriceFreshness />

      {allTickers.length > 0 ? (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-200">{t("trades.buyZoneTitle")}</h3>
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-400">{t("trades.tickerLabel")}</span>
              <div className="relative">
                <select
                  value={activeBuyZoneTicker}
                  onChange={(e) => setBuyZoneTicker(e.target.value)}
                  className="appearance-none rounded-md border border-cyan-500/50 bg-slate-800 py-1.5 ps-3 pe-8 text-sm font-semibold text-cyan-300 hover:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                >
                  {allTickers.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-cyan-400" />
              </div>
            </label>
          </div>
          <BuyZoneChart trades={buyZoneTrades} currentPrice={priceMap?.[activeBuyZoneTicker ?? ""]} />
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          title={t("trades.noTradesTitle")}
          description={t("trades.noTradesDescription")}
          action={
            <button onClick={() => setBuyOpen(true)} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950">
              {t("trades.recordBuy")}
            </button>
          }
        />
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-start text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-4 py-2"></th>
                <th className="px-4 py-2">{t("trades.colTicker")}</th>
                <th className="px-4 py-2">{t("trades.colExecuted")}</th>
                <th className="px-4 py-2 text-end">{t("trades.colShares")}</th>
                <th className="px-4 py-2 text-end">{t("trades.colRemaining")}</th>
                <th className="px-4 py-2 text-end">{t("trades.colEntryPrice")}</th>
                <th className="px-4 py-2 text-end">{t("trades.colFees")}</th>
                <th className="px-4 py-2">{t("trades.colStatus")}</th>
                <th className="w-8 px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {sorted.map((trade) => {
                const status = getTradeStatus(trade);
                const isExpanded = expanded.has(trade.id);
                const tradeAllocations = allocationsByTrade.get(trade.id) ?? [];
                return (
                  <Fragment key={trade.id}>
                    <tr
                      className="cursor-pointer hover:bg-slate-800/40"
                      onClick={() => toggle(trade.id)}
                    >
                      <td className="px-4 py-2.5 text-slate-500">
                        {tradeAllocations.length > 0 ? (
                          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-100">
                        <span dir="ltr" className="inline-flex items-baseline gap-2">
                          <span>{trade.ticker}</span>
                          {trade.companyName ? (
                            <span className="text-xs font-normal text-slate-500">{trade.companyName}</span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-300" onClick={(e) => e.stopPropagation()}>
                        {editingDate?.tradeId === trade.id ? (
                          <span className="flex items-center gap-1">
                            <input
                              type="date"
                              autoFocus
                              value={editingDate.value}
                              min={trackingStartDate}
                              max={new Date().toISOString().slice(0, 10)}
                              onChange={(e) => setEditingDate({ tradeId: trade.id, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveCorrectedDate();
                                if (e.key === "Escape") setEditingDate(null);
                              }}
                              className="rounded border border-cyan-500/50 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-100"
                            />
                            <button
                              onClick={() => void saveCorrectedDate()}
                              title={t("trades.saveDateTitle")}
                              className="rounded p-1 text-emerald-400 hover:bg-emerald-500/10"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onClick={() => {
                                setEditingDate(null);
                                setDateError(null);
                              }}
                              className="rounded p-1 text-slate-500 hover:bg-slate-800"
                            >
                              <X size={13} />
                            </button>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            {formatDate(trade.executionDate)}
                            {trade.notes?.startsWith("Opening balance") ? (
                              <span
                                title={t("trades.placeholderTitle")}
                                className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
                              >
                                {t("trades.placeholderBadge")}
                              </span>
                            ) : null}
                            <button
                              onClick={() => {
                                setDateError(null);
                                setEditingDate({ tradeId: trade.id, value: trade.executionDate });
                              }}
                              title={t("trades.correctDateTitle")}
                              className="rounded p-1 text-slate-600 hover:bg-slate-800 hover:text-slate-300"
                            >
                              <Pencil size={12} />
                            </button>
                          </span>
                        )}
                        {dateError?.tradeId === trade.id ? (
                          <p className="mt-1 text-xs text-rose-400">{dateError.message}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(trade.shares)}</td>
                      <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(trade.remainingShares)}</td>
                      <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatMoney(trade.entryPrice)}</td>
                      <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatMoney(trade.fees)}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            status === "open"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : status === "partial"
                                ? "bg-amber-500/10 text-amber-400"
                                : "bg-slate-700/40 text-slate-400"
                          }`}
                        >
                          {status === "open" ? t("trades.statusOpen") : status === "partial" ? t("trades.statusPartial") : t("trades.statusClosed")}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-end">
                        <span className="flex items-center justify-end gap-1">
                          {otherPortfolios.length > 0 ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setMoveTradeTarget(trade);
                              }}
                              title={t("trades.moveToAnotherPortfolio")}
                              className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                            >
                              <FolderSymlink size={14} />
                            </button>
                          ) : null}
                          {trade.remainingShares === trade.shares ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteTrade(trade);
                              }}
                              title={t("trades.deleteLotTitle")}
                              className="rounded-md p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
                            >
                              <Trash2 size={14} />
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    {isExpanded && tradeAllocations.length > 0 ? (
                      <tr>
                        <td colSpan={9} className="bg-slate-950/40 px-4 py-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            {t("trades.sellsClosingLot")}
                          </p>
                          <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-start text-slate-500">
                              <tr>
                                <th className="py-1 pe-3">{t("trades.colDate")}</th>
                                <th className="py-1 pe-3 text-end">{t("trades.colSharesClosed")}</th>
                                <th className="py-1 pe-3 text-end">{t("trades.colExitPrice")}</th>
                                <th className="py-1 pe-3 text-end">{t("trades.colFees")}</th>
                                <th className="py-1 pe-3">{t("trades.colReason")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tradeAllocations.map((a) => (
                                <tr key={a.id}>
                                  <td className="py-1 pe-3 text-slate-300">{formatDate(a.executionDate)}</td>
                                  <td className="py-1 pe-3 text-end tabular-nums text-slate-300">{formatShares(a.sharesClosed)}</td>
                                  <td className="py-1 pe-3 text-end tabular-nums text-slate-300">{formatMoney(a.exitPrice)}</td>
                                  <td className="py-1 pe-3 text-end tabular-nums text-slate-300">{formatMoney(a.fees)}</td>
                                  <td className="py-1 pe-3 text-slate-400">{a.exitReason ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <RecordBuyModal portfolioId={portfolioId} open={buyOpen} onClose={() => setBuyOpen(false)} />
      <RecordSellModal
        portfolioId={portfolioId}
        openTickers={openTickers}
        open={sellOpen}
        onClose={() => setSellOpen(false)}
      />
      <MoveTradeModal
        trade={moveTradeTarget}
        otherPortfolios={otherPortfolios}
        onClose={() => setMoveTradeTarget(null)}
      />
    </div>
  );
}

function MoveTradeModal({
  trade,
  otherPortfolios,
  onClose,
}: {
  trade: Trade | null;
  otherPortfolios: { id: string; name: string }[];
  onClose: () => void;
}) {
  const t = useT();
  const [targetPortfolioId, setTargetPortfolioId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeTarget = targetPortfolioId || otherPortfolios[0]?.id || "";

  async function handleMove() {
    if (!trade || !activeTarget) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await moveTrade(repos, trade.id, activeTarget);
      if (result.movedTradeIds.length > 1) {
        alert(t("trades.movedTogetherAlert", { count: result.movedTradeIds.length, others: result.movedTradeIds.length - 1 }));
      }
      setTargetPortfolioId("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("trades.moveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={t("trades.moveModalTitle", { ticker: trade?.ticker ?? "" })} open={trade !== null} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          {t("portfolioDetail.moveModalDescription")}
        </p>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("trades.targetPortfolio")}
          <select
            value={activeTarget}
            onChange={(e) => setTargetPortfolioId(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {otherPortfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void handleMove()}
            disabled={submitting || !activeTarget}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? t("trades.moving") : t("trades.move")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RecordBuyModal({ portfolioId, open, onClose }: { portfolioId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const trackingStartDate = useTrackingStartDate();
  const [ticker, setTicker] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [sector, setSector] = useState("");
  const [shares, setShares] = useState("");
  const [entryPrice, setEntryPrice] = useState("");
  const [fees, setFees] = useState("0");
  const [taxes, setTaxes] = useState("0");
  const [executionDate, setExecutionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [executionTime, setExecutionTime] = useState(() => new Date().toISOString().slice(11, 16));
  const [notes, setNotes] = useState("");
  const [strategyTags, setStrategyTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTicker("");
    setCompanyName("");
    setSector("");
    setShares("");
    setEntryPrice("");
    setFees("0");
    setTaxes("0");
    setNotes("");
    setStrategyTags("");
    setError(null);
  }

  async function handleSubmit() {
    const normalizedTicker = normalizeTicker(ticker);
    const sharesN = Number.parseFloat(shares);
    const priceN = Number.parseFloat(entryPrice);
    if (!normalizedTicker) {
      setError(t("trades.enterTicker"));
      return;
    }
    if (!Number.isFinite(sharesN) || sharesN <= 0) {
      setError(t("trades.sharesPositive"));
      return;
    }
    if (!Number.isFinite(priceN) || priceN <= 0) {
      setError(t("trades.entryPricePositive"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // recordBuy already debits portfolio cash and writes the Buy timeline
      // event, so there's nothing left to do here beyond resetting the form.
      await recordBuy(repos, {
        portfolioId,
        ticker: normalizedTicker,
        companyName: companyName.trim() || undefined,
        sector: sector.trim() || undefined,
        shares: sharesN,
        entryPrice: priceN,
        fees: Number.parseFloat(fees) || 0,
        taxes: Number.parseFloat(taxes) || 0,
        executionDate,
        executionTime,
        notes: notes.trim() || undefined,
        strategyTags: strategyTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("trades.recordBuyFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t("trades.recordBuyModalTitle")}
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.tickerLabel")}
            <input
              value={ticker}
              onChange={(e) => {
                const next = e.target.value.toUpperCase();
                setTicker(next);
                // Only auto-fill while the user hasn't typed a sector of
                // their own — this is a suggestion, never an overwrite.
                if (!sector) {
                  const guess = sectorForTicker(normalizeTicker(next));
                  if (guess) setSector(guess);
                }
              }}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              placeholder="COMI"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.companyOptional")}
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              placeholder="Commercial International Bank"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.sectorOptional")}
            <input
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              placeholder="Banking"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.colShares")}
            <input
              type="number"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.entryPrice")}
            <input
              type="number"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.colFees")}
            <input
              type="number"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.taxes")}
            <input
              type="number"
              value={taxes}
              onChange={(e) => setTaxes(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.executionDate")}
            <input
              type="date"
              min={trackingStartDate}
              value={executionDate}
              onChange={(e) => setExecutionDate(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            {t("trades.executionTime")}
            <input
              type="time"
              value={executionTime}
              onChange={(e) => setExecutionTime(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        </div>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("trades.strategyTagsLabel")}
          <input
            value={strategyTags}
            onChange={(e) => setStrategyTags(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            placeholder="breakout, dividend-play"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("trades.notesLabel")}
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
            className="rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {submitting ? t("common.saving") : t("trades.recordBuy")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Replaces the old inline Sell Allocation popup (which forced picking lots
 * at the moment of recording the sell — see git history's SellAllocationForm)
 * with a hand-off to the Lot Manager: pick a ticker here, then record the
 * sell execution and decide its allocation (manually or via Auto Allocate
 * FIFO) on that ticker's own Lot Manager page. See TickerDetailPage.tsx.
 */
function RecordSellModal({
  portfolioId,
  openTickers,
  open,
  onClose,
}: {
  portfolioId: string;
  openTickers: string[];
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [, navigate] = useLocation();
  const [ticker, setTicker] = useState<string | undefined>(undefined);

  const activeTicker = ticker ?? openTickers[0];

  return (
    <Modal
      title={t("trades.recordSellModalTitle")}
      open={open}
      onClose={() => {
        setTicker(undefined);
        onClose();
      }}
    >
      <div className="space-y-4">
        <p className="text-xs text-slate-400">
          Selling now happens in the Lot Manager, where you record the sell and decide which Buy lot(s) it closes — manually or
          with Auto Allocate (FIFO).
        </p>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("trades.tickerLabel")}
          <select
            value={activeTicker}
            onChange={(e) => setTicker(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {openTickers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            {t("common.cancel")}
          </button>
          <button
            onClick={() => {
              if (!activeTicker) return;
              setTicker(undefined);
              onClose();
              navigate(`/portfolios/${portfolioId}/tickers/${activeTicker}`);
            }}
            disabled={!activeTicker}
            className="rounded-md bg-rose-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-rose-400 disabled:opacity-50"
          >
            Open Lot Manager
          </button>
        </div>
      </div>
    </Modal>
  );
}

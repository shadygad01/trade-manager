import { Fragment, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import { Plus, ArrowLeftRight, ChevronDown, ChevronRight, FolderSymlink } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { recordBuy, moveTrade } from "@application/services/TradeService";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { getTradeStatus } from "@domain/entities/Trade";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { BuyZoneChart } from "@presentation/components/BuyZoneChart";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";

export function TradesPage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const [buyOpen, setBuyOpen] = useState(false);
  const [sellOpen, setSellOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [buyZoneTicker, setBuyZoneTicker] = useState<string | undefined>(undefined);
  const [moveTradeTarget, setMoveTradeTarget] = useState<Trade | null>(null);

  const trades = useLiveQuery(() => repos.trades.getByPortfolio(portfolioId), [portfolioId]);
  const allocations = useLiveQuery(() => repos.tradeAllocations.getByPortfolio(portfolioId), [portfolioId]);
  const priceMap = useLiveQuery(() => repos.prices.getAllPrices(), []);
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []) ?? [];
  const otherPortfolios = useMemo(() => portfolios.filter((p) => p.id !== portfolioId), [portfolios, portfolioId]);

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
        title="Trades"
        description="Every buy execution and the specific lots each sell closed."
        actions={
          <>
            <button
              onClick={() => setBuyOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
            >
              <Plus size={16} /> Record Buy
            </button>
            <button
              onClick={() => setSellOpen(true)}
              disabled={openTickers.length === 0}
              className="flex items-center gap-1.5 rounded-md bg-rose-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeftRight size={16} /> Record Sell
            </button>
          </>
        }
      />

      {allTickers.length > 0 ? (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-200">Buy Zone &amp; Sell Map</h3>
            <select
              value={activeBuyZoneTicker}
              onChange={(e) => setBuyZoneTicker(e.target.value)}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
            >
              {allTickers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <BuyZoneChart trades={buyZoneTrades} currentPrice={priceMap?.[activeBuyZoneTicker ?? ""]} />
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          title="No trades yet"
          description="Record your first buy to start building positions."
          action={
            <button onClick={() => setBuyOpen(true)} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950">
              Record Buy
            </button>
          }
        />
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-4 py-2"></th>
                <th className="px-4 py-2">Ticker</th>
                <th className="px-4 py-2">Executed</th>
                <th className="px-4 py-2 text-right">Shares</th>
                <th className="px-4 py-2 text-right">Remaining</th>
                <th className="px-4 py-2 text-right">Entry Price</th>
                <th className="px-4 py-2 text-right">Fees</th>
                <th className="px-4 py-2">Status</th>
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
                        {trade.ticker}
                        {trade.companyName ? (
                          <span className="ml-2 text-xs font-normal text-slate-500">{trade.companyName}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">{formatDate(trade.executionDate)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatShares(trade.shares)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatShares(trade.remainingShares)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatMoney(trade.entryPrice)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatMoney(trade.fees)}</td>
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
                          {status === "open" ? "Open" : status === "partial" ? "Partial" : "Closed"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {otherPortfolios.length > 0 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMoveTradeTarget(trade);
                            }}
                            title="Move to another portfolio"
                            className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                          >
                            <FolderSymlink size={14} />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {isExpanded && tradeAllocations.length > 0 ? (
                      <tr>
                        <td colSpan={9} className="bg-slate-950/40 px-4 py-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Sells closing this lot
                          </p>
                          <table className="w-full text-xs">
                            <thead className="text-left text-slate-500">
                              <tr>
                                <th className="py-1 pr-3">Date</th>
                                <th className="py-1 pr-3 text-right">Shares Closed</th>
                                <th className="py-1 pr-3 text-right">Exit Price</th>
                                <th className="py-1 pr-3 text-right">Fees</th>
                                <th className="py-1 pr-3">Reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tradeAllocations.map((a) => (
                                <tr key={a.id}>
                                  <td className="py-1 pr-3 text-slate-300">{formatDate(a.executionDate)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-slate-300">{formatShares(a.sharesClosed)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-slate-300">{formatMoney(a.exitPrice)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-slate-300">{formatMoney(a.fees)}</td>
                                  <td className="py-1 pr-3 text-slate-400">{a.exitReason ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
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
        alert(
          `${result.movedTradeIds.length} lots moved together — this trade was sold in the same transaction as ${
            result.movedTradeIds.length - 1
          } other lot(s), so they moved as one unit.`
        );
      }
      setTargetPortfolioId("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to move trade.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Move ${trade?.ticker ?? ""} to another portfolio`} open={trade !== null} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          Moves this buy — and any sell that closed it together with another lot — to a different portfolio. Cash
          moves with it: the original cost is refunded here and charged there, and any sale proceeds follow the
          same way.
        </p>
        <label className="block text-xs text-slate-400 space-y-1">
          Target portfolio
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
            Cancel
          </button>
          <button
            onClick={() => void handleMove()}
            disabled={submitting || !activeTarget}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RecordBuyModal({ portfolioId, open, onClose }: { portfolioId: string; open: boolean; onClose: () => void }) {
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
      setError("Enter a ticker.");
      return;
    }
    if (!Number.isFinite(sharesN) || sharesN <= 0) {
      setError("Shares must be a positive number.");
      return;
    }
    if (!Number.isFinite(priceN) || priceN <= 0) {
      setError("Entry price must be a positive number.");
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
      setError(e instanceof Error ? e.message : "Failed to record buy.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Record Buy"
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-slate-400 space-y-1">
            Ticker
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
            Company (optional)
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              placeholder="Commercial International Bank"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Sector (optional)
            <input
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              placeholder="Banking"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Shares
            <input
              type="number"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Entry price
            <input
              type="number"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Fees
            <input
              type="number"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Taxes
            <input
              type="number"
              value={taxes}
              onChange={(e) => setTaxes(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Execution date
            <input
              type="date"
              value={executionDate}
              onChange={(e) => setExecutionDate(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Execution time
            <input
              type="time"
              value={executionTime}
              onChange={(e) => setExecutionTime(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        </div>
        <label className="block text-xs text-slate-400 space-y-1">
          Strategy tags (comma separated)
          <input
            value={strategyTags}
            onChange={(e) => setStrategyTags(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            placeholder="breakout, dividend-play"
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
            className="rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Record Buy"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

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
  const [ticker, setTicker] = useState<string | undefined>(undefined);

  const activeTicker = ticker ?? openTickers[0];

  return (
    <Modal
      title="Record Sell"
      open={open}
      onClose={() => {
        setTicker(undefined);
        onClose();
      }}
      widthClassName="max-w-2xl"
    >
      <div className="space-y-4">
        <label className="block text-xs text-slate-400 space-y-1">
          Ticker
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
        {activeTicker ? (
          <SellAllocationForm
            portfolioId={portfolioId}
            ticker={activeTicker}
            onDone={() => {
              setTicker(undefined);
              onClose();
            }}
            onCancel={onClose}
          />
        ) : null}
      </div>
    </Modal>
  );
}

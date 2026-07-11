import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, Link } from "wouter";
import { ArrowLeft, ArrowLeftRight, RefreshCw, Wand2, Info } from "lucide-react";
import { repos } from "@presentation/lib/data";
import {
  getLotManagerSnapshot,
  recordSellTransaction,
  setSellAllocation,
  resetSellAllocation,
  proposeFifoAllocation,
  isTemporallyValid,
  type LotManagerSnapshot,
  type BuyLot,
  type Sell,
  type FifoProposalLine,
} from "@application/services/lotManager";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { useTrackingStartDate } from "@presentation/lib/trackingStartDateStore";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { StatTile } from "@presentation/components/StatTile";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";

const STATUS_STYLES: Record<string, string> = {
  open: "bg-emerald-500/10 text-emerald-400",
  pending: "bg-emerald-500/10 text-emerald-400",
  partial: "bg-amber-500/10 text-amber-400",
  closed: "bg-slate-700/40 text-slate-400",
  completed: "bg-slate-700/40 text-slate-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLES[status] ?? "bg-slate-700/40 text-slate-400"}`}>
      {status}
    </span>
  );
}

export function TickerDetailPage() {
  const trackingStartDate = useTrackingStartDate();
  const { id: portfolioId, ticker: rawTicker } = useParams<{ id: string; ticker: string }>();
  const ticker = normalizeTicker(rawTicker ?? "");
  const [sellOpen, setSellOpen] = useState(false);
  const [allocatingSellId, setAllocatingSellId] = useState<string | null>(null);
  const [highlightedAllocationIds, setHighlightedAllocationIds] = useState<Set<string> | null>(null);

  const portfolio = useLiveQuery(() => repos.portfolios.getById(portfolioId), [portfolioId]);
  const snapshot = useLiveQuery(() => getLotManagerSnapshot(repos, portfolioId, ticker), [portfolioId, ticker]);

  const allocatingSell = snapshot?.sells.find((s) => s.id === allocatingSellId) ?? null;

  function toggleHighlight(ids: string[]) {
    setHighlightedAllocationIds((prev) => {
      const next = new Set(ids);
      if (prev && prev.size === next.size && [...prev].every((id) => next.has(id))) return null;
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title={ticker}
        description={`Lot Manager — Buy Lots, Sell Transactions, and Allocation Events for ${ticker} in ${portfolio?.name ?? ""}`}
        actions={
          <>
            <Link
              href={`/portfolios/${portfolioId}`}
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              <ArrowLeft size={16} /> Back to portfolio
            </Link>
            <button
              onClick={() => setSellOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-rose-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-rose-400"
            >
              <ArrowLeftRight size={16} /> Record Sell
            </button>
          </>
        }
      />

      {!snapshot ? null : (
        <LotManagerBody
          snapshot={snapshot}
          highlightedAllocationIds={highlightedAllocationIds}
          onSelectTimelineEntry={toggleHighlight}
          onManageAllocation={(sellId) => setAllocatingSellId(sellId)}
        />
      )}

      <RecordSellModal
        portfolioId={portfolioId}
        ticker={ticker}
        trackingStartDate={trackingStartDate}
        open={sellOpen}
        onClose={() => setSellOpen(false)}
        onDone={(sellId) => {
          setSellOpen(false);
          setAllocatingSellId(sellId);
        }}
      />

      {snapshot && allocatingSell ? (
        <ManageAllocationModal
          portfolioId={portfolioId}
          ticker={ticker}
          snapshot={snapshot}
          sell={allocatingSell}
          onClose={() => setAllocatingSellId(null)}
        />
      ) : null}
    </div>
  );
}

function LotManagerBody({
  snapshot,
  highlightedAllocationIds,
  onSelectTimelineEntry,
  onManageAllocation,
}: {
  snapshot: LotManagerSnapshot;
  highlightedAllocationIds: Set<string> | null;
  onSelectTimelineEntry: (allocationIds: string[]) => void;
  onManageAllocation: (sellId: string) => void;
}) {
  if (snapshot.buyLots.length === 0 && snapshot.sells.length === 0) {
    return (
      <EmptyState
        title="No trades for this ticker yet"
        description="Record a Buy from the Trades page, then come back here to manage its Sell allocations."
      />
    );
  }

  return (
    <div className="space-y-6">
      {snapshot.issues.length > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-300">
            <Info size={14} /> Validation
          </p>
          {snapshot.issues.map((issue, i) => (
            <p key={i} className="text-xs text-amber-200/90">
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Bought" value={formatShares(snapshot.currentPosition.boughtShares)} />
        <StatTile label="Available shares" value={formatShares(snapshot.currentPosition.availableShares)} />
        <StatTile label="Allocated shares" value={formatShares(snapshot.currentPosition.allocatedShares)} />
        <StatTile
          label="Pending allocation"
          value={formatShares(snapshot.currentPosition.pendingAllocationShares)}
          valueClassName={snapshot.currentPosition.pendingAllocationShares > 0 ? "text-amber-400" : undefined}
        />
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Buy Lots</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
          <table className="w-full text-sm">
            <thead className="text-start text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Trade Date</th>
                <th className="px-4 py-2 text-end">Shares</th>
                <th className="px-4 py-2 text-end">Remaining</th>
                <th className="px-4 py-2 text-end">Allocated</th>
                <th className="px-4 py-2 text-end">Cost Basis</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {snapshot.buyLots.map((lot) => {
                const related = lot.closedBy.map((c) => `${c.sellId}|${lot.id}`);
                const isHighlighted = highlightedAllocationIds && related.some((id) => highlightedAllocationIds.has(id));
                return (
                  <tr key={lot.id} className={isHighlighted ? "bg-cyan-500/10" : undefined}>
                    <td className="px-4 py-2.5 text-slate-300">{formatDate(lot.executionDate)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(lot.shares)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(lot.remainingShares)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(lot.allocatedShares)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatMoney(lot.costBasis)}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={lot.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Sell Transactions</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
          <table className="w-full text-sm">
            <thead className="text-start text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Trade Date</th>
                <th className="px-4 py-2 text-end">Shares</th>
                <th className="px-4 py-2 text-end">Allocated</th>
                <th className="px-4 py-2 text-end">Remaining</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {snapshot.sells.map((sell) => {
                const related = sell.allocations.map((a) => `${sell.id}|${a.buyLotId}`);
                const isHighlighted = highlightedAllocationIds && related.some((id) => highlightedAllocationIds.has(id));
                return (
                  <tr key={sell.id} className={isHighlighted ? "bg-cyan-500/10" : undefined}>
                    <td className="px-4 py-2.5 text-slate-300">{formatDate(sell.executionDate)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(sell.shares)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(sell.allocatedShares)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(sell.remainingShares)}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={sell.status} />
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      <button
                        onClick={() => onManageAllocation(sell.id)}
                        className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800"
                      >
                        Manage Allocation
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Timeline</h3>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <ol className="space-y-1.5">
            {snapshot.timeline.map((entry) => {
              const isSelected = highlightedAllocationIds && entry.relatedAllocationIds.some((id) => highlightedAllocationIds.has(id));
              return (
                <li key={entry.id}>
                  <button
                    onClick={() => onSelectTimelineEntry(entry.relatedAllocationIds)}
                    disabled={entry.relatedAllocationIds.length === 0}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-start text-xs disabled:cursor-default ${
                      isSelected ? "bg-cyan-500/15 text-cyan-200" : "text-slate-300 hover:bg-slate-800/70"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          entry.type === "BUY" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                        }`}
                      >
                        {entry.type}
                      </span>
                      {formatDate(entry.executionDate)}
                      {entry.executionTime ? <span className="text-slate-500">{entry.executionTime}</span> : null}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {formatShares(entry.shares)} @ {formatMoney(entry.price)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
    </div>
  );
}

function RecordSellModal({
  portfolioId,
  ticker,
  trackingStartDate,
  open,
  onClose,
  onDone,
}: {
  portfolioId: string;
  ticker: string;
  trackingStartDate: string;
  open: boolean;
  onClose: () => void;
  onDone: (sellId: string) => void;
}) {
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState("0");
  const [taxes, setTaxes] = useState("0");
  const [executionDate, setExecutionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [executionTime, setExecutionTime] = useState(() => new Date().toISOString().slice(11, 16));
  const [exitReason, setExitReason] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setShares("");
    setPrice("");
    setFees("0");
    setTaxes("0");
    setExitReason("");
    setNotes("");
    setError(null);
  }

  async function handleSubmit() {
    const sharesN = Number.parseFloat(shares);
    const priceN = Number.parseFloat(price);
    if (!Number.isFinite(sharesN) || sharesN <= 0) {
      setError("Enter a valid share count");
      return;
    }
    if (!Number.isFinite(priceN) || priceN <= 0) {
      setError("Enter a valid exit price");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { sellId } = await recordSellTransaction(repos, {
        portfolioId,
        ticker,
        shares: sharesN,
        price: priceN,
        fees: Number.parseFloat(fees) || 0,
        taxes: Number.parseFloat(taxes) || 0,
        executionDate,
        executionTime,
        exitReason: exitReason || undefined,
        notes: notes || undefined,
      });
      reset();
      onDone(sellId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record sell");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`Record Sell — ${ticker}`}
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          This records the sell execution only. Which Buy lot(s) it closes is decided next, in Manage Allocation — manually, or
          with Auto Allocate (FIFO).
        </p>
        <div className="grid grid-cols-2 gap-3">
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
            Exit Price
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
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
            Execution Date
            <input
              type="date"
              min={trackingStartDate}
              value={executionDate}
              onChange={(e) => setExecutionDate(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400 space-y-1">
            Execution Time
            <input
              type="time"
              value={executionTime}
              onChange={(e) => setExecutionTime(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        </div>
        <label className="block text-xs text-slate-400 space-y-1">
          Exit reason (optional)
          <input
            value={exitReason}
            onChange={(e) => setExitReason(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          Notes (optional)
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
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-md bg-rose-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-rose-400 disabled:opacity-50"
          >
            {submitting ? "Recording…" : "Record Sell"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ManageAllocationModal({
  portfolioId,
  ticker,
  snapshot,
  sell,
  onClose,
}: {
  portfolioId: string;
  ticker: string;
  snapshot: LotManagerSnapshot;
  sell: Sell;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<Record<string, string>>(() =>
    Object.fromEntries(sell.allocations.map((a) => [a.buyLotId, String(a.shares)])),
  );
  const [proposal, setProposal] = useState<FifoProposalLine[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalSelected = useMemo(
    () => Object.values(lines).reduce((sum, v) => sum + (Number.parseFloat(v) || 0), 0),
    [lines],
  );

  function setLineShares(buyLotId: string, value: string) {
    setLines((prev) => ({ ...prev, [buyLotId]: value }));
  }
  function toggleLot(lot: BuyLot, checked: boolean) {
    setLines((prev) => {
      const next = { ...prev };
      if (checked) {
        const already = sell.allocations.find((a) => a.buyLotId === lot.id)?.shares ?? 0;
        const cap = lot.remainingShares + already;
        next[lot.id] = String(Math.min(cap, sell.shares - totalSelected + (Number.parseFloat(prev[lot.id] ?? "0") || 0)));
      } else {
        delete next[lot.id];
      }
      return next;
    });
  }

  function applyFifoProposal() {
    const proposed = proposeFifoAllocation(snapshot, sell.id);
    setProposal(proposed);
    setLines(Object.fromEntries(proposed.map((p) => [p.buyLotId, String(p.shares)])));
  }

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    try {
      const desired = Object.entries(lines)
        .filter(([, v]) => (Number.parseFloat(v) || 0) > 0)
        .map(([buyLotId, v]) => ({ buyLotId, shares: Number.parseFloat(v) }));
      await setSellAllocation(repos, portfolioId, ticker, sell.id, desired);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save allocation");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset() {
    setSubmitting(true);
    setError(null);
    try {
      await resetSellAllocation(repos, portfolioId, ticker, sell.id);
      setLines({});
      setProposal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reset allocation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Manage Allocation — Sell ${formatDate(sell.executionDate)}`} open onClose={onClose} widthClassName="max-w-2xl">
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
          <p>
            Sell of <span className="text-slate-200">{formatShares(sell.shares)}</span> shares @{" "}
            <span className="text-slate-200">{formatMoney(sell.price)}</span> on {formatDate(sell.executionDate)}.
          </p>
          <p className="mt-1">
            Selected: <span className="text-slate-200">{formatShares(totalSelected)}</span> / {formatShares(sell.shares)}
          </p>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open Buy Lots</p>
          <button
            onClick={applyFifoProposal}
            className="flex items-center gap-1.5 rounded-md border border-cyan-500/40 px-2.5 py-1 text-xs font-medium text-cyan-300 hover:bg-cyan-500/10"
          >
            <Wand2 size={13} /> Auto Allocate (FIFO)
          </button>
        </div>
        {proposal ? (
          <p className="rounded-md bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
            FIFO proposal generated — review and edit below, then Save to confirm. Nothing is committed automatically.
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/80 text-start text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">Trade Date</th>
                <th className="px-3 py-2 text-end">Remaining</th>
                <th className="px-3 py-2 text-end">Allocate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {snapshot.buyLots.map((lot) => {
                const valid = isTemporallyValid(lot, sell);
                const already = sell.allocations.find((a) => a.buyLotId === lot.id)?.shares ?? 0;
                const checked = lines[lot.id] !== undefined;
                const cap = lot.remainingShares + already;
                return (
                  <tr key={lot.id} className={!valid ? "opacity-40" : checked ? "bg-cyan-500/5" : undefined}>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        disabled={!valid || cap <= 0}
                        checked={checked}
                        onChange={(e) => toggleLot(lot, e.target.checked)}
                        className="h-4 w-4 rounded border-slate-700 bg-slate-800"
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-300">
                      {formatDate(lot.executionDate)}
                      {!valid ? (
                        <p className="mt-0.5 text-[11px] text-rose-400">
                          This Buy transaction occurred after the selected Sell transaction and cannot be allocated.
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums text-slate-300">{formatShares(cap)}</td>
                    <td className="px-3 py-2 text-end">
                      <input
                        type="number"
                        disabled={!valid || !checked}
                        min={0}
                        max={cap}
                        value={lines[lot.id] ?? ""}
                        onChange={(e) => setLineShares(lot.id, e.target.value)}
                        className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-end tabular-nums text-slate-100 disabled:opacity-40"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error ? <p className="text-sm text-rose-400">{error}</p> : null}

        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            onClick={() => void handleReset()}
            disabled={submitting || sell.allocations.length === 0}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
          >
            <RefreshCw size={14} /> Reset Allocation
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={submitting}
              className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save Allocation"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import { ArrowDownCircle, ArrowUpCircle, CircleDollarSign, ShieldAlert, ShieldCheck } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { computePositions } from "@application/services/TradeService";
import { deposit, withdraw, recordDividend } from "@application/services/PortfolioService";
import { reconcilePositions, acceptComputedAsVerified } from "@application/services/reconciliation";
import type { Position, PositionReconciliation } from "@presentation/lib/types";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { StatTile } from "@presentation/components/StatTile";
import { formatMoney, formatPercent, formatShares, signClass } from "@presentation/lib/format";

type CashModalKind = "deposit" | "withdraw" | "dividend" | null;

export function PortfolioDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [cashModal, setCashModal] = useState<CashModalKind>(null);

  const portfolio = useLiveQuery(() => repos.portfolios.getById(id), [id]);
  const positions = useLiveQuery(async (): Promise<Position[]> => {
    const priceMap = await repos.prices.getAllPrices();
    return computePositions(repos, id, priceMap);
  }, [id]);
  const reconciliations = useLiveQuery(async (): Promise<PositionReconciliation[]> => {
    if (!positions) return [];
    const [verifications, trades, allocations] = await Promise.all([
      repos.verifications.getByPortfolio(id),
      repos.trades.getByPortfolio(id),
      repos.allocations.getByPortfolio(id),
    ]);
    return reconcilePositions(positions, verifications, trades, allocations);
  }, [id, positions]);
  const reconciliationByTicker = new Map((reconciliations ?? []).map((r) => [r.ticker, r]));

  async function acceptCurrent(ticker: string, computedShares: number) {
    await acceptComputedAsVerified(repos, id, ticker, computedShares);
  }

  if (portfolio === undefined || positions === undefined) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (!portfolio) {
    return <EmptyState title="Portfolio not found" description="It may have been deleted." />;
  }

  const marketValue = positions.reduce((sum, p) => sum + (p.marketValue ?? p.costBasis), 0);
  const costBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

  return (
    <div>
      <PageHeader
        title={portfolio.name}
        description={`${portfolio.kind === "Custom" ? portfolio.customKindLabel || "Custom" : portfolio.kind} · ${portfolio.currency}`}
        actions={
          <>
            <button
              onClick={() => setCashModal("deposit")}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <ArrowDownCircle size={16} /> Deposit
            </button>
            <button
              onClick={() => setCashModal("withdraw")}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <ArrowUpCircle size={16} /> Withdraw
            </button>
            <button
              onClick={() => setCashModal("dividend")}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <CircleDollarSign size={16} /> Dividend
            </button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Cash Balance" value={formatMoney(portfolio.cash)} />
        <StatTile label="Invested (Market Value)" value={formatMoney(marketValue)} sublabel={`Cost basis ${formatMoney(costBasis)}`} />
        <StatTile
          label="Unrealized P/L"
          value={formatMoney(unrealizedPnl)}
          valueClassName={signClass(unrealizedPnl)}
          sublabel={formatPercent(unrealizedPnlPct)}
        />
        <StatTile label="Total Assets" value={formatMoney(marketValue + portfolio.cash)} />
      </div>

      <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60">
        <div className="border-b border-slate-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-200">Holdings</h3>
        </div>
        {positions.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No open positions" description="Record a buy trade to see holdings here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Ticker</th>
                  <th className="px-4 py-2 text-right">Shares</th>
                  <th className="px-4 py-2 text-right">Avg Cost</th>
                  <th className="px-4 py-2 text-right">Cost Basis</th>
                  <th className="px-4 py-2 text-right">Current Price</th>
                  <th className="px-4 py-2 text-right">Market Value</th>
                  <th className="px-4 py-2 text-right">Unrealized P/L</th>
                  <th className="px-4 py-2 text-right">Lots</th>
                  <th className="px-4 py-2">Verification</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {positions.map((p) => {
                  const r = reconciliationByTicker.get(p.ticker);
                  return (
                  <tr key={p.ticker}>
                    <td className="px-4 py-2.5 font-medium text-slate-100">{p.ticker}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatShares(p.totalShares)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatMoney(p.avgCost)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatMoney(p.costBasis)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                      {p.currentPrice !== undefined ? formatMoney(p.currentPrice) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                      {p.marketValue !== undefined ? formatMoney(p.marketValue) : "—"}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${signClass(p.unrealizedPnl)}`}>
                      {p.unrealizedPnl !== undefined ? formatMoney(p.unrealizedPnl) : "—"}
                      {p.unrealizedPnlPct !== undefined ? (
                        <span className="ml-1 text-xs opacity-80">({formatPercent(p.unrealizedPnlPct)})</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">{p.openTrades.length}</td>
                    <td className="px-4 py-2.5">
                      {!r ? (
                        <span className="text-xs text-slate-600">—</span>
                      ) : r.verificationStale ? (
                        <span className="text-xs text-slate-500">Verification outdated</span>
                      ) : r.quantityMismatch ? (
                        <div className="flex items-center gap-2">
                          <span className="flex items-center gap-1 text-xs text-rose-400">
                            <ShieldAlert size={13} /> {formatShares(p.totalShares)} vs {formatShares(r.verifiedUnits)} verified
                          </span>
                          <button
                            onClick={() => void acceptCurrent(p.ticker, p.totalShares)}
                            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
                          >
                            Accept as current
                          </button>
                        </div>
                      ) : r.quantityShortfall ? (
                        <div className="flex items-center gap-2">
                          <span className="flex items-center gap-1 text-xs text-amber-400">
                            <ShieldAlert size={13} /> Missing {formatShares(r.verifiedUnits - p.totalShares)} shares
                          </span>
                          <button
                            onClick={() => void acceptCurrent(p.ticker, p.totalShares)}
                            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
                          >
                            Accept as current
                          </button>
                        </div>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <ShieldCheck size={13} /> Matches broker
                        </span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(reconciliations ?? []).some((r) => r.quantityShortfall && r.computedShares === 0) ? (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
            <ShieldAlert size={16} /> Verified positions with no recorded trades
          </p>
          <ul className="space-y-1 text-sm text-amber-200/80">
            {(reconciliations ?? [])
              .filter((r) => r.quantityShortfall && r.computedShares === 0)
              .map((r) => (
                <li key={r.ticker}>
                  {r.ticker}: the broker screenshot shows {formatShares(r.verifiedUnits)} units, but this portfolio has no
                  open trades for it — import or record the missing buy(s).
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <CashModal kind={cashModal} portfolioId={portfolio.id} onClose={() => setCashModal(null)} />
    </div>
  );
}

function CashModal({
  kind,
  portfolioId,
  onClose,
}: {
  kind: CashModalKind;
  portfolioId: string;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [ticker, setTicker] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!kind) return null;

  const titles: Record<Exclude<CashModalKind, null>, string> = {
    deposit: "Deposit Cash",
    withdraw: "Withdraw Cash",
    dividend: "Record Dividend",
  };

  async function handleSubmit() {
    const n = Number.parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const trimmedNotes = notes.trim() || undefined;
      if (kind === "deposit") await deposit(repos, portfolioId, n, trimmedNotes);
      else if (kind === "withdraw") await withdraw(repos, portfolioId, n, trimmedNotes);
      else await recordDividend(repos, portfolioId, { ticker: ticker.trim() || undefined, amount: n, notes: trimmedNotes });
      setAmount("");
      setTicker("");
      setNotes("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={titles[kind]} open={Boolean(kind)} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-xs text-slate-400 space-y-1">
          Amount (EGP)
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        {kind === "dividend" ? (
          <label className="block text-xs text-slate-400 space-y-1">
            Ticker (optional)
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        ) : null}
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
            {submitting ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

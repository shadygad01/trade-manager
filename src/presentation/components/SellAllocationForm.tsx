import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { recordSell } from "@application/services/TradeService";
import { repos } from "@presentation/lib/data";
import { TRACKING_START_DATE } from "@domain/value-objects/trackingWindow";
import type { RecordSellInput } from "@presentation/lib/types";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

interface SellAllocationFormProps {
  portfolioId: string;
  ticker: string;
  /** `created.allocationIds` are the TradeAllocation ids this sell just wrote — callers that show the sell row afterward can exclude them from duplicate checks so the row never "matches" itself (see ImportPage's duplicateMatch). */
  onDone: (created?: { allocationIds: string[] }) => void;
  onCancel?: () => void;
  initial?: {
    exitPrice?: number;
    fees?: number;
    taxes?: number;
    executionDate?: string;
    executionTime?: string;
  };
}

/**
 * The primary sell UI: the user sees every open lot for the ticker and
 * explicitly enters how many shares of THIS sell close each lot. There is
 * no auto-FIFO suggestion — allocation across lots is always a deliberate,
 * per-trade choice, per TradeAllocation's design contract.
 */
export function SellAllocationForm({ portfolioId, ticker, onDone, onCancel, initial }: SellAllocationFormProps) {
  const t = useT();
  const openTrades = useLiveQuery(async () => {
    const trades = await repos.trades.getByPortfolio(portfolioId);
    return trades
      .filter((t) => t.ticker === ticker && t.remainingShares > 0)
      .sort((a, b) => a.executionDate.localeCompare(b.executionDate));
  }, [portfolioId, ticker]);

  const [selected, setSelected] = useState<Record<string, string>>({});
  const [exitPrice, setExitPrice] = useState(initial?.exitPrice !== undefined ? String(initial.exitPrice) : "");
  const [fees, setFees] = useState(initial?.fees !== undefined ? String(initial.fees) : "0");
  const [taxes, setTaxes] = useState(initial?.taxes !== undefined ? String(initial.taxes) : "0");
  const [executionDate, setExecutionDate] = useState(() => initial?.executionDate ?? new Date().toISOString().slice(0, 10));
  const [executionTime, setExecutionTime] = useState(() => initial?.executionTime ?? new Date().toISOString().slice(11, 16));
  const [exitReason, setExitReason] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalOpenShares = useMemo(
    () => (openTrades ?? []).reduce((sum, t) => sum + t.remainingShares, 0),
    [openTrades],
  );

  const totalSelected = useMemo(
    () =>
      Object.values(selected).reduce((sum, v) => {
        const n = Number.parseFloat(v);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0),
    [selected],
  );

  function toggleTrade(tradeId: string, maxShares: number, checked: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      if (checked) {
        next[tradeId] = String(maxShares);
      } else {
        delete next[tradeId];
      }
      return next;
    });
  }

  function setShares(tradeId: string, value: string) {
    setSelected((prev) => ({ ...prev, [tradeId]: value }));
  }

  async function handleSubmit() {
    setError(null);
    const price = Number.parseFloat(exitPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setError(t("sellForm.enterValidExitPrice"));
      return;
    }
    if (totalSelected <= 0) {
      setError(t("sellForm.selectAtLeastOneLot"));
      return;
    }
    for (const trade of openTrades ?? []) {
      const raw = selected[trade.id];
      if (raw === undefined) continue;
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0 || n > trade.remainingShares) {
        setError(t("sellForm.sharesRangeError", { date: formatDate(trade.executionDate), max: trade.remainingShares }));
        return;
      }
    }

    setSubmitting(true);
    try {
      // The user sets one exit price/fee/tax for the whole sell action (it's
      // one market order); recordSell's contract is per-lot, so the totals
      // are prorated across lots by shares closed and each lot gets the same
      // price — this keeps per-lot P/L attribution accurate without asking
      // the user to re-enter the same price per lot.
      const totalFees = Number.parseFloat(fees) || 0;
      const totalTaxes = Number.parseFloat(taxes) || 0;
      const feePerShare = totalSelected > 0 ? totalFees / totalSelected : 0;
      const taxPerShare = totalSelected > 0 ? totalTaxes / totalSelected : 0;
      const allocations = Object.entries(selected)
        .filter(([, v]) => Number.parseFloat(v) > 0)
        .map(([tradeId, v]) => {
          const lineShares = Number.parseFloat(v);
          return {
            tradeId,
            shares: lineShares,
            exitPrice: price,
            fees: feePerShare * lineShares,
            taxes: taxPerShare * lineShares,
            notes: notes || undefined,
            exitReason: exitReason || undefined,
          };
        });

      const input: RecordSellInput = {
        portfolioId,
        ticker,
        allocations,
        executionDate,
        executionTime,
      };

      const result = await recordSell(repos, input);
      onDone({ allocationIds: result.allocations.map((a) => a.id) });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sellForm.recordSellFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (openTrades && openTrades.length === 0) {
    return <p className="text-sm text-slate-400">{t("sellForm.noOpenLots", { ticker })}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/80 text-start text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 w-8"></th>
              <th className="px-3 py-2">{t("sellForm.colExecuted")}</th>
              <th className="px-3 py-2 text-end">{t("sellForm.colEntryPrice")}</th>
              <th className="px-3 py-2 text-end">{t("sellForm.colRemaining")}</th>
              <th className="px-3 py-2 text-end">{t("sellForm.colCloseShares")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {(openTrades ?? []).map((trade) => {
              const isChecked = selected[trade.id] !== undefined;
              return (
                <tr key={trade.id} className={isChecked ? "bg-cyan-500/5" : undefined}>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(e) => toggleTrade(trade.id, trade.remainingShares, e.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-800"
                    />
                  </td>
                  <td className="px-3 py-2 text-slate-300">{formatDate(trade.executionDate)}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-slate-300">{formatMoney(trade.entryPrice)}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-slate-300">{formatShares(trade.remainingShares)}</td>
                  <td className="px-3 py-2 text-end">
                    <input
                      type="number"
                      disabled={!isChecked}
                      min={0}
                      max={trade.remainingShares}
                      value={selected[trade.id] ?? ""}
                      onChange={(e) => setShares(trade.id, e.target.value)}
                      className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-end tabular-nums text-slate-100 disabled:opacity-40"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        {t("sellForm.selectedOf", { selected: formatShares(totalSelected), total: formatShares(totalOpenShares) })}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-slate-400 space-y-1">
          {t("sellForm.exitPrice")}
          <input
            type="number"
            value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("sellForm.fees")}
          <input
            type="number"
            value={fees}
            onChange={(e) => setFees(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("sellForm.taxes")}
          <input
            type="number"
            value={taxes}
            onChange={(e) => setTaxes(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("sellForm.executionDate")}
          <input
            type="date"
            min={TRACKING_START_DATE}
            value={executionDate}
            onChange={(e) => setExecutionDate(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("sellForm.executionTime")}
          <input
            type="time"
            value={executionTime}
            onChange={(e) => setExecutionTime(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="col-span-2 text-xs text-slate-400 space-y-1">
          {t("sellForm.exitReason")}
          <input
            type="text"
            value={exitReason}
            onChange={(e) => setExitReason(e.target.value)}
            placeholder={t("sellForm.exitReasonPlaceholder")}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="col-span-2 text-xs text-slate-400 space-y-1">
          {t("sellForm.notes")}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-2">
        {onCancel ? (
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            {t("sellForm.cancel")}
          </button>
        ) : null}
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {submitting ? t("sellForm.recording") : t("sellForm.recordSell")}
        </button>
      </div>
    </div>
  );
}

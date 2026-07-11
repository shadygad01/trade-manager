import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, Link } from "wouter";
import { Banknote, CircleDollarSign, ShieldAlert, ShieldCheck, Wrench, SplitSquareHorizontal, Archive, ArchiveRestore, Trash2, Pencil, Eraser, FileWarning, Upload } from "lucide-react";
import { repos, getImportOrchestrator } from "@presentation/lib/data";
import { deleteTrade, confirmPendingBuy, confirmPendingSell } from "@application/services/TradeService";
import { computeCanonicalPositions } from "@application/services/canonicalHoldings";
import {
  setCash,
  recordDividend,
  recordCashAdjustment,
  recordSplit,
  recordRightsIssue,
  archivePortfolio,
  unarchivePortfolio,
  renamePortfolio,
} from "@application/services/PortfolioService";
import { reconcilePositions, suggestDuplicateTradeIds, findPendingConfirmations, type PendingConfirmation } from "@application/services/reconciliation";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { useTrackingStartDate } from "@presentation/lib/trackingStartDateStore";
import type { Position, PositionReconciliation } from "@presentation/lib/types";
import { PageHeader } from "@presentation/components/PageHeader";
import { PriceFreshness } from "@presentation/components/PriceFreshness";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { StatTile } from "@presentation/components/StatTile";
import { CapitalDeploymentFlow } from "@presentation/components/CapitalDeploymentFlow";
import { formatDate, formatMoney, formatPercent, formatShares, signClass } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

type CashModalKind = "editCash" | "dividend" | "adjustment" | null;
type CorporateActionKind = "split" | "rightsIssue" | null;

export function PortfolioDetailPage() {
  const t = useT();
  const trackingStartDate = useTrackingStartDate();
  const { id } = useParams<{ id: string }>();
  const [cashModal, setCashModal] = useState<CashModalKind>(null);
  const [corporateActionOpen, setCorporateActionOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<{ tradeId: string; message: string } | null>(null);
  const [clearAllError, setClearAllError] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [confirming, setConfirming] = useState<Record<string, boolean>>({});
  const [confirmError, setConfirmError] = useState<Record<string, string | undefined>>({});
  // Deleting a trade doesn't reliably retrigger dexie-react-hooks' liveQuery
  // for this page's positions/reconciliation (a pre-existing gap, not
  // specific to this action) — bumping this forces both queries to
  // re-run immediately instead of only reflecting the change after a
  // manual page reload.
  const [refreshKey, setRefreshKey] = useState(0);

  const portfolio = useLiveQuery(() => repos.portfolios.getById(id), [id]);
  const positions = useLiveQuery(async (): Promise<Position[]> => {
    const priceMap = await repos.prices.getAllPrices();
    return computeCanonicalPositions(repos, id, priceMap);
  }, [id, refreshKey]);
  const reconciliations = useLiveQuery(async (): Promise<PositionReconciliation[]> => {
    if (!positions) return [];
    const [verifications, trades, allocations] = await Promise.all([
      repos.verifications.getByPortfolio(id),
      repos.trades.getByPortfolio(id),
      repos.allocations.getByPortfolio(id),
    ]);
    return reconcilePositions(positions, verifications, trades, allocations);
  }, [id, positions, refreshKey]);
  const reconciliationByTicker = new Map((reconciliations ?? []).map((r) => [r.ticker, r]));
  const pendingConfirmations = useLiveQuery(async (): Promise<PendingConfirmation[]> => {
    const [trades, allocations] = await Promise.all([repos.trades.getByPortfolio(id), repos.allocations.getByPortfolio(id)]);
    return findPendingConfirmations(trades, allocations);
  }, [id, refreshKey]);
  const pendingConfirmationsByTicker = new Map<string, PendingConfirmation[]>();
  for (const item of pendingConfirmations ?? []) {
    const list = pendingConfirmationsByTicker.get(item.ticker) ?? [];
    list.push(item);
    pendingConfirmationsByTicker.set(item.ticker, list);
  }
  const timelineEvents = useLiveQuery(() => repos.timeline.getByPortfolio(id), [id]);

  /**
   * Runs an uploaded broker invoice through the same OCR pipeline Import
   * itself uses, then confirms exactly the one pending item it was uploaded
   * for — never a fuzzy search across every pending transaction. The user
   * already told the app which specific transaction this file is for by
   * clicking its upload control; a ticker/side mismatch or an ambiguous read
   * surfaces a clear error instead of guessing which candidate to trust.
   */
  async function handleUploadInvoice(item: PendingConfirmation, file: File) {
    setConfirmError((prev) => ({ ...prev, [item.refId]: undefined }));
    setConfirming((prev) => ({ ...prev, [item.refId]: true }));
    try {
      const orchestrator = await getImportOrchestrator();
      const result = await orchestrator.importFile(file);
      if (result.status === "failed") {
        throw new Error(t("portfolioDetail.confirmInvoiceUnreadable"));
      }
      const matches = result.candidates.filter(
        (c) => normalizeTicker(c.ticker) === normalizeTicker(item.ticker) && c.side === item.side
      );
      if (matches.length === 0) {
        throw new Error(t("portfolioDetail.confirmInvoiceNoMatch", { ticker: item.ticker }));
      }
      if (matches.length > 1) {
        throw new Error(t("portfolioDetail.confirmInvoiceAmbiguous", { ticker: item.ticker }));
      }
      const candidate = matches[0];
      const confirmed = {
        shares: candidate.shares,
        price: candidate.price,
        fees: candidate.fees,
        taxes: candidate.taxes,
        transactionNumber: candidate.transactionNumber,
      };
      if (item.side === "BUY") {
        await confirmPendingBuy(repos, item.refId, confirmed);
      } else {
        await confirmPendingSell(repos, item.refId, confirmed);
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setConfirmError((prev) => ({ ...prev, [item.refId]: e instanceof Error ? e.message : t("portfolioDetail.confirmInvoiceFailed") }));
    } finally {
      setConfirming((prev) => ({ ...prev, [item.refId]: false }));
    }
  }

  async function handleDeleteTrade(tradeId: string) {
    if (!confirm(t("portfolioDetail.deleteTradeConfirm"))) {
      return;
    }
    setDeleteError(null);
    try {
      // Read the trade before deleting so we know its ticker/portfolio
      const trade = await repos.trades.getById(tradeId);
      await deleteTrade(repos, tradeId);
      // Deleting a trade only invalidates a broker verification when the
      // deleted trade was part of the verified snapshot AND its removal
      // breaks the match between the ledger and the verified unit count.
      // A verification is kept when:
      //  - the deleted trade was executed after the verification was
      //    captured (the snapshot never included it), or
      //  - after deletion the ledger as of the capture time still equals
      //    the verified units (e.g. a duplicate import was removed — the
      //    verification is accurate again, not corrupted).
      if (trade) {
        const ticker = normalizeTicker(trade.ticker);
        const tradeTs = `${trade.executionDate}T${trade.executionTime}`;
        const [verifs, remainingTrades, allocations] = await Promise.all([
          repos.verifications.getByPortfolio(trade.portfolioId),
          repos.trades.getByPortfolio(trade.portfolioId),
          repos.allocations.getByPortfolio(trade.portfolioId),
        ]);
        const corrupted = verifs.filter((v) => {
          if (normalizeTicker(v.ticker) !== ticker) return false;
          // Trade executed after the snapshot was captured — snapshot never
          // included it, so deleting it cannot corrupt the verification.
          if (tradeTs > v.capturedAt) return false;
          // Recompute ledger shares as of the capture time (post-deletion).
          const boughtByCapture = remainingTrades
            .filter(
              (t) =>
                normalizeTicker(t.ticker) === ticker &&
                `${t.executionDate}T${t.executionTime}` <= v.capturedAt
            )
            .reduce((sum, t) => sum + t.shares, 0);
          const soldByCapture = allocations
            .filter(
              (a) =>
                normalizeTicker(a.ticker) === ticker &&
                `${a.executionDate}T${a.executionTime}` <= v.capturedAt
            )
            .reduce((sum, a) => sum + a.sharesClosed, 0);
          // Still matches the broker's verified count — verification intact.
          return boughtByCapture - soldByCapture !== v.units;
        });
        await Promise.all(corrupted.map((v) => repos.verifications.delete(v.id)));
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setDeleteError({ tradeId, message: e instanceof Error ? e.message : t("portfolioDetail.deleteTradeFailed") });
    }
  }

  /**
   * For a verification stuck permanently at "no recorded trades" not because
   * the real buy is missing, but because the verification itself was misfiled
   * against the wrong portfolio (e.g. a ticker whose real trades all live in
   * a different portfolio) — deleting the stray record is the fix, not
   * uploading invoices that don't exist for this portfolio at all.
   *
   * Deletes every verification for this ticker in this portfolio, not just
   * the single latest one `reconcilePositions` surfaces: if more than one
   * stray reading was ever saved for the same ticker (e.g. a re-uploaded
   * screenshot misfiled twice), deleting only the currently-shown one would
   * silently leave the next-latest behind — same ticker, same banner row,
   * looking exactly like the click did nothing.
   */
  async function handleDeleteVerification(ticker: string, verificationId: string) {
    if (!confirm(t("portfolioDetail.discardVerificationConfirm"))) {
      return;
    }
    setDeleteError(null);
    try {
      const allForPortfolio = await repos.verifications.getByPortfolio(id);
      const matching = allForPortfolio.filter((v) => normalizeTicker(v.ticker) === normalizeTicker(ticker));
      await Promise.all(matching.map((v) => repos.verifications.delete(v.id)));
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setDeleteError({ tradeId: verificationId, message: e instanceof Error ? e.message : t("portfolioDetail.discardVerificationFailed") });
    }
  }

  if (portfolio === undefined || positions === undefined) {
    return <p className="text-sm text-slate-500">{t("common.loading")}</p>;
  }

  if (!portfolio) {
    return <EmptyState title={t("portfolioDetail.notFoundTitle")} description={t("portfolioDetail.notFoundDescription")} />;
  }

  const marketValue = positions.reduce((sum, p) => sum + (p.marketValue ?? p.costBasis), 0);
  const costBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

  // A mismatched ticker can have more than one duplicate (the same statement
  // re-uploaded more than twice) — suggestDuplicateTradeIds returns every
  // trade needed to close that ticker's whole gap, not just one, so this map
  // (and therefore "Clear all suspected duplicates") fully resolves every
  // mismatched ticker in a single pass rather than needing repeated clicks.
  const suspectedDuplicateIdsByTicker = new Map(
    positions.map((p) => {
      const r = reconciliationByTicker.get(p.ticker);
      const ids =
        r && !r.verificationStale && r.quantityMismatch
          ? suggestDuplicateTradeIds({ openTrades: p.openTrades, computedShares: r.computedShares, verifiedUnits: r.verifiedUnits, verifiedAvgCost: r.verifiedAvgCost })
          : [];
      return [p.ticker, ids] as const;
    })
  );
  const suspectedDuplicateIds = [...suspectedDuplicateIdsByTicker.values()].flat();

  async function handleClearAllSuspectedDuplicates() {
    if (suspectedDuplicateIds.length === 0) return;
    if (!confirm(t("portfolioDetail.clearAllDuplicatesConfirm", { n: suspectedDuplicateIds.length }))) {
      return;
    }
    setClearAllError(null);
    setClearingAll(true);
    const failures: string[] = [];
    for (const tradeId of suspectedDuplicateIds) {
      try {
        await deleteTrade(repos, tradeId);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : t("portfolioDetail.deleteTradeFailed"));
      }
    }
    setClearingAll(false);
    setRefreshKey((k) => k + 1);
    if (failures.length > 0) {
      setClearAllError(t("portfolioDetail.clearAllFailedSummary", { failed: failures.length, total: suspectedDuplicateIds.length, messages: failures.join("; ") }));
    }
  }

  return (
    <div>
      <PageHeader
        title={portfolio.name}
        description={`${portfolio.kind === "Custom" ? portfolio.customKindLabel || t("portfolioKind.Custom") : t(`portfolioKind.${portfolio.kind}`)} · ${portfolio.currency}`}
        actions={
          <>
            <button
              onClick={() => setRenameOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <Pencil size={16} /> {t("portfolioDetail.rename")}
            </button>
            <button
              onClick={() => setCashModal("editCash")}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <Banknote size={16} /> {t("portfolioDetail.editCash")}
            </button>
            <button
              onClick={() => setCashModal("dividend")}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <CircleDollarSign size={16} /> {t("portfolioDetail.dividend")}
            </button>
            <button
              onClick={() => setCashModal("adjustment")}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <Wrench size={16} /> {t("portfolioDetail.adjustCash")}
            </button>
            <button
              onClick={() => setCorporateActionOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <SplitSquareHorizontal size={16} /> {t("portfolioDetail.corporateAction")}
            </button>
            {portfolio.archivedAt ? (
              <button
                onClick={() => void unarchivePortfolio(repos, portfolio.id)}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                <ArchiveRestore size={16} /> {t("portfolioDetail.unarchive")}
              </button>
            ) : (
              <button
                onClick={() => {
                  if (confirm(t("portfolioDetail.archiveConfirm", { name: portfolio.name }))) {
                    void archivePortfolio(repos, portfolio.id);
                  }
                }}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                <Archive size={16} /> {t("portfolioDetail.archive")}
              </button>
            )}
          </>
        }
      />
      <PriceFreshness />

      {portfolio.archivedAt ? (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-300">
          {t("portfolioDetail.archivedBanner")}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("portfolioDetail.cashBalance")} value={formatMoney(portfolio.cash)} />
        <StatTile label={t("portfolioDetail.investedMarketValue")} value={formatMoney(marketValue)} sublabel={t("portfolioDetail.costBasisSub", { value: formatMoney(costBasis) })} />
        <StatTile
          label={t("portfolioDetail.unrealizedPnl")}
          value={formatMoney(unrealizedPnl)}
          valueClassName={signClass(unrealizedPnl)}
          sublabel={formatPercent(unrealizedPnlPct)}
        />
      </div>

      <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">{t("portfolioDetail.capitalDeployment")}</h3>
        <CapitalDeploymentFlow events={timelineEvents ?? []} />
      </div>

      <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-200">{t("portfolioDetail.holdings")}</h3>
          {suspectedDuplicateIds.length > 0 ? (
            <button
              onClick={() => void handleClearAllSuspectedDuplicates()}
              disabled={clearingAll}
              className="flex items-center gap-1.5 rounded-md border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
            >
              <Eraser size={13} />
              {clearingAll
                ? t("portfolioDetail.clearingDuplicates")
                : t("portfolioDetail.clearDuplicates", { n: suspectedDuplicateIds.length })}
            </button>
          ) : null}
        </div>
        {clearAllError ? (
          <p className="border-b border-slate-800 px-4 py-2 text-xs text-rose-400">{clearAllError}</p>
        ) : null}
        {positions.length === 0 ? (
          <div className="p-6">
            <EmptyState title={t("portfolioDetail.noOpenPositionsTitle")} description={t("portfolioDetail.noOpenPositionsDescription")} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-start text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">{t("portfolioDetail.colTicker")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colShares")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colAvgCost")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colCostBasis")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colCurrentPrice")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colMarketValue")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colUnrealizedPnl")}</th>
                  <th className="px-4 py-2 text-end">{t("portfolioDetail.colLots")}</th>
                  <th className="px-4 py-2">{t("portfolioDetail.colVerification")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {positions.map((p) => {
                  const r = reconciliationByTicker.get(p.ticker);
                  return (
                  <tr key={p.ticker}>
                    <td className="px-4 py-2.5 font-medium text-slate-100">
                      <Link href={`/portfolios/${id}/tickers/${p.ticker}`} className="hover:text-cyan-300 hover:underline">
                        {p.ticker}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatShares(p.totalShares)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatMoney(p.avgCost)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{formatMoney(p.costBasis)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">
                      {p.currentPrice !== undefined ? formatMoney(p.currentPrice) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">
                      {p.marketValue !== undefined ? formatMoney(p.marketValue) : "—"}
                    </td>
                    <td className={`px-4 py-2.5 text-end tabular-nums ${signClass(p.unrealizedPnl)}`}>
                      {p.unrealizedPnl !== undefined ? formatMoney(p.unrealizedPnl) : "—"}
                      {p.unrealizedPnlPct !== undefined ? (
                        <span className="ms-1 text-xs opacity-80">({formatPercent(p.unrealizedPnlPct)})</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-400">{p.openTrades.length}</td>
                    <td className="px-4 py-2.5">
                      {pendingConfirmationsByTicker.get(p.ticker)?.length ? (
                        <div className="flex flex-col gap-1.5">
                          {pendingConfirmationsByTicker.get(p.ticker)!.map((item) => (
                            <div key={item.refId} className="flex flex-col gap-1 rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1.5">
                              <span className="flex items-center gap-1 text-xs text-cyan-300">
                                <FileWarning size={13} /> {t("portfolioDetail.needsConfirmation")}
                              </span>
                              <span className="text-[11px] tabular-nums text-slate-400">
                                {item.side} {formatShares(item.shares)} {t("portfolioDetail.shSuffix")} @ {formatMoney(item.price)} · {formatDate(item.date)}
                              </span>
                              <label className="inline-flex w-fit cursor-pointer items-center gap-1 rounded border border-cyan-500/40 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/10">
                                <Upload size={11} />
                                {confirming[item.refId] ? t("portfolioDetail.confirming") : t("portfolioDetail.uploadInvoice")}
                                <input
                                  type="file"
                                  accept="image/*,.pdf,.csv,.xlsx"
                                  className="hidden"
                                  disabled={confirming[item.refId]}
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (file) void handleUploadInvoice(item, file);
                                  }}
                                />
                              </label>
                              {confirmError[item.refId] ? <p className="text-[11px] text-rose-400">{confirmError[item.refId]}</p> : null}
                            </div>
                          ))}
                        </div>
                      ) : !r ? (
                        <span className="text-xs text-slate-600">{t("common.dash")}</span>
                      ) : r.verificationStale ? (
                        <span className="text-xs text-slate-500">{t("portfolioDetail.verificationOutdated")}</span>
                      ) : r.quantityMismatch ? (
                        (() => {
                          const suggestedIds = new Set(suspectedDuplicateIdsByTicker.get(p.ticker) ?? []);
                          return (
                            <div className="flex flex-col gap-1.5">
                              <span className="flex items-center gap-1 text-xs text-rose-400">
                                <ShieldAlert size={13} /> {t("portfolioDetail.sharesVsVerified", { shares: formatShares(p.totalShares), verified: formatShares(r.verifiedUnits) })}
                              </span>
                              <p className="text-[11px] text-slate-500">
                                {t("portfolioDetail.duplicateImportHint", { n: suggestedIds.size })}
                              </p>
                              <ul className="space-y-1">
                                {p.openTrades.map((tr) => {
                                  const deletable = tr.remainingShares === tr.shares;
                                  const suspected = suggestedIds.has(tr.id);
                                  return (
                                    <li
                                      key={tr.id}
                                      className={`flex items-center gap-2 rounded px-1 py-0.5 text-[11px] ${
                                        suspected ? "bg-rose-500/10 text-rose-300" : "text-slate-400"
                                      }`}
                                    >
                                      <span className="tabular-nums">
                                        {formatShares(tr.shares)} sh @ {formatMoney(tr.entryPrice)} · {formatDate(tr.executionDate)}
                                      </span>
                                      {suspected ? (
                                        <span className="flex items-center gap-1 font-medium">
                                          <ShieldAlert size={11} /> {t("portfolioDetail.suspectedDuplicate")}
                                        </span>
                                      ) : null}
                                      {deletable ? (
                                        <button
                                          onClick={() => void handleDeleteTrade(tr.id)}
                                          title={t("portfolioDetail.deleteTradeTitle")}
                                          className={`rounded p-1 hover:bg-rose-500/10 hover:text-rose-400 ${suspected ? "text-rose-400" : "text-slate-500"}`}
                                        >
                                          <Trash2 size={12} />
                                        </button>
                                      ) : (
                                        <span title={t("portfolioDetail.cannotDeleteHasSells")} className="text-slate-700">
                                          <Trash2 size={12} />
                                        </span>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                              {deleteError && p.openTrades.some((tr) => tr.id === deleteError.tradeId) ? (
                                <p className="text-[11px] text-rose-400">{deleteError.message}</p>
                              ) : null}
                            </div>
                          );
                        })()
                      ) : r.quantityShortfall ? (
                        <span className="flex items-center gap-1 text-xs text-amber-400">
                          <ShieldAlert size={13} /> {t("portfolioDetail.missingShares", { n: formatShares(r.verifiedUnits - p.totalShares) })}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <ShieldCheck size={13} /> {t("portfolioDetail.matchesBroker")}
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
            <ShieldAlert size={16} /> {t("portfolioDetail.verifiedNoTradesTitle")}
          </p>
          <ul className="space-y-2 text-sm text-amber-200/80">
            {(reconciliations ?? [])
              .filter((r) => r.quantityShortfall && r.computedShares === 0)
              .map((r) => (
                <li key={r.ticker} className="flex items-start justify-between gap-2">
                  <div>
                    <span>
                      {t("portfolioDetail.verifiedNoTradesRow", {
                        ticker: r.ticker,
                        units: formatShares(r.verifiedUnits),
                        avgCostSuffix: r.verifiedAvgCost !== undefined ? t("portfolioDetail.avgCostSuffix", { avgCost: formatMoney(r.verifiedAvgCost) }) : "",
                      })}
                    </span>
                    <p className="text-[11px] text-amber-300/70">
                      {t("portfolioDetail.verifiedNoTradesHint", { date: trackingStartDate })}
                    </p>
                    {deleteError && deleteError.tradeId === r.verificationId ? (
                      <p className="mt-1 text-[11px] text-rose-400">{deleteError.message}</p>
                    ) : null}
                  </div>
                  <button
                    onClick={() => void handleDeleteVerification(r.ticker, r.verificationId)}
                    title={t("portfolioDetail.discardVerificationTitle")}
                    className="shrink-0 rounded p-1 text-amber-300/60 hover:bg-rose-500/10 hover:text-rose-400"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <CashModal kind={cashModal} portfolioId={portfolio.id} currentCash={portfolio.cash} onClose={() => setCashModal(null)} />
      <CorporateActionModal open={corporateActionOpen} portfolioId={portfolio.id} onClose={() => setCorporateActionOpen(false)} />
      <RenamePortfolioModal
        open={renameOpen}
        portfolioId={portfolio.id}
        currentName={portfolio.name}
        onClose={() => setRenameOpen(false)}
      />
    </div>
  );
}

function RenamePortfolioModal({
  open,
  portfolioId,
  currentName,
  onClose,
}: {
  open: boolean;
  portfolioId: string;
  currentName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(currentName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  async function handleSubmit() {
    if (!name.trim()) {
      setError(t("portfolioDetail.enterName"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await renamePortfolio(repos, portfolioId, name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("portfolioDetail.renameFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t("portfolioDetail.renameModalTitle")}
      open={open}
      onClose={() => {
        setName(currentName);
        setError(null);
        onClose();
      }}
    >
      <div className="space-y-3">
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolioDetail.nameLabel")}
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CashModal({
  kind,
  portfolioId,
  currentCash,
  onClose,
}: {
  kind: CashModalKind;
  portfolioId: string;
  currentCash: number;
  onClose: () => void;
}) {
  const t = useT();
  const trackingStartDate = useTrackingStartDate();
  const [amount, setAmount] = useState("");
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fills the field with the current balance when Edit Cash opens, once —
  // the input's value is otherwise just `amount`, so clearing it to type a new
  // number no longer snaps back to currentCash mid-edit (see the old
  // `amount === "" ? currentCash : amount` value prop this replaced).
  useEffect(() => {
    if (kind === "editCash") setAmount(String(currentCash));
  }, [kind, currentCash]);

  if (!kind) return null;

  const titles: Record<Exclude<CashModalKind, null>, string> = {
    editCash: t("portfolioDetail.cashModalTitleEditCash"),
    dividend: t("portfolioDetail.cashModalTitleDividend"),
    adjustment: t("portfolioDetail.cashModalTitleAdjustment"),
  };

  async function handleSubmit() {
    const n = Number.parseFloat(amount);
    if (kind === "editCash") {
      if (!Number.isFinite(n)) {
        setError(t("portfolioDetail.enterCorrectCashBalance"));
        return;
      }
    } else if (kind === "adjustment") {
      if (!Number.isFinite(n) || n === 0) {
        setError(t("portfolioDetail.enterNonZeroAmount"));
        return;
      }
      if (!notes.trim()) {
        setError(t("portfolioDetail.explainAdjustment"));
        return;
      }
    } else if (!Number.isFinite(n) || n <= 0) {
      setError(t("portfolioDetail.enterPositiveAmount"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const trimmedNotes = notes.trim() || undefined;
      if (kind === "editCash") await setCash(repos, portfolioId, n);
      else if (kind === "adjustment") await recordCashAdjustment(repos, portfolioId, n, notes.trim());
      else await recordDividend(repos, portfolioId, { ticker: ticker.trim() || undefined, amount: n, date: date || undefined, notes: trimmedNotes });
      setAmount("");
      setTicker("");
      setDate("");
      setNotes("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("portfolioDetail.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={titles[kind]} open={Boolean(kind)} onClose={onClose}>
      <div className="space-y-3">
        {kind === "editCash" ? (
          <p className="text-xs text-slate-400">
            {t("portfolioDetail.editCashDescription")}
          </p>
        ) : null}
        <label className="block text-xs text-slate-400 space-y-1">
          {kind === "adjustment" ? t("portfolioDetail.amountAdjustmentLabel") : kind === "editCash" ? t("portfolioDetail.cashBalanceLabel") : t("portfolioDetail.amountLabel")}
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        {kind === "dividend" ? (
          <>
            <label className="block text-xs text-slate-400 space-y-1">
              {t("portfolioDetail.tickerOptional")}
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
            <label className="block text-xs text-slate-400 space-y-1">
              {t("portfolioDetail.datePaidOptional")}
              <input
                type="date"
                min={trackingStartDate}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
          </>
        ) : null}
        {kind !== "editCash" ? (
          <label className="block text-xs text-slate-400 space-y-1">
            {t("portfolioDetail.notesLabel")}{kind === "adjustment" ? t("portfolioDetail.notesRequiredSuffix") : ""}
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        ) : null}
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
            {submitting ? t("common.saving") : t("common.confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Split/rights-issue are record-only by design (see PortfolioService) — this
 * logs the event on the timeline without rebasing existing trades' share
 * counts or entry prices, which was scoped out deliberately, not an
 * oversight (see ROADMAP.md "Next recommended sprint").
 */
function CorporateActionModal({
  open,
  portfolioId,
  onClose,
}: {
  open: boolean;
  portfolioId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<Exclude<CorporateActionKind, null>>("split");
  const [ticker, setTicker] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setKind("split");
    setTicker("");
    setNotes("");
    setError(null);
  }

  async function handleSubmit() {
    const trimmedTicker = ticker.trim();
    const trimmedNotes = notes.trim();
    if (!trimmedTicker) {
      setError(t("portfolioDetail.enterTicker"));
      return;
    }
    if (!trimmedNotes) {
      setError(kind === "split" ? t("portfolioDetail.describeSplit") : t("portfolioDetail.describeRightsIssue"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (kind === "split") await recordSplit(repos, portfolioId, { ticker: trimmedTicker, notes: trimmedNotes });
      else await recordRightsIssue(repos, portfolioId, { ticker: trimmedTicker, notes: trimmedNotes });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("portfolioDetail.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t("portfolioDetail.recordCorporateActionTitle")}
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          {t("portfolioDetail.corporateActionDescription")}
        </p>
        <div className="flex rounded-md border border-slate-700 p-0.5 text-xs">
          <button
            onClick={() => setKind("split")}
            className={`flex-1 rounded px-3 py-1.5 ${kind === "split" ? "bg-cyan-500 text-slate-950 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
          >
            {t("portfolioDetail.split")}
          </button>
          <button
            onClick={() => setKind("rightsIssue")}
            className={`flex-1 rounded px-3 py-1.5 ${kind === "rightsIssue" ? "bg-cyan-500 text-slate-950 font-medium" : "text-slate-300 hover:bg-slate-800"}`}
          >
            {t("portfolioDetail.rightsIssue")}
          </button>
        </div>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolioDetail.tickerLabel")}
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            placeholder="COMI"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          {t("portfolioDetail.detailsRequiredLabel")}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={kind === "split" ? "2-for-1 split" : "1-for-4 at 10 EGP"}
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
            {submitting ? t("common.saving") : t("portfolioDetail.record")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

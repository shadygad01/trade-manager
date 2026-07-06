import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import { ShieldAlert, Trash2, Eraser } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { deleteDividend } from "@application/services/PortfolioService";
import { suggestDuplicateDividendIdsToDelete } from "@application/services/duplicateDetection";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { TIMELINE_ICONS, TIMELINE_COLORS } from "@presentation/lib/timelineIcons";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import { useT, type TFunction } from "@presentation/i18n/translations";

function describe(event: TimelineEvent, t: TFunction): string {
  switch (event.type) {
    case "Buy":
      return t("timeline.bought", {
        shares: formatShares(event.shares),
        ticker: event.ticker ?? "",
        price: formatMoney(event.shares ? (event.amount ?? 0) / event.shares : undefined),
      }).trim();
    case "Sell":
      return t("timeline.sold", { shares: formatShares(event.shares), ticker: event.ticker ?? "" });
    case "PartialSell":
      return t("timeline.partiallySold", { shares: formatShares(event.shares), ticker: event.ticker ?? "" });
    case "Deposit":
      return t("timeline.deposited", { amount: formatMoney(event.amount) });
    case "Withdrawal":
      return t("timeline.withdrew", { amount: formatMoney(event.amount) });
    case "Dividend":
      return t("timeline.dividendEvent", {
        amount: formatMoney(event.amount),
        tickerSuffix: event.ticker ? t("timeline.fromTickerSuffix", { ticker: event.ticker }) : "",
      });
    case "Split":
      return t("timeline.stockSplit", { tickerSuffix: event.ticker ? t("timeline.onTickerSuffix", { ticker: event.ticker }) : "" });
    case "RightsIssue":
      return t("timeline.rightsIssueEvent", { tickerSuffix: event.ticker ? t("timeline.onTickerSuffix", { ticker: event.ticker }) : "" });
    case "CashAdjustment":
      return t("timeline.cashAdjustmentEvent", { amount: formatMoney(event.amount) });
    case "Note":
      return event.notes ?? t("timeline.note");
    default:
      return event.type;
  }
}

export function TimelinePage() {
  const t = useT();
  const { id: portfolioId } = useParams<{ id: string }>();
  const portfolio = useLiveQuery(() => repos.portfolios.getById(portfolioId), [portfolioId]);
  const events = useLiveQuery(() => repos.timeline.getByPortfolio(portfolioId), [portfolioId]);
  const [deleteError, setDeleteError] = useState<{ eventId: string; message: string } | null>(null);
  const [clearAllError, setClearAllError] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const duplicateDividendIds = useMemo(() => new Set(suggestDuplicateDividendIdsToDelete(events ?? [])), [events]);

  async function handleDeleteDividend(event: TimelineEvent) {
    if (!confirm(t("timeline.deleteDividendConfirm"))) {
      return;
    }
    setDeleteError(null);
    setDeletingId(event.id);
    try {
      await deleteDividend(repos, event);
    } catch (e) {
      setDeleteError({ eventId: event.id, message: e instanceof Error ? e.message : t("timeline.deleteDividendFailed") });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleClearDuplicateDividends() {
    const ids = [...duplicateDividendIds];
    if (ids.length === 0) return;
    if (!confirm(t("timeline.clearDuplicatesConfirm", { n: ids.length }))) {
      return;
    }
    setClearAllError(null);
    setClearingAll(true);
    const failures: string[] = [];
    const byId = new Map((events ?? []).map((e) => [e.id, e]));
    for (const id of ids) {
      const event = byId.get(id);
      if (!event) continue;
      try {
        await deleteDividend(repos, event);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : t("timeline.deleteDividendGenericFailed"));
      }
    }
    setClearingAll(false);
    if (failures.length > 0) {
      setClearAllError(t("timeline.clearAllFailedSummary", { failed: failures.length, total: ids.length, messages: failures.join("; ") }));
    }
  }

  const grouped = useMemo(() => {
    const sorted = [...(events ?? [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const groups = new Map<string, TimelineEvent[]>();
    for (const e of sorted) {
      const day = e.timestamp.slice(0, 10);
      const arr = groups.get(day) ?? [];
      arr.push(e);
      groups.set(day, arr);
    }
    return Array.from(groups.entries());
  }, [events]);

  return (
    <div>
      <PageHeader
        title={portfolio ? t("timeline.titleWithPortfolio", { name: portfolio.name }) : t("timeline.title")}
        description={t("timeline.description")}
        actions={
          duplicateDividendIds.size > 0 ? (
            <button
              onClick={() => void handleClearDuplicateDividends()}
              disabled={clearingAll}
              className="flex items-center gap-1.5 rounded-md border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
            >
              <Eraser size={14} />
              {clearingAll ? t("timeline.clearing") : t("timeline.clearDuplicateDividends", { n: duplicateDividendIds.size })}
            </button>
          ) : undefined
        }
      />

      {clearAllError ? <p className="mb-4 text-sm text-rose-400">{clearAllError}</p> : null}

      {grouped.length === 0 ? (
        <EmptyState title={t("timeline.noActivityTitle")} description={t("timeline.noActivityDescription")} />
      ) : (
        <div className="space-y-6">
          {grouped.map(([day, dayEvents]) => (
            <div key={day}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{formatDate(day)}</p>
              <div className="space-y-2">
                {dayEvents.map((event) => {
                  const Icon = TIMELINE_ICONS[event.type];
                  const isDividend = event.type === "Dividend";
                  const suspectedDuplicate = duplicateDividendIds.has(event.id);
                  return (
                    <div
                      key={event.id}
                      className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                        suspectedDuplicate ? "border-rose-500/30 bg-rose-500/5" : "border-slate-800 bg-slate-900/60"
                      }`}
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TIMELINE_COLORS[event.type]}`}>
                        <Icon size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="flex flex-wrap items-center gap-2">
                            <p className="text-sm text-slate-100">{describe(event, t)}</p>
                            {suspectedDuplicate ? (
                              <span className="flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300">
                                <ShieldAlert size={11} /> {t("timeline.suspectedDuplicate")}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="text-xs text-slate-500">
                              {new Date(event.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            {isDividend ? (
                              <button
                                onClick={() => void handleDeleteDividend(event)}
                                disabled={deletingId === event.id}
                                title={t("timeline.deleteDividendTitle")}
                                className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50"
                              >
                                <Trash2 size={13} />
                              </button>
                            ) : null}
                          </span>
                        </div>
                        {event.notes ? <p className="mt-1 break-words text-xs text-slate-500">{event.notes}</p> : null}
                        {deleteError && deleteError.eventId === event.id ? (
                          <p className="mt-1 text-xs text-rose-400">{deleteError.message}</p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

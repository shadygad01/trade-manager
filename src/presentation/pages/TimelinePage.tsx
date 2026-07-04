import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import { repos } from "@presentation/lib/data";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { TIMELINE_ICONS, TIMELINE_COLORS } from "@presentation/lib/timelineIcons";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";

function describe(event: TimelineEvent): string {
  switch (event.type) {
    case "Buy":
      return `Bought ${formatShares(event.shares)} ${event.ticker ?? ""} @ ${formatMoney(
        event.shares ? (event.amount ?? 0) / event.shares : undefined,
      )}`.trim();
    case "Sell":
      return `Sold ${formatShares(event.shares)} ${event.ticker ?? ""}`;
    case "PartialSell":
      return `Partially sold ${formatShares(event.shares)} ${event.ticker ?? ""}`;
    case "Deposit":
      return `Deposited ${formatMoney(event.amount)}`;
    case "Withdrawal":
      return `Withdrew ${formatMoney(event.amount)}`;
    case "Dividend":
      return `Dividend ${formatMoney(event.amount)}${event.ticker ? ` from ${event.ticker}` : ""}`;
    case "Split":
      return `Stock split${event.ticker ? ` on ${event.ticker}` : ""}`;
    case "RightsIssue":
      return `Rights issue${event.ticker ? ` on ${event.ticker}` : ""}`;
    case "CashAdjustment":
      return `Cash adjustment ${formatMoney(event.amount)}`;
    case "Note":
      return event.notes ?? "Note";
    default:
      return event.type;
  }
}

export function TimelinePage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const events = useLiveQuery(() => repos.timeline.getByPortfolio(portfolioId), [portfolioId]);

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
      <PageHeader title="Timeline" description="Every buy, sell, deposit and cash event, in order." />

      {grouped.length === 0 ? (
        <EmptyState title="No activity yet" description="Trades and cash movements will appear here as they happen." />
      ) : (
        <div className="space-y-6">
          {grouped.map(([day, dayEvents]) => (
            <div key={day}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{formatDate(day)}</p>
              <div className="space-y-2">
                {dayEvents.map((event) => {
                  const Icon = TIMELINE_ICONS[event.type];
                  return (
                    <div
                      key={event.id}
                      className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3"
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TIMELINE_COLORS[event.type]}`}>
                        <Icon size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm text-slate-100">{describe(event)}</p>
                          <span className="text-xs text-slate-500">
                            {new Date(event.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        {event.notes ? <p className="mt-1 text-xs text-slate-500">{event.notes}</p> : null}
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

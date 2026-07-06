import { ChevronRight } from "lucide-react";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import { TIMELINE_ICONS, TIMELINE_COLORS } from "@presentation/lib/timelineIcons";
import { formatDate, formatMoney } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

const FLOW_EVENT_TYPES = new Set(["Buy", "Sell", "PartialSell", "Deposit", "Withdrawal", "Dividend", "CashAdjustment"]);

function chipLabel(event: TimelineEvent): string {
  if (event.type === "Buy" || event.type === "Sell" || event.type === "PartialSell") {
    const amount = event.amount !== undefined ? formatMoney(Math.abs(event.amount)) : "";
    return `${event.ticker ?? ""} ${amount}`.trim();
  }
  return event.amount !== undefined ? formatMoney(Math.abs(event.amount)) : event.type;
}

/**
 * A compact, chronological "where has capital moved" strip — not a chart (no
 * axes/magnitude encoding), so it skips the dataviz color/mark procedure;
 * it's an information graphic reusing TimelinePage's own icon/color mapping
 * for visual consistency and to avoid introducing any new palette.
 */
export function CapitalDeploymentFlow({ events }: { events: TimelineEvent[] }) {
  const t = useT();
  const relevant = [...events]
    .filter((e) => FLOW_EVENT_TYPES.has(e.type))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (relevant.length === 0) {
    return <p className="text-sm text-slate-500">{t("capitalFlow.noMovement")}</p>;
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-2">
      {relevant.map((event, i) => {
        const Icon = TIMELINE_ICONS[event.type];
        return (
          <div key={event.id} className="flex shrink-0 items-center gap-1">
            <div
              className={`flex shrink-0 flex-col items-center gap-1 rounded-lg border border-slate-800 px-3 py-2 text-center ${TIMELINE_COLORS[event.type]}`}
              title={`${event.type}${event.ticker ? ` · ${event.ticker}` : ""} · ${formatDate(event.timestamp.slice(0, 10))}`}
            >
              <Icon size={16} />
              <span className="whitespace-nowrap text-[11px] font-medium">{chipLabel(event)}</span>
              <span className="text-[10px] text-slate-500">{formatDate(event.timestamp.slice(0, 10))}</span>
            </div>
            {i < relevant.length - 1 ? <ChevronRight size={14} className="shrink-0 text-slate-700" /> : null}
          </div>
        );
      })}
    </div>
  );
}

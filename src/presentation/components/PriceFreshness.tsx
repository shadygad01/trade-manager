import { useLiveQuery } from "dexie-react-hooks";
import { Clock, AlertTriangle } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { formatDateTime, formatMarketCloseDateTime } from "@presentation/lib/format";
import { useT } from "@presentation/i18n/translations";

/**
 * EGX trades Sun-Thu, so a snapshot can legitimately be up to ~3 calendar
 * days behind over a weekend + holiday before it means the feed is broken.
 */
const STALE_AFTER_DAYS = 4;

/**
 * Every figure derived from a market price (current price, market value,
 * unrealized P/L) is only as fresh as the price snapshot behind it — this
 * says exactly which close those figures represent, instead of presenting
 * a possibly days-old number as "current" with no cue. Prefers the actual
 * market quote time captured by the fetch pipeline (the official close
 * time after the session) over the pipeline's own run time, and escalates
 * to an explicit warning when the snapshot is older than the EGX's longest
 * normal quiet stretch.
 */
export function PriceFreshness() {
  const t = useT();
  const info = useLiveQuery(() => repos.prices.getSnapshotInfo(), []);
  if (info === undefined) return null;
  if (info === null) {
    return (
      <p className="mb-5 inline-flex items-center gap-2 rounded-lg border border-amber-400/15 bg-amber-400/[.06] px-3 py-2 text-xs text-amber-300">
        <AlertTriangle size={14} />
        {t("priceFreshness.none")}
      </p>
    );
  }

  const timestamp = info.latestQuoteAt ?? info.asOf;
  const usingQuoteTime = info.latestQuoteAt !== undefined;
  const displayTime = usingQuoteTime ? formatMarketCloseDateTime(timestamp) : formatDateTime(timestamp);
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / 86_400_000;
  const stale = ageDays > STALE_AFTER_DAYS;

  if (stale) {
    return (
      <p className="mb-5 inline-flex items-center gap-2 rounded-lg border border-amber-400/15 bg-amber-400/[.06] px-3 py-2 text-xs text-amber-300">
        <AlertTriangle size={14} />
        {t("priceFreshness.stale", { time: displayTime })}
      </p>
    );
  }
  return (
    <p className="mb-5 inline-flex items-center gap-2 rounded-lg border border-white/[.06] bg-white/[.025] px-3 py-2 text-xs text-slate-500">
      <Clock size={14} className="text-teal-400" />
      {t("priceFreshness.fresh", { time: displayTime, quoteSuffix: usingQuoteTime ? t("priceFreshness.lastMarketClose") : "" })}
    </p>
  );
}

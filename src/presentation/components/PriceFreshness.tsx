import { useLiveQuery } from "dexie-react-hooks";
import { Clock, AlertTriangle } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { formatDateTime } from "@presentation/lib/format";

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
  const info = useLiveQuery(() => repos.prices.getSnapshotInfo(), []);
  if (info === undefined) return null;
  if (info === null) {
    return (
      <p className="mb-4 flex items-center gap-1.5 text-xs text-amber-300">
        <AlertTriangle size={12} />
        No market prices loaded yet — current prices and unrealized P/L fall back to cost basis until the price feed
        publishes its first snapshot.
      </p>
    );
  }

  const timestamp = info.latestQuoteAt ?? info.asOf;
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / 86_400_000;
  const stale = ageDays > STALE_AFTER_DAYS;

  if (stale) {
    return (
      <p className="mb-4 flex items-center gap-1.5 text-xs text-amber-300">
        <AlertTriangle size={12} />
        Prices are from {formatDateTime(timestamp)} — the feed hasn't updated since, so current prices and unrealized
        P/L below are outdated.
      </p>
    );
  }
  return (
    <p className="mb-4 flex items-center gap-1.5 text-xs text-slate-500">
      <Clock size={12} />
      Prices as of {formatDateTime(timestamp)}{info.latestQuoteAt ? " (last market close)" : ""} — current prices and
      unrealized P/L reflect this snapshot.
    </p>
  );
}

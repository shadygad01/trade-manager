/**
 * Shared tracked-date-range helper for BrokerParser implementations. A
 * hardcoded cutoff literal silently goes stale the moment "now" passes it;
 * deriving the default from call time (a rolling N-year lookback) never
 * goes stale, while remaining fully overridable per instance.
 */
const DEFAULT_TRACKED_YEARS_BACK = 3;

export function defaultTrackedSince(yearsBack: number = DEFAULT_TRACKED_YEARS_BACK): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - yearsBack);
  return d.toISOString().slice(0, 10);
}

// A trade dated after "tomorrow" (a one-day grace window for timezone skew)
// is essentially always a misread date rather than a genuine future trade.
export function isoTomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function isWithinTrackedRange(dateIso: string, trackedSince: string): boolean {
  return dateIso >= trackedSince && dateIso <= isoTomorrow();
}

export function partitionByRange<T extends { date: string }>(
  candidates: T[],
  isWithinRange: (dateIso: string) => boolean,
): { inRange: T[]; outOfRangeCount: number } {
  const inRange = candidates.filter((c) => isWithinRange(c.date));
  return { inRange, outOfRangeCount: candidates.length - inRange.length };
}

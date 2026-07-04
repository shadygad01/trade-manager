import { TRACKING_START_DATE } from "@domain/value-objects/trackingWindow";

/** Shared tracked-date-range helper for BrokerParser implementations. */
export function defaultTrackedSince(): string {
  return TRACKING_START_DATE;
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

/**
 * The ledger's configurable start date — any transaction dated earlier is
 * out of scope for the whole app (OCR import filtering, manual entry
 * validation), not just unlikely to be relevant. Defaults here; the
 * presentation layer's Import page lets the user lower it (to read older
 * broker history) and persists that choice across reloads (see
 * trackingStartDateStore.ts), which is why this is a settable module-level
 * value rather than a fixed constant.
 */
const DEFAULT_TRACKING_START_DATE = "2026-01-01";

let trackingStartDate = DEFAULT_TRACKING_START_DATE;

export function getTrackingStartDate(): string {
  return trackingStartDate;
}

export function setTrackingStartDate(dateIso: string): void {
  trackingStartDate = dateIso;
}

export function isBeforeTrackingStart(dateIso: string): boolean {
  return dateIso < trackingStartDate;
}

/**
 * The ledger deliberately starts on this date — any transaction dated
 * earlier is out of scope for the whole app (OCR import filtering, manual
 * entry validation), not just unlikely to be relevant.
 */
export const TRACKING_START_DATE = "2026-01-01";

export function isBeforeTrackingStart(dateIso: string): boolean {
  return dateIso < TRACKING_START_DATE;
}

/**
 * Ground truth captured from a broker "My Position" screenshot, independent
 * from statement-derived trades. Used to detect OCR-import drift (computed
 * holdings that don't match what the broker actually shows) without ever
 * silently overwriting the trade ledger — see AnalyticsEngine/ImportService
 * for how mismatches are surfaced.
 */
export interface PositionVerification {
  id: string;
  portfolioId: string;
  ticker: string;
  companyName?: string;
  units: number;
  avgCost?: number;
  capturedAt: string;
  source: "screenshot" | "manual";
}

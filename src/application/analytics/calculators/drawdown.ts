import type { EquityPoint } from "./equityCurve";

/** Maximum peak-to-trough decline, as a percentage of the peak, across an equity curve. */
export function drawdown(equityCurve: EquityPoint[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0].equity;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100);
    }
  }
  return maxDrawdownPct;
}

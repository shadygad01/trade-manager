/** Invested market value as a percentage of total equity. */
export function exposure(investedMarketValue: number, totalEquity: number): number {
  if (totalEquity <= 0) return 0;
  return (investedMarketValue / totalEquity) * 100;
}

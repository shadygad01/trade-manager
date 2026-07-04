/** Cash as a percentage of total equity. */
export function cashRatio(cash: number, totalEquity: number): number {
  if (totalEquity <= 0) return 0;
  return (cash / totalEquity) * 100;
}

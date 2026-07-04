/** Invested capital (cost basis of open positions) as a percentage of total equity. */
export function capitalDeployment(investedCostBasis: number, totalEquity: number): number {
  if (totalEquity <= 0) return 0;
  return (investedCostBasis / totalEquity) * 100;
}

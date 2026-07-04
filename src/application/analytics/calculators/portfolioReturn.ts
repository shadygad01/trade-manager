/** Total return % since inception = (current equity - net contributions) / net contributions, where net contributions = deposits - withdrawals. */
export function portfolioReturn(currentEquity: number, deposits: number, withdrawals: number): number {
  const netContributions = deposits - withdrawals;
  if (netContributions === 0) return 0;
  return ((currentEquity - netContributions) / netContributions) * 100;
}

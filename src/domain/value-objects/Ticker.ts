/**
 * Normalizes broker/exchange ticker spellings to one canonical form.
 * EGX tickers are frequently seen with a ".CA" suffix (Yahoo/TradingView
 * convention) or in mixed case from OCR — normalize once at the boundary
 * so every downstream comparison (positions, dedup, price lookup) is exact.
 */
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase().replace(/\.CA$/, "");
}

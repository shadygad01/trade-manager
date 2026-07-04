import { KNOWN_EGX_TICKERS } from "./knownTickers";

/**
 * Sector classification for the same known-ticker universe as
 * `knownTickers.ts` — kept as a separate map (not merged into that file)
 * because a ticker's sector is a distinct fact from its resolution entry
 * and a future per-trade manual override should never have to touch the
 * OCR/price-fetch ticker list to do so.
 */
const SECTOR_BY_TICKER: Readonly<Record<string, string>> = {
  COMI: "Banking",
  HRHO: "Financial Services",
  TMGH: "Real Estate",
  SWDY: "Industrial & Electrical Equipment",
  EAST: "Consumer Goods (Tobacco)",
  ETEL: "Telecommunications",
  ABUK: "Fertilizers & Chemicals",
  AMOC: "Oil & Gas Refining",
  ORWE: "Textiles",
  EFIH: "Financial Services",
  CIEB: "Banking",
  ADIB: "Banking",
  SKPC: "Petrochemicals",
  EKHO: "Diversified Holdings",
  MFPC: "Fertilizers & Chemicals",
  ISPH: "Healthcare & Pharmaceuticals",
  PHAR: "Healthcare & Pharmaceuticals",
  CSAG: "Shipping & Logistics",
  JUFO: "Food & Beverage",
  EMFD: "Real Estate",
  ORAS: "Construction & Engineering",
  ARCC: "Building Materials",
  ORHD: "Real Estate",
};

/** Every entry in `KNOWN_EGX_TICKERS` must be classified — this is asserted by a test, not just assumed. */
export const KNOWN_SECTOR_TICKERS: readonly string[] = KNOWN_EGX_TICKERS.map((t) => t.ticker);

/** Best-effort sector guess for a ticker. Returns undefined for anything outside the known universe rather than guessing. */
export function sectorForTicker(ticker: string): string | undefined {
  return SECTOR_BY_TICKER[ticker];
}

/** Label used wherever a position's sector can't be determined — an honest bucket, never a fabricated guess. */
export const UNCLASSIFIED_SECTOR = "Unclassified";

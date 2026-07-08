/**
 * EGX tickers known to the platform out of the box (used to seed OCR
 * company-name resolution and the price-fetch snapshot's default universe).
 * Both the OCR subsystem and the price pipeline read from this single list
 * so they never drift into two different "known ticker" sets. Extend this
 * list — do not fork it.
 */
export const KNOWN_EGX_TICKERS: readonly { ticker: string; companyName: string }[] = [
  { ticker: "COMI", companyName: "COMMERCIAL INTERNATIONAL BANK" },
  { ticker: "HRHO", companyName: "EFG HOLDING" },
  { ticker: "TMGH", companyName: "TALAAT MOUSTAFA GROUP" },
  { ticker: "SWDY", companyName: "ELSEWEDY ELECTRIC" },
  { ticker: "EAST", companyName: "EASTERN COMPANY" },
  { ticker: "ETEL", companyName: "TELECOM EGYPT" },
  { ticker: "ABUK", companyName: "ABU QIR FERTILIZERS" },
  { ticker: "AMOC", companyName: "ALEXANDRIA MINERAL OILS" },
  { ticker: "ORWE", companyName: "ORIENTAL WEAVERS" },
  { ticker: "EFIH", companyName: "E-FINANCE" },
  { ticker: "CIEB", companyName: "CREDIT AGRICOLE EGYPT" },
  { ticker: "ADIB", companyName: "ABU DHABI ISLAMIC BANK EGYPT" },
  { ticker: "SKPC", companyName: "SIDI KERIR PETROCHEMICALS" },
  { ticker: "EKHO", companyName: "EGYPT KUWAIT HOLDING" },
  { ticker: "MFPC", companyName: "MOPCO" },
  { ticker: "ISPH", companyName: "IBNSINA PHARMA" },
  { ticker: "PHAR", companyName: "EGYPTIAN INTERNATIONAL PHARMACEUTICAL INDUSTRIES" },
  { ticker: "CSAG", companyName: "CANAL SHIPPING AGENCIES" },
  { ticker: "JUFO", companyName: "JUHAYNA FOOD INDUSTRIES" },
  { ticker: "EMFD", companyName: "EMAAR MISR" },
  { ticker: "ORAS", companyName: "ORASCOM CONSTRUCTION" },
  { ticker: "ARCC", companyName: "ARABIAN CEMENT" },
  { ticker: "ORHD", companyName: "ORASCOM DEVELOPMENT EGYPT" },
  { ticker: "SUGR", companyName: "DELTA SUGAR" },
  { ticker: "MASR", companyName: "MEDINET MASR HOUSING" },
  { ticker: "RMDA", companyName: "RAMEDA PHARMACEUTICAL COMPANY" },
  { ticker: "FIRE", companyName: "FIRST INVESTMENT & REAL ESTATE DEVELOPMENT" },
];

/**
 * A second (or third) name Thndr itself uses for a company already listed
 * above — a shortened statement-row form, a differently-punctuated legal
 * name, etc. — kept separate from `KNOWN_EGX_TICKERS` rather than added as
 * a duplicate row there: that list is one-entry-per-ticker everywhere else
 * it's read (sector classification, the price-fetch universe,
 * `TradeService.companyNameForTicker`'s `.find()`), and a second row for the
 * same ticker would silently change which company name those pick up.
 * OCR company-name resolution is the only consumer that also needs to
 * recognize alias text, so it reads this list too (see ThndrParser's
 * `COMPANY_TICKER_MAP`).
 */
export const COMPANY_NAME_ALIASES: readonly { ticker: string; companyName: string }[] = [
  // EIPICO's statement rows print "Egyptian International Pharmaceuticals"
  // (no "Industries", no bracketed symbol) — a shorter form of the
  // registered name above, not a different company.
  { ticker: "PHAR", companyName: "EGYPTIAN INTERNATIONAL PHARMACEUTICALS" },
];

/** Instruments a broker may report that are not tradeable equities (exclude from ticker resolution). */
export const NON_STOCK_INSTRUMENTS = new Set(["THNDRSAVINGS", "AZG"]);

/**
 * Resolves a company-name-as-ticker fallback back to its real EGX symbol.
 * When OCR can't map a company name it files the whole ticker group under
 * the raw name itself (e.g. a "DELTA SUGAR" group instead of SUGR) — and
 * once the mapping is later added to KNOWN_EGX_TICKERS, new imports resolve
 * correctly but the already-created group (and any trades committed under
 * the fallback name) keep the wrong identity forever. This lets the Import
 * page recognize such a group and offer a one-click rename to the real
 * symbol. Exact normalized match only — a rename rewrites committed rows,
 * so a fuzzy guess is not acceptable here.
 */
export function tickerForCompanyNameFallback(name: string): string | undefined {
  const key = name.trim().toUpperCase();
  if (key.length < 5 || !key.includes(" ")) return undefined;
  const match =
    KNOWN_EGX_TICKERS.find((t) => t.companyName === key) ?? COMPANY_NAME_ALIASES.find((t) => t.companyName === key);
  return match?.ticker;
}

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
];

/** Instruments a broker may report that are not tradeable equities (exclude from ticker resolution). */
export const NON_STOCK_INSTRUMENTS = new Set(["THNDRSAVINGS", "AZG"]);

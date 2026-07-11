export type UploadStatus = "pending" | "parsed" | "failed" | "duplicate";

export type ParseConfidence = "high" | "medium" | "low";

export interface ParsedTradeCandidate {
  ticker: string;
  companyName?: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  date: string;
  time?: string;
  /**
   * How confident the OCR subsystem is in this candidate: "high" when the
   * ticker was an exact/anchored match and the row was read unambiguously,
   * "medium" when a fuzzy ticker match or a positional (non-row-isolated)
   * field pairing was involved, "low" when the ticker fell back to an
   * unmapped guess. Never withheld — the user always sees the candidate,
   * just with a cue to double-check it before confirming.
   */
  confidence?: ParseConfidence;
  /**
   * Which document type this candidate was read from — the basis of the
   * dual-source verification rule: the same transaction (identical
   * ticker/side/date/share count) read from TWO DIFFERENT document types is
   * independently corroborated and needs no broker "My Position" recount
   * (see duplicateDetection's findCrossSourceVerifiedKeys). Two reads from
   * the SAME type (two statements, two orders screenshots) are never a pair
   * — that's a re-upload, not independent confirmation. "invoice" is
   * additionally trusted as sufficient verification entirely on its own
   * (standardized, field-labeled document — see checkTickerMatch's
   * invoice-verified). Undefined only on candidates extracted before this
   * field existed; those can still pair with an invoice (the original
   * cross-verification rule) but never with each other.
   */
  source?: "statement" | "invoice" | "orders-screen" | "csv" | "notification" | "email" | "screenshot" | "other-document";
  /** How this candidate's text was obtained — see RawTransaction.ExtractionMethod's own doc comment. */
  extractionMethod?: "native-pdf-text" | "ocr-tesseract" | "csv-text" | "manual-entry" | "stes-workbook";
  /** Which released BrokerParser version produced this candidate — see RawTransaction.parserVersion's own doc comment. */
  parserVersion?: string;
  /**
   * Broker-assigned unique execution identifier (e.g. Thndr's Invoice
   * "Transaction No.", like "N000248458443") — the single most reliable
   * signal two reads describe the same real-world execution, since it's
   * printed verbatim rather than derived/positionally guessed. Currently
   * only the Invoice document shape prints one; other Thndr formats (the
   * statement, the Orders screens) never carry a per-row identifier at all.
   * When present on both sides of a comparison, duplicate/cross-document
   * matching prefers this over ticker/date/shares/price — see
   * duplicateDetection.ts's sameExecution().
   */
  transactionNumber?: string;
  /**
   * STES-only: set when the extracting AI wrote "Needs Confirmation" into
   * the row's Extraction Notes cell (see STANDARD_TRADING_EXCHANGE_SCHEMA.md)
   * — a partial-fill execution whose exact final numbers still need
   * confirming against the broker invoice. Committing this candidate flags
   * the resulting Trade/TradeAllocation `confirmationStatus: "pending"`
   * instead of leaving the signal to rot in free text.
   */
  needsConfirmation?: boolean;
}

/**
 * One order row read from a broker's account-wide order-history screen —
 * the full-account history (every ticker mixed together), never imported as
 * a trade candidate itself; it corroborates transactions extracted from
 * other documents (see application/services/orderEvidence.ts). Two distinct
 * broker screens populate this shape:
 *
 * - The "Orders" timeline (order type + limit/execution price, no execution
 *   date, no printed share count — shares are derived from totalValue /
 *   price, which lands on a whole number for a real row, used as a
 *   self-check). Matched against a pending candidate by ticker/side/shares/
 *   price.
 * - The account-wide "Transactions" list (a real execution date + time, and
 *   the order's signed total value, but no order type, share count, or
 *   per-share price at all). Matched against a pending candidate by
 *   ticker/side/date and total value ≈ shares × price instead, since that's
 *   genuinely all this screen prints. `date` is set only for this shape —
 *   its presence is what the matcher branches on.
 *
 * Either way a candidate matched by a fulfilled order here is confirmed by
 * the broker's own order history, and a candidate whose numbers match
 * another ticker's order is likely misfiled under a wrong ticker guess.
 */
export interface ParsedOrderEvidence {
  ticker: string;
  companyName?: string;
  side: "BUY" | "SELL";
  /** Only known from the "Orders" timeline shape — undefined for a "Transactions" list row. */
  orderType?: "limit" | "market";
  /** Derived: totalValue / price, rounded to the whole-share count it lands on. Undefined for a "Transactions" list row (no price to derive from). */
  shares?: number;
  price?: number;
  totalValue: number;
  status: "fulfilled" | "cancelled";
  confidence?: ParseConfidence;
  /** Execution date (ISO), set only for the dated "Transactions" list shape — see the interface doc comment. */
  date?: string;
  time?: string;
  /** How this evidence row's text was obtained — see RawTransaction.ExtractionMethod's own doc comment. */
  extractionMethod?: "native-pdf-text" | "ocr-tesseract" | "csv-text" | "manual-entry";
  /** Which released BrokerParser version produced this evidence — see RawTransaction.parserVersion's own doc comment. */
  parserVersion?: string;
}

/** A dividend payout read from a broker's "My Position" / dividends history screen, or from an STES workbook DIVIDEND observation. */
export interface ParsedDividendCandidate {
  ticker: string;
  companyName?: string;
  date: string;
  amount: number;
  /** Which document type the observation came from (STES imports only) — recorded onto the DividendPayment fact; undefined keeps the pre-STES "position-verification" recording default. */
  source?: "statement" | "invoice" | "orders-screen" | "csv" | "notification" | "email" | "screenshot" | "other-document";
}

/**
 * One imported screenshot/PDF/CSV and the outcome of running it through the
 * OCR subsystem. Not tied to a single portfolio: one upload's candidates can
 * each be assigned to a different portfolio during review (a statement
 * mixing trades meant for more than one of the user's portfolios), so
 * `portfolioId` is only set when every candidate ended up in the same one.
 */
export interface Upload {
  id: string;
  portfolioId?: string;
  fileName: string;
  fileHash: string;
  contentType: string;
  status: UploadStatus;
  candidates: ParsedTradeCandidate[];
  rawText?: string;
  /**
   * The original document's bytes, kept permanently alongside the extracted
   * `rawText` — an Evidence Repository that only keeps what one parsing pass
   * happened to read can never be re-examined if extraction logic improves
   * later, or re-OCR'd from the source if the read was wrong. Optional only
   * for uploads recorded before this field existed; every new upload sets
   * it. Never populated for `contentType: "text/plain"`/CSV uploads — the
   * file's bytes already ARE `rawText` verbatim, so keeping both would be a
   * pure duplicate.
   */
  fileBlob?: Blob;
  errorMessage?: string;
  createdAt: string;
  parsedAt?: string;
}

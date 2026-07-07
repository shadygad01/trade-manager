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
  source?: "statement" | "invoice" | "orders-screen" | "csv";
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
}

/** A dividend payout read from a broker's "My Position" / dividends history screen. */
export interface ParsedDividendCandidate {
  ticker: string;
  companyName?: string;
  date: string;
  amount: number;
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
  errorMessage?: string;
  createdAt: string;
  parsedAt?: string;
}

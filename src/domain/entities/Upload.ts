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
   * "invoice" marks a candidate read from a standardized per-trade Invoice
   * document (see ThndrParser's Invoice format) rather than an OCR'd
   * screenshot/statement — trusted as sufficient verification for its own
   * transaction on its own, without needing a broker "My Position"
   * screenshot too (see importVerification's checkTickerMatch). Undefined
   * for every other source.
   */
  source?: "invoice";
}

/**
 * One order row read from a broker's account-wide "Orders" timeline screen —
 * the full-account order history (every ticker mixed together), each row
 * carrying the real ticker code, side, order type, limit/execution price,
 * the order's total value, and a Fulfilled/Cancelled status, but NO
 * execution date and no printed share count (shares are derived from
 * totalValue / price, which lands on a whole number for a real row — the
 * parser uses that as a self-check). Because rows are undated they are never
 * imported as trades themselves; they corroborate transactions extracted
 * from other documents (see application/services/orderEvidence.ts): a
 * pending candidate matched by a fulfilled order here is confirmed by the
 * broker's own order history, and a candidate whose shares/price match
 * another ticker's order is likely misfiled under a wrong ticker guess.
 */
export interface ParsedOrderEvidence {
  ticker: string;
  companyName?: string;
  side: "BUY" | "SELL";
  orderType: "limit" | "market";
  /** Derived: totalValue / price, rounded to the whole-share count it lands on. */
  shares: number;
  price: number;
  totalValue: number;
  status: "fulfilled" | "cancelled";
  confidence?: ParseConfidence;
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

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

export type UploadStatus = "pending" | "parsed" | "failed" | "duplicate";

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
}

/** One imported screenshot/PDF and the outcome of running it through the OCR subsystem. */
export interface Upload {
  id: string;
  portfolioId: string;
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

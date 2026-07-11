/**
 * A RawTransaction is an immutable, append-only fact — the single persistent
 * source of truth this app's ledger/allocations/holdings/analytics are all
 * derived from. It is never edited or physically deleted after being
 * written: a correction is a new RawTransaction whose `supersedes` points at
 * the row it corrects, and a retraction is a new RawTransaction whose
 * `supersedes` points at the row it voids. Readers resolve "the current view
 * of fact X" by folding a row's supersede/retract chain, not by mutating it.
 *
 * `seq` is assigned by the repository at append time (monotonic insertion
 * order) and is the only ordering ever used to detect a write race — never
 * `payload`-level dates, which are real-world execution times and may arrive
 * out of order relative to when they were recorded.
 */

export type RawTransactionKind =
  | "BuyExecution"
  | "SellExecution"
  | "SellAllocationDecision"
  | "PositionVerificationCapture"
  | "OrderEvidenceCapture"
  | "DividendPayment"
  | "CashAdjustment"
  | "Deposit"
  | "Withdrawal"
  | "CashReset"
  | "CorporateAction"
  | "Note"
  | "PortfolioAssignment"
  | "Correction"
  | "Retraction"
  /**
   * A fully-cancelled order (zero shares ever executed) imported from an
   * STES `Transaction Type: CANCELLED` observation — audit trail only. Never
   * a subject of `commitEngine.ts`'s Buy/Sell fold (see
   * `relevantTradeTransactions`'s `NON_SUBJECT_KINDS`-style exclusion),
   * never read by `TradeService`/`computePositions` — structurally
   * incapable of creating a Ledger Entry or affecting Holdings.
   */
  | "CancelledOrder";

export type RawTransactionSource =
  | "statement"
  | "invoice"
  | "orders-screen"
  | "orders-timeline"
  | "position-verification"
  | "csv"
  /** STES workbook observations whose Documents-sheet type has no dedicated source of its own: a broker push notification. */
  | "notification"
  /** STES: a broker email (other than the Email Invoice PDF, which stays "invoice"). */
  | "email"
  /** STES: a screenshot of an unspecified broker screen — unlike "orders-screen"/"position-verification", which screen it shows is unknown. */
  | "screenshot"
  /** STES: a document the extracting AI could only classify as PDF/OTHER — real evidence, but of an unidentifiable document type. */
  | "other-document"
  | "manual"
  /** A one-time conversion of a Trade/TradeAllocation/PositionVerification that was already committed under the pre-migration architecture — already vetted and reconciled once, under the rules that applied at the time. Never the same as "manual" (a real user-typed trade with no prior history) or an OCR document type (no such document exists for this row). */
  | "backfill";

/** Always "unverified" at write time — a transaction's real, current status is derived by folding its supersede/retract chain (see the Verification Engine), never read from or written back onto this field. */
export type RawTransactionStatus = "unverified";

export interface BuyExecutionPayload {
  ticker: string;
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime?: string;
  companyName?: string;
  transactionNumber?: string;
  /** User-authored annotations (manual Record Buy) — carried on the fact so a full rebuild never loses them. OCR imports never set these. */
  notes?: string;
  strategyTags?: string[];
  /** Only set when the user overrode the known-ticker sector map at entry time — a derivable sector is never stored (see TradeService.recordBuy). */
  sector?: string;
}

export interface SellExecutionPayload {
  ticker: string;
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime?: string;
  transactionNumber?: string;
  /** User-authored annotations (manual Sell allocation) — same rationale as BuyExecutionPayload's. */
  notes?: string;
  exitReason?: string;
}

export interface SellAllocationDecisionPayload {
  /** The RawTransaction id of the SellExecution (post-canonicalization: a LedgerEvent id) this decision allocates. */
  sellExecutionId: string;
  allocations: { lotRef: string; shares: number }[];
}

export interface PositionVerificationCapturePayload {
  ticker: string;
  units: number;
  avgCost?: number;
  capturedAt: string;
  companyName?: string;
}

export interface OrderEvidenceCapturePayload {
  ticker: string;
  side: "BUY" | "SELL";
  orderType?: "limit" | "market";
  shares?: number;
  price?: number;
  totalValue: number;
  status: "fulfilled" | "cancelled";
  date?: string;
  time?: string;
  companyName?: string;
}

export interface DividendPaymentPayload {
  ticker?: string;
  amount: number;
  date: string;
}

export interface CashAdjustmentPayload {
  amount: number;
  notes: string;
  date: string;
}

export interface DepositWithdrawalPayload {
  amount: number;
  date: string;
}

/** An explicit cash checkpoint — replay sums every cash-affecting transaction after the latest non-retracted CashReset, starting from its asserted amount. */
export interface CashResetPayload {
  amount: number;
  asOfDate: string;
}

export interface CorporateActionPayload {
  ticker: string;
  actionType: "Split" | "RightsIssue";
  notes: string;
  date: string;
}

export interface NotePayload {
  text: string;
  ticker?: string;
}

export interface PortfolioAssignmentPayload {
  targetId: string;
  portfolioId: string;
}

/** Field-level correction of an earlier transaction's payload — never a mutation of that row, only ever a new row that later folds win over it. */
export interface CorrectionPayload {
  targetId: string;
  patch: Partial<{
    executionDate: string;
    executionTime: string;
    ticker: string;
    portfolioId: string;
    companyName: string;
    transactionNumber: string;
    price: number;
    fees: number;
    taxes: number;
  }>;
}

export interface RetractionPayload {
  targetId: string;
  reason?: string;
}

/** See `RawTransactionKind`'s `"CancelledOrder"` doc comment — a fully-cancelled order, audit trail only. */
export interface CancelledOrderPayload {
  ticker: string;
  side?: "BUY" | "SELL";
  originalShares?: number;
  originalPrice?: number;
  date: string;
  time?: string;
  brokerStatus: string;
  companyName?: string;
}

export type RawTransactionPayload =
  | BuyExecutionPayload
  | SellExecutionPayload
  | SellAllocationDecisionPayload
  | PositionVerificationCapturePayload
  | OrderEvidenceCapturePayload
  | DividendPaymentPayload
  | CashAdjustmentPayload
  | DepositWithdrawalPayload
  | CashResetPayload
  | CorporateActionPayload
  | NotePayload
  | PortfolioAssignmentPayload
  | CorrectionPayload
  | RetractionPayload
  | CancelledOrderPayload;

import { generateId } from "../value-objects/id";

/**
 * How this fact's text was obtained from the source document — an
 * independent reliability signal from `confidence` (which reflects
 * ticker-resolution certainty within already-extracted text, not how
 * trustworthy the extraction channel itself is). A native PDF/CSV text
 * layer is machine-generated and essentially lossless; a vision-model or
 * Tesseract OCR read of a photographed screen has a real, separate
 * misread risk (glare, crop, a digit misrecognized) that ticker-match
 * confidence alone never captures. `undefined` only for facts written
 * before this field existed. See docs/EVIDENCE_ARCHITECTURE.md.
 */
export type ExtractionMethod = "native-pdf-text" | "ocr-tesseract" | "csv-text" | "manual-entry" | "stes-workbook";

export interface RawTransaction {
  id: string;
  /** Assigned by the repository at append time — never supplied by the caller. */
  seq: number;
  /** Null/undefined until an explicit PortfolioAssignment resolves it — Import never assigns this itself. */
  portfolioId?: string;
  kind: RawTransactionKind;
  source: RawTransactionSource;
  /** The Upload this fact was extracted from, when source is not "manual". */
  sourceUploadId?: string;
  /** Indexed top-level field for query performance, mirroring every other ticker-bearing table in this app — not every kind carries one (e.g. CashAdjustment). */
  ticker?: string;
  confidence?: "high" | "medium" | "low";
  /** See ExtractionMethod's own doc comment — independent of `confidence`. */
  extractionMethod?: ExtractionMethod;
  /**
   * Which released version of the BrokerParser that produced `source`
   * extracted this fact (e.g. ThndrParser's own exported `PARSER_VERSION`).
   * Lets a future re-parse of the permanently-stored original document
   * (Upload.fileBlob) identify exactly which live facts predate a parser
   * fix, without re-deriving that from `recordedAt` timestamps and a
   * changelog. Undefined for "manual"/"backfill" sources — no parser ever
   * ran to version.
   */
  parserVersion?: string;
  status: RawTransactionStatus;
  payload: RawTransactionPayload;
  /** The id of an earlier RawTransaction this one corrects or retracts (Correction/Retraction kinds only). */
  supersedes?: string;
  /** Ingestion wall-clock — audit only, never used to order replay. */
  recordedAt: string;
}

/** Builds a fully-formed RawTransaction minus `seq`, which only the repository can assign atomically at append time. */
export function createRawTransaction(input: {
  id?: string;
  portfolioId?: string;
  kind: RawTransactionKind;
  source: RawTransactionSource;
  sourceUploadId?: string;
  ticker?: string;
  confidence?: "high" | "medium" | "low";
  extractionMethod?: ExtractionMethod;
  parserVersion?: string;
  payload: RawTransactionPayload;
  supersedes?: string;
}): Omit<RawTransaction, "seq"> {
  return {
    id: input.id ?? generateId(),
    portfolioId: input.portfolioId,
    kind: input.kind,
    source: input.source,
    sourceUploadId: input.sourceUploadId,
    ticker: input.ticker,
    confidence: input.confidence,
    extractionMethod: input.extractionMethod,
    parserVersion: input.parserVersion,
    status: "unverified",
    payload: input.payload,
    supersedes: input.supersedes,
    recordedAt: new Date().toISOString(),
  };
}

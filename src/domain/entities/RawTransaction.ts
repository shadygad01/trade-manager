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
  | "Retraction";

export type RawTransactionSource =
  | "statement"
  | "invoice"
  | "orders-screen"
  | "orders-timeline"
  | "position-verification"
  | "csv"
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
  | RetractionPayload;

import { generateId } from "../value-objects/id";

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
    status: "unverified",
    payload: input.payload,
    supersedes: input.supersedes,
    recordedAt: new Date().toISOString(),
  };
}

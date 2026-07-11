import { generateId } from "../value-objects/id";

/**
 * A partial-fill execution (broker status "Partially filled" / "Partially
 * filled, canceled" / "Partial fill") imported from STES, held OUTSIDE the
 * Trade/TradeAllocation ledger until the broker invoice confirms its real
 * executed numbers. This is the deliberate fix for a real bug: an earlier
 * implementation created the Trade/TradeAllocation immediately and only
 * flagged it "pending", which meant it was already affecting Holdings/cost
 * basis/cash and was already allocatable BEFORE any invoice existed. A
 * PendingExecution is not a ledger row and is never read by
 * computePositions/computeCanonicalPositions/SellAllocationForm — so
 * "blocked from the ledger" is true by construction, not by a filter that
 * could be forgotten somewhere.
 *
 * Never duplicated: uploading a matching invoice updates this SAME row in
 * place (see confirmPendingExecution) — a second upload against an
 * already-verified row is rejected, not merged into a new one.
 */
export type VerificationStatus = "needs-confirmation" | "verified";

/**
 * "pending-verification" until the resulting Ledger Entry actually exists.
 * For a BUY that happens the instant the invoice is confirmed (recordBuy
 * runs immediately). For a SELL it happens only once the user completes the
 * explicit lot-allocation step (ADR-002 — this app never auto-picks which
 * lot a sell closes, confirmed or not), so a verified-but-not-yet-allocated
 * SELL still reads "pending-verification" here even though
 * verificationStatus is already "verified".
 */
export type PendingExecutionStatus = "pending-verification" | "executed";

export interface PendingExecution {
  id: string;
  portfolioId: string;
  ticker: string;
  companyName?: string;
  side: "BUY" | "SELL";
  /** As originally read from the broker document — never assumed to be the final executed amount. */
  originalShares: number;
  originalPrice: number;
  originalFees?: number;
  originalTaxes?: number;
  executionDate: string;
  executionTime?: string;
  /** The broker's own status text, preserved verbatim (e.g. "Partially filled, canceled") — never normalized away. */
  brokerStatus: string;
  sourceUploadId?: string;
  transactionNumber?: string;
  verificationStatus: VerificationStatus;
  executionStatus: PendingExecutionStatus;
  /** Populated only once confirmPendingExecution succeeds. */
  invoiceNumber?: string;
  brokerReference?: string;
  confirmedShares?: number;
  confirmedPrice?: number;
  confirmedFees?: number;
  confirmedTaxes?: number;
  confirmedAt?: string;
  /** Set once the resulting Trade exists (BUY only). */
  resultingTradeId?: string;
  /** Set once the resulting sell allocation exists (SELL only, after the explicit lot-allocation step). */
  resultingSellGroupId?: string;
  createdAt: string;
}

export function createPendingExecution(input: {
  id?: string;
  portfolioId: string;
  ticker: string;
  companyName?: string;
  side: "BUY" | "SELL";
  originalShares: number;
  originalPrice: number;
  originalFees?: number;
  originalTaxes?: number;
  executionDate: string;
  executionTime?: string;
  brokerStatus: string;
  sourceUploadId?: string;
  transactionNumber?: string;
}): PendingExecution {
  return {
    id: input.id ?? generateId(),
    portfolioId: input.portfolioId,
    ticker: input.ticker,
    companyName: input.companyName,
    side: input.side,
    originalShares: input.originalShares,
    originalPrice: input.originalPrice,
    originalFees: input.originalFees,
    originalTaxes: input.originalTaxes,
    executionDate: input.executionDate,
    executionTime: input.executionTime,
    brokerStatus: input.brokerStatus,
    sourceUploadId: input.sourceUploadId,
    transactionNumber: input.transactionNumber,
    verificationStatus: "needs-confirmation",
    executionStatus: "pending-verification",
    createdAt: new Date().toISOString(),
  };
}

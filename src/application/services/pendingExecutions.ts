import { createPendingExecution, type PendingExecution } from "@domain/entities/PendingExecution";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { AppRepositories } from "./types";
import { recordBuy, type RecordBuyResult } from "./TradeService";
import type { RecordSellResult } from "./TradeService";

/**
 * Pending Executions: the fix for the "partially filled" bug (see the audit
 * that produced this module — an earlier design created the Trade/
 * TradeAllocation immediately and only flagged it "pending", which meant it
 * was already affecting Holdings/cost basis/cash and was already allocatable
 * BEFORE any invoice existed). A PendingExecution is never a Trade/
 * TradeAllocation and is never read by computePositions/
 * computeCanonicalPositions/SellAllocationForm's openTrades query — so
 * "blocked from the ledger until verified" is true because the row simply
 * doesn't exist yet, not because of a status filter that could be skipped
 * somewhere.
 */

export interface CreatePendingExecutionInput {
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
}

export async function createPendingExecutionRecord(
  repos: AppRepositories,
  input: CreatePendingExecutionInput
): Promise<PendingExecution> {
  const pendingExecution = createPendingExecution({
    portfolioId: input.portfolioId,
    ticker: normalizeTicker(input.ticker),
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
  });
  await repos.pendingExecutions.save(pendingExecution);
  return pendingExecution;
}

export interface ConfirmPendingExecutionInput {
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  invoiceNumber?: string;
  brokerReference?: string;
  transactionNumber?: string;
}

export interface ConfirmPendingExecutionResult {
  pendingExecution: PendingExecution;
  /** Set only for a BUY — the Ledger Entry is created immediately on confirmation. A SELL still requires the explicit lot-allocation step (ADR-002); see completeSellAllocationForPendingExecution. */
  trade?: RecordBuyResult["trade"];
}

/**
 * Updates the SAME PendingExecution row with the invoice's authoritative
 * numbers — never creates a second row for the same execution. Guarded to
 * only ever fire once: a PendingExecution already `verificationStatus:
 * "verified"` refuses a second confirmation outright, so a re-uploaded or
 * duplicate invoice can never silently overwrite an already-verified
 * transaction.
 *
 * For a BUY, this is the one moment a Ledger Entry (Trade) is created at
 * all — before this call, nothing exists in `trades` for this execution, so
 * Holdings/cost-basis/cash are structurally untouched. For a SELL, no
 * TradeAllocation is created here: this app never auto-picks which lot a
 * sell closes (ADR-002), confirmed or not, so verifying the invoice only
 * unblocks the explicit allocation step — see
 * completeSellAllocationForPendingExecution for where the Ledger Entry
 * actually gets created on that side.
 */
export async function confirmPendingExecution(
  repos: AppRepositories,
  pendingExecutionId: string,
  confirmed: ConfirmPendingExecutionInput
): Promise<ConfirmPendingExecutionResult> {
  const pendingExecution = await repos.pendingExecutions.getById(pendingExecutionId);
  if (!pendingExecution) {
    throw new Error(`Pending execution not found: ${pendingExecutionId}`);
  }
  if (pendingExecution.verificationStatus !== "needs-confirmation") {
    throw new Error(`Pending execution ${pendingExecutionId} is already ${pendingExecution.verificationStatus} — it can't be confirmed again.`);
  }

  const verified: PendingExecution = {
    ...pendingExecution,
    verificationStatus: "verified",
    invoiceNumber: confirmed.invoiceNumber,
    brokerReference: confirmed.brokerReference,
    confirmedShares: confirmed.shares,
    confirmedPrice: confirmed.price,
    confirmedFees: confirmed.fees,
    confirmedTaxes: confirmed.taxes,
    confirmedAt: new Date().toISOString(),
    transactionNumber: confirmed.transactionNumber ?? pendingExecution.transactionNumber,
  };

  if (pendingExecution.side === "BUY") {
    const { trade } = await recordBuy(repos, {
      portfolioId: pendingExecution.portfolioId,
      ticker: pendingExecution.ticker,
      companyName: pendingExecution.companyName,
      shares: confirmed.shares,
      entryPrice: confirmed.price,
      fees: confirmed.fees,
      taxes: confirmed.taxes,
      executionDate: pendingExecution.executionDate,
      executionTime: pendingExecution.executionTime ?? "00:00",
      transactionNumber: verified.transactionNumber,
    });
    const executed: PendingExecution = { ...verified, executionStatus: "executed", resultingTradeId: trade.id };
    await repos.pendingExecutions.save(executed);
    return { pendingExecution: executed, trade };
  }

  // SELL: verified, but still "pending-verification" until the explicit lot
  // allocation completes (see this function's own doc comment).
  await repos.pendingExecutions.save(verified);
  return { pendingExecution: verified };
}

/**
 * Called once `recordSell` has actually created the TradeAllocation(s) for a
 * verified SELL pending execution (see SellAllocationForm's confirmed-mode
 * submit) — this is the moment the Ledger Entry genuinely exists and
 * Holdings actually change, so it's the moment executionStatus flips to
 * "executed", not invoice-confirmation time.
 */
export async function completeSellAllocationForPendingExecution(
  repos: AppRepositories,
  pendingExecutionId: string,
  sellResult: RecordSellResult
): Promise<PendingExecution> {
  const pendingExecution = await repos.pendingExecutions.getById(pendingExecutionId);
  if (!pendingExecution) {
    throw new Error(`Pending execution not found: ${pendingExecutionId}`);
  }
  const executed: PendingExecution = {
    ...pendingExecution,
    executionStatus: "executed",
    resultingSellGroupId: sellResult.allocations[0]?.sellGroupId,
  };
  await repos.pendingExecutions.save(executed);
  return executed;
}

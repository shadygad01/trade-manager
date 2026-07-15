import { verifyAll, type TransactionVerification } from "./verificationEngine";
import { generateLedgerEvents } from "./ledgerEngine";
import { generateAllocations } from "./allocationEngine";
import type { RawTransaction } from "@domain/entities/RawTransaction";
import type { LedgerEvent } from "@domain/entities/LedgerEvent";
import type { Allocation } from "@domain/entities/Allocation";

interface ProjectionRequest {
  id: number;
  transactions: RawTransaction[];
}

interface ProjectionResponse {
  id: number;
  ok: true;
  verdicts: [string, TransactionVerification][];
  events: LedgerEvent[];
  allocations: Allocation[];
}

interface ProjectionErrorResponse {
  id: number;
  ok: false;
  error: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProjectionRequest>) => void) | null;
  postMessage(message: ProjectionResponse | ProjectionErrorResponse): void;
};

scope.onmessage = (event) => {
  const { id, transactions } = event.data;
  try {
    const verdicts = verifyAll({ transactions, positions: [] });
    const verifiedTransactions = transactions.filter(
      (transaction) =>
        (transaction.kind === "BuyExecution" || transaction.kind === "SellExecution") && verdicts.get(transaction.id)?.verdict === "Verified",
    );
    const events = generateLedgerEvents(verifiedTransactions);
    const decisionTransactions = transactions.filter((transaction) => transaction.kind === "SellAllocationDecision");
    const allocations = generateAllocations(events, decisionTransactions);
    scope.postMessage({ id, ok: true, verdicts: [...verdicts.entries()], events, allocations });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : "Commit projection worker failed" });
  }
};

export {};

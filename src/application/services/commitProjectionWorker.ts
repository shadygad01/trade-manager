import type { RawTransaction } from "@domain/entities/RawTransaction";
import type { LedgerEvent } from "@domain/entities/LedgerEvent";
import type { Allocation } from "@domain/entities/Allocation";
import { verifyAll, type TransactionVerification } from "./verificationEngine";
import { generateLedgerEvents } from "./ledgerEngine";
import { generateAllocations } from "./allocationEngine";

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

type PendingRequest = {
  resolve: (value: ProjectionResponse) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function localProjection(transactions: RawTransaction[]): ProjectionResponse {
  const verdicts = verifyAll({ transactions, positions: [] });
  const verifiedTransactions = transactions.filter(
    (transaction) =>
      (transaction.kind === "BuyExecution" || transaction.kind === "SellExecution") && verdicts.get(transaction.id)?.verdict === "Verified",
  );
  const events = generateLedgerEvents(verifiedTransactions);
  const allocations = generateAllocations(events, transactions.filter((transaction) => transaction.kind === "SellAllocationDecision"));
  return { id: 0, ok: true, verdicts: [...verdicts.entries()], events, allocations };
}

function getWorker(): Worker | undefined {
  if (typeof Worker === "undefined") return undefined;
  if (worker) return worker;
  worker = new Worker(new URL("./commitProjection.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<ProjectionResponse | ProjectionErrorResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message);
    else request.reject(new Error(message.error));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Commit projection worker failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

/** Runs pure verification/replay/allocation work away from the React main thread when workers are available. */
export function projectInWorker(transactions: RawTransaction[]): Promise<ProjectionResponse> {
  const activeWorker = getWorker();
  if (!activeWorker) return Promise.resolve(localProjection(transactions));
  const id = nextRequestId++;
  return new Promise<ProjectionResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ id, transactions });
  });
}

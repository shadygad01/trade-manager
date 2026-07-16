import { computeAnalytics, type AnalyticsInput, type AnalyticsResult } from "./AnalyticsEngine";

type WorkerResponse =
  | { id: number; ok: true; results: AnalyticsResult[] }
  | { id: number; ok: false; error: string };

type PendingRequest = {
  resolve: (results: AnalyticsResult[]) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | undefined {
  if (typeof Worker === "undefined") return undefined;
  if (worker) return worker;

  worker = new Worker(new URL("./analytics.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.results);
    else request.reject(new Error(message.error));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Analytics worker failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

/** Calculates a whole dashboard batch off the UI thread with an identical synchronous fallback for tests/SSR. */
export function computeAnalyticsBatch(inputs: AnalyticsInput[]): Promise<AnalyticsResult[]> {
  const activeWorker = getWorker();
  if (!activeWorker) return Promise.resolve(inputs.map(computeAnalytics));

  const id = nextRequestId++;
  return new Promise<AnalyticsResult[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ id, inputs });
  }).catch(() => inputs.map(computeAnalytics));
}

import { computeAnalytics, type AnalyticsInput, type AnalyticsResult } from "./AnalyticsEngine";

interface AnalyticsBatchRequest {
  id: number;
  inputs: AnalyticsInput[];
}

interface AnalyticsBatchResponse {
  id: number;
  ok: true;
  results: AnalyticsResult[];
}

interface AnalyticsBatchError {
  id: number;
  ok: false;
  error: string;
}

self.onmessage = (event: MessageEvent<AnalyticsBatchRequest>) => {
  const { id, inputs } = event.data;
  try {
    const response: AnalyticsBatchResponse = { id, ok: true, results: inputs.map(computeAnalytics) };
    self.postMessage(response);
  } catch (error) {
    const response: AnalyticsBatchError = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Analytics calculation failed",
    };
    self.postMessage(response);
  }
};

export {};

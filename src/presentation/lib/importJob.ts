export type ImportJobStatus = "running" | "completed" | "failed";

export interface ImportJobState {
  id: string;
  status: ImportJobStatus;
  tickerKeys: string[];
  completedTickers: string[];
  currentTicker?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

const STORAGE_KEY = "portfolio-os:import-job";
const listeners = new Set<() => void>();

function load(): ImportJobState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ImportJobState) : undefined;
  } catch {
    return undefined;
  }
}

let state: ImportJobState | undefined = load();

function persist() {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Job state is a resume hint; the durable transaction remains authoritative.
  }
  for (const listener of listeners) listener();
}

function now(): string {
  return new Date().toISOString();
}

export const importJob = {
  getState(): ImportJobState | undefined {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  start(tickerKeys: string[]): ImportJobState {
    const timestamp = now();
    state = {
      id: `${timestamp}-${Math.random().toString(36).slice(2)}`,
      status: "running",
      tickerKeys: [...tickerKeys],
      completedTickers: [],
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    persist();
    return state;
  },
  markTickerStarted(ticker: string): void {
    if (!state || state.status !== "running") return;
    state = { ...state, currentTicker: ticker, updatedAt: now() };
    persist();
  },
  markTickerComplete(ticker: string): void {
    if (!state || state.status !== "running") return;
    state = {
      ...state,
      currentTicker: undefined,
      completedTickers: [...new Set([...state.completedTickers, ticker])],
      updatedAt: now(),
    };
    persist();
  },
  complete(): void {
    if (!state) return;
    state = { ...state, status: "completed", currentTicker: undefined, updatedAt: now() };
    persist();
  },
  fail(error: string): void {
    if (!state) return;
    state = { ...state, status: "failed", currentTicker: undefined, error, updatedAt: now() };
    persist();
  },
  clear(): void {
    state = undefined;
    persist();
  },
};

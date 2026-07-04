import { useSyncExternalStore } from "react";
import type { ParsedDividendCandidate, ParsedTradeCandidate } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";

export interface CandidateEntry {
  key: string;
  candidate: ParsedTradeCandidate;
}
export interface VerificationEntry {
  key: string;
  verification: Omit<PositionVerification, "id" | "portfolioId">;
}
export interface DividendEntry {
  key: string;
  dividend: ParsedDividendCandidate;
}

export interface ImportSessionState {
  pendingCandidates: CandidateEntry[];
  pendingVerifications: VerificationEntry[];
  pendingDividends: DividendEntry[];
  addedKeys: string[];
  acceptedKeys: string[];
  tickerPortfolio: Record<string, string>;
  uploadSeq: number;
  filesProcessed: number;
}

const STORAGE_KEY = "portfolio-os:import-session";

function emptyState(): ImportSessionState {
  return {
    pendingCandidates: [],
    pendingVerifications: [],
    pendingDividends: [],
    addedKeys: [],
    acceptedKeys: [],
    tickerPortfolio: {},
    uploadSeq: 0,
    filesProcessed: 0,
  };
}

/**
 * The extraction pool (Step 1) has to survive navigating away from the
 * Import page — e.g. to create a portfolio before distributing — and back,
 * which unmounts/remounts the page component. Plain useState is lost on
 * remount, so this lives in a module-level store instead (persisted to
 * localStorage so it also survives a full page reload/tab close, not just
 * in-app navigation).
 */
function load(): ImportSessionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...emptyState(), ...JSON.parse(raw) };
  } catch {
    // Corrupted or unavailable storage — start fresh rather than crash the page.
  }
  return emptyState();
}

let state: ImportSessionState = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable (e.g. private browsing) — session still works for this page instance.
  }
}

function setState(next: ImportSessionState) {
  state = next;
  persist();
  for (const listener of listeners) listener();
}

export const importSession = {
  getState(): ImportSessionState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  update(updater: (prev: ImportSessionState) => ImportSessionState): void {
    setState(updater(state));
  },
  clear(): void {
    setState(emptyState());
  },
};

export function useImportSession(): ImportSessionState {
  return useSyncExternalStore(importSession.subscribe, importSession.getState, importSession.getState);
}

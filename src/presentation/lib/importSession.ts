import { useSyncExternalStore } from "react";
import type { ParsedDividendCandidate, ParsedOrderEvidence, ParsedTradeCandidate } from "@domain/entities/Upload";
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
export interface OrderEvidenceEntry {
  key: string;
  evidence: ParsedOrderEvidence;
}

export interface ImportSessionState {
  pendingCandidates: CandidateEntry[];
  pendingVerifications: VerificationEntry[];
  pendingDividends: DividendEntry[];
  /** Undated order rows read from account-wide "Orders" timeline screenshots — corroborating evidence only, never committed anywhere (see ParsedOrderEvidence). */
  pendingOrderEvidences: OrderEvidenceEntry[];
  /**
   * Candidates the user discarded from the pending pool (duplicate cleanup,
   * manual remove). Kept — not deleted — because a discarded duplicate is
   * still a real READ of its document: removing the redundant copy of a
   * statement+orders-screenshot pair must not un-verify the surviving row's
   * dual-source confirmation (see ImportPage's crossVerifiedKeys). Never
   * rendered, never committed — corroboration evidence only.
   */
  discardedCandidates: CandidateEntry[];
  addedKeys: string[];
  acceptedKeys: string[];
  /** Buy candidates auto-skipped as an exact duplicate (same ticker/date/shares/price as an already-recorded trade) — never became a real trade. */
  skippedKeys: string[];
  /** Auto-added rows the user explicitly deleted afterward (see PortfolioOS's Import auto-commit) — kept distinct from "never added" so auto-commit never silently re-adds a row the user removed on purpose. */
  dismissedKeys: string[];
  /** Entry key -> the real Trade.id it became, so an auto-added row can still be deleted directly from Import. */
  addedTradeIds: Record<string, string>;
  /** Sell entry key -> the TradeAllocation ids its "Allocate Sell" created — the Sell-side twin of addedTradeIds, excluding a committed sell's own allocations from its duplicate check (see ImportPage's duplicateMatch). */
  addedAllocationIds: Record<string, string[]>;
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
    pendingOrderEvidences: [],
    discardedCandidates: [],
    addedKeys: [],
    acceptedKeys: [],
    skippedKeys: [],
    dismissedKeys: [],
    addedTradeIds: {},
    addedAllocationIds: {},
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

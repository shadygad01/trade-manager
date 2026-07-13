import type { WorkflowStep } from "./DiagnosticEvent";

/**
 * The derived, replaceable index over DiagnosticEvent (see DiagnosticEvent.ts's
 * own doc comment). A DiagnosticCase is never edited field-by-field — it is
 * produced by a pure reducer over the event log (detectDiagnosticCases, Part
 * 6) and replaced wholesale for its groupKey, the same "full delete-and-
 * regenerate, never partial mutation" discipline commitEngine.commitTicker
 * already uses for ledgerCache/allocationsCache.
 *
 * There is deliberately no mutable "status"/acknowledgment field — the first
 * draft had one and it was removed during the Part 2.3 source-of-truth
 * certification precisely because mutating it in place would have broken
 * the "never edited" invariant this whole model depends on. See
 * docs/DIAGNOSTICS_CENTER_SPEC.md Part 2.2/2.3 for the full reasoning.
 */

export type DiagnosticSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type DiagnosticTriggerType =
  | "Mismatch"
  | "NeedsBrokerScreenshot"
  | "NeedsCorroboratingEvidence"
  | "VerificationConflict"
  | "ReplayConflict"
  | "AllocationConflict"
  | "HoldingsConflict"
  | "ConstraintFailure"
  | "DuplicateDetection"
  | "UnexpectedWarning"
  | "Exception"
  | "AssertionFailure"
  | "Unknown";

export interface DiagnosticCaseContext {
  browser: string;
  browserVersion: string;
  appVersion: string;
  schemaVersion: number;
  featureFlags: string[];
  importSessionId?: string;
  commitId?: string;
}

export interface DiagnosticCase {
  /** Unique Error ID. */
  id: string;
  /** content hash of (triggerType, ticker, portfolioId, reasonCode) — deterministically derived, recomputable from the other fields (Part 2.3 §B). */
  groupKey: string;
  severity: DiagnosticSeverity;
  triggerType: DiagnosticTriggerType;
  /** Pointer into the DiagnosticEvent log — not a copy of the event's contents. */
  firstOccurrenceEventSeq: number;
  latestOccurrenceEventSeq: number;
  occurrenceCount: number;
  ticker?: string;
  portfolioId?: string;
  workflowStep?: WorkflowStep;
  context: DiagnosticCaseContext;
}

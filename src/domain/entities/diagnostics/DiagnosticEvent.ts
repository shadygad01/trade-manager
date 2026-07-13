/**
 * The Diagnostics Center's append-only log — the observation-layer analog of
 * RawTransaction (see RawTransaction.ts's own doc comment). Every row is
 * written once and never edited or deleted except by Part 9's retention
 * pruning; DiagnosticCase (DiagnosticCase.ts) is the derived, replaceable
 * index folded from this log, never the other way around.
 *
 * See docs/DIAGNOSTICS_CENTER_SPEC.md Part 2 and Part 2.3 (the source-of-
 * truth field certification) for why every field here is shaped the way it
 * is — in particular why WriteTraceRecord/ReadTraceRecord/DecisionTraceRecord/
 * RuleExecutionRecord prefer a `factSeqCursor` pointer into `rawTransactions`
 * over storing a copy of business-shaped data: most of what a first draft
 * would capture as a value is already canonical (rawTransactions) or
 * deterministically re-derivable from it (everything replay-based), so
 * storing a copy would just be an avoidable second source of truth.
 */

export type WorkflowStep =
  | "AppStart"
  | "Reset"
  | "Import"
  | "Confirm"
  | "Allocate"
  | "Commit"
  | "Refresh"
  | "Restart"
  | "Rebuild"
  | "Delete"
  | "ManualEdit"
  | "ReImport"
  | "Verification"
  | "Error";

export interface DiagnosticEventBase {
  id: string;
  /** Assigned by the diagnostics repository at append time — never supplied by the caller. Same discipline as RawTransaction.seq. */
  seq: number;
  recordedAt: string;
  /** One per app load (Part 4.2) — held in memory, never persisted anywhere else. */
  sessionId: string;
  /** A correlation pointer into the live `portfolios`/ticker domain data — never a copy of its fields (Part 2.3 certification). */
  portfolioId?: string;
  ticker?: string;
  workflowStep?: WorkflowStep;
}

export interface SessionEventRecord extends DiagnosticEventBase {
  kind: "SessionEvent";
  label: string;
  metadata?: Record<string, unknown>;
}

/**
 * How a WriteTraceRecord's before/after value is known — see the module doc
 * comment and docs/DIAGNOSTICS_CENTER_SPEC.md Part 2.3 §A for the full
 * reasoning behind each mode:
 *
 * - "reference": the write is to `rawTransactions`, which is already
 *   permanent and immutable. No value is stored — re-fetch by `objectId`.
 * - "replayCursor": the write is to a table that is itself a materialized
 *   projection of `rawTransactions` (trades/tradeAllocations/ledgerCache/
 *   allocationsCache) via a writer whose output is fully determined by fact
 *   replay. No value is stored — replay `rawTransactions` up to
 *   `factSeqCursor` through the existing engines on demand.
 * - "snapshot": the write does NOT derive from fact replay (only
 *   BackupService's bulk restore and ledgerRebuild's applyLedgerRebuild
 *   qualify — frozen by a regression guard, Part 5.4/2.3 §D). The prior/new
 *   value is genuinely unrecoverable once overwritten, so it is captured
 *   directly, normalized, and persisted as an immutable historical record —
 *   never treated as the current value of anything.
 */
export type WriteTraceValueSource = "reference" | "replayCursor" | "snapshot";

export interface WriteTraceRecord extends DiagnosticEventBase {
  kind: "WriteTrace";
  writer: string;
  function: string;
  file: string;
  table: string;
  objectId: string;
  valueSource: WriteTraceValueSource;
  /** Present only when valueSource === "replayCursor": the highest rawTransactions.seq observed at capture time. */
  factSeqCursor?: number;
  /** Present only when valueSource === "snapshot". */
  oldValue?: unknown;
  /** Present only when valueSource === "snapshot". */
  newValue?: unknown;
  reason: string;
}

export interface ReadTraceRecord extends DiagnosticEventBase {
  kind: "ReadTrace";
  reader: string;
  function: string;
  file: string;
  /** The highest rawTransactions.seq observed at capture time — the pointer that makes this read's input/output replayable on demand instead of stored as a copy (Part 2.3 §A). */
  factSeqCursor: number;
  /** A short label copied from the read function's own deterministic output — a rendering convenience, never a second source of truth (it's always re-derivable from factSeqCursor). */
  decision?: string;
}

export type DecisionType = "Replay" | "Verification" | "Allocation" | "Warning" | "Constraint" | "Policy";

export interface DecisionTraceRecord extends DiagnosticEventBase {
  kind: "DecisionTrace";
  decisionType: DecisionType;
  factSeqCursor: number;
  reasonCode: string;
  reasonText: string;
}

export interface RuleExecutionRecord extends DiagnosticEventBase {
  kind: "RuleExecution";
  ruleName: string;
  passed: boolean;
  factSeqCursor: number;
  reason: string;
  /** A performance.now() delta measured around this specific execution — irreproducible by nature, not merely inconvenient to reproduce (Part 2.3 §B). Re-running the rule later measures a NEW duration, never this one. */
  durationMs: number;
}

export type PerfOperation = "Import" | "Replay" | "Verification" | "Allocation" | "Commit" | "Render";

export interface PerfSampleRecord extends DiagnosticEventBase {
  kind: "PerfSample";
  operation: PerfOperation;
  /** Same irreproducibility note as RuleExecutionRecord.durationMs. */
  durationMs: number;
  meta?: Record<string, unknown>;
}

export type DiagnosticEvent =
  | SessionEventRecord
  | WriteTraceRecord
  | ReadTraceRecord
  | DecisionTraceRecord
  | RuleExecutionRecord
  | PerfSampleRecord;

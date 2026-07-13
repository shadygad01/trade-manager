import type { DiagnosticsRecorder, RecorderInput } from "@domain/repositories";
import type {
  SessionEventRecord,
  WriteTraceRecord,
  ReadTraceRecord,
  DecisionTraceRecord,
  RuleExecutionRecord,
  PerfSampleRecord,
} from "@domain/entities/diagnostics/DiagnosticEvent";

/**
 * The default DiagnosticsRecorder — wired in whenever Developer Mode is off
 * (docs/DIAGNOSTICS_CENTER_SPEC.md Part 3.3/4.1, the overwhelming majority
 * of real users). Every method is an empty body: zero IndexedDB writes,
 * zero allocation beyond the call itself, no `diagnosticEvents`/
 * `diagnosticCases` table is ever opened. This is what makes Part 8's
 * "zero cost when off" claim true rather than aspirational.
 */
export class NoopDiagnosticsRecorder implements DiagnosticsRecorder {
  recordSessionEvent(_event: RecorderInput<SessionEventRecord>): void {}
  recordWrite(_event: RecorderInput<WriteTraceRecord>): void {}
  recordRead(_event: RecorderInput<ReadTraceRecord>): void {}
  recordDecision(_event: RecorderInput<DecisionTraceRecord>): void {}
  recordRuleExecution(_event: RecorderInput<RuleExecutionRecord>): void {}
  recordPerfSample(_event: RecorderInput<PerfSampleRecord>): void {}
}

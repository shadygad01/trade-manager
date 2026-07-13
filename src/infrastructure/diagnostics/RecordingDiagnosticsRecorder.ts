import { generateId } from "@domain/value-objects/id";
import type { DiagnosticsRecorder, DiagnosticEventRepository, RecorderInput } from "@domain/repositories";
import type {
  SessionEventRecord,
  WriteTraceRecord,
  ReadTraceRecord,
  DecisionTraceRecord,
  RuleExecutionRecord,
  PerfSampleRecord,
} from "@domain/entities/diagnostics/DiagnosticEvent";

/**
 * The Developer-Mode-on DiagnosticsRecorder (docs/DIAGNOSTICS_CENTER_SPEC.md
 * Part 3.3/4.1). Every `record*` call is fire-and-forget — never `await`ed
 * by the caller, and a failed diagnostics write is caught and logged, never
 * thrown into the caller — the same non-fatal try/catch discipline every
 * other shadow-write path in this codebase already uses (see
 * `backfillRawTransactionsSilently`'s startup hook in
 * `src/presentation/lib/data.ts`). A slow or failing diagnostics write must
 * never slow down or break a real business write or read.
 */
export class RecordingDiagnosticsRecorder implements DiagnosticsRecorder {
  constructor(
    private readonly repo: DiagnosticEventRepository,
    private readonly sessionId: string
  ) {}

  private base() {
    return { id: generateId(), recordedAt: new Date().toISOString(), sessionId: this.sessionId };
  }

  private fireAndForget(promise: Promise<unknown>): void {
    void promise.catch((err) => {
      console.warn("Diagnostics recorder failed to write an event — the app continues normally:", err);
    });
  }

  recordSessionEvent(event: RecorderInput<SessionEventRecord>): void {
    this.fireAndForget(this.repo.append({ ...event, ...this.base(), kind: "SessionEvent" }));
  }

  recordWrite(event: RecorderInput<WriteTraceRecord>): void {
    this.fireAndForget(this.repo.append({ ...event, ...this.base(), kind: "WriteTrace" }));
  }

  recordRead(event: RecorderInput<ReadTraceRecord>): void {
    this.fireAndForget(this.repo.append({ ...event, ...this.base(), kind: "ReadTrace" }));
  }

  recordDecision(event: RecorderInput<DecisionTraceRecord>): void {
    this.fireAndForget(this.repo.append({ ...event, ...this.base(), kind: "DecisionTrace" }));
  }

  recordRuleExecution(event: RecorderInput<RuleExecutionRecord>): void {
    this.fireAndForget(this.repo.append({ ...event, ...this.base(), kind: "RuleExecution" }));
  }

  recordPerfSample(event: RecorderInput<PerfSampleRecord>): void {
    this.fireAndForget(this.repo.append({ ...event, ...this.base(), kind: "PerfSample" }));
  }
}

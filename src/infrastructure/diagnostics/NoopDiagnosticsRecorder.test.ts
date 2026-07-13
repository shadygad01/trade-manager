import { describe, expect, it } from "vitest";
import { NoopDiagnosticsRecorder } from "./NoopDiagnosticsRecorder";

describe("NoopDiagnosticsRecorder", () => {
  it("every method is a no-op that returns undefined and never throws", () => {
    const recorder = new NoopDiagnosticsRecorder();

    expect(recorder.recordSessionEvent({ label: "x" })).toBeUndefined();
    expect(
      recorder.recordWrite({ writer: "w", function: "f", file: "file.ts", table: "trades", objectId: "1", valueSource: "reference", reason: "r" })
    ).toBeUndefined();
    expect(recorder.recordRead({ reader: "r", function: "f", file: "file.ts", factSeqCursor: 1 })).toBeUndefined();
    expect(
      recorder.recordDecision({
        decisionType: "Verification",
        reader: "r",
        function: "f",
        decision: "d",
        inputSummary: "in",
        outputSummary: "out",
        factSeqCursor: 1,
      })
    ).toBeUndefined();
    expect(
      recorder.recordRuleExecution({ ruleName: "n", passed: true, factSeqCursor: 1, reason: "r", durationMs: 1 })
    ).toBeUndefined();
    expect(recorder.recordPerfSample({ operation: "Import", durationMs: 1 })).toBeUndefined();
  });
});

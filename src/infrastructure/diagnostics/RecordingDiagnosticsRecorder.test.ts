import { describe, expect, it, vi } from "vitest";
import { RecordingDiagnosticsRecorder } from "./RecordingDiagnosticsRecorder";
import type { DiagnosticEvent } from "@domain/entities/diagnostics/DiagnosticEvent";
import type { DiagnosticEventRepository } from "@domain/repositories";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeRepo(): DiagnosticEventRepository & { events: DiagnosticEvent[] } {
  const events: DiagnosticEvent[] = [];
  return {
    events,
    async append(event) {
      const record = { ...event, seq: events.length + 1 } as DiagnosticEvent;
      events.push(record);
      return record;
    },
    async getBySession() {
      return events;
    },
    async getRecent() {
      return events;
    },
    async pruneOlderThan() {
      return 0;
    },
  };
}

describe("RecordingDiagnosticsRecorder", () => {
  it("recordSessionEvent appends a fully-formed event without the caller awaiting anything", async () => {
    const repo = fakeRepo();
    const recorder = new RecordingDiagnosticsRecorder(repo, "session-1");

    recorder.recordSessionEvent({ label: "App started" });
    await flush();

    expect(repo.events).toHaveLength(1);
    const event = repo.events[0];
    expect(event.kind).toBe("SessionEvent");
    expect(event.sessionId).toBe("session-1");
    expect(typeof event.id).toBe("string");
    expect(typeof event.recordedAt).toBe("string");
  });

  it("every record* method reaches the repository with the right kind", async () => {
    const repo = fakeRepo();
    const recorder = new RecordingDiagnosticsRecorder(repo, "session-1");

    recorder.recordWrite({ writer: "w", function: "f", file: "file.ts", table: "trades", objectId: "1", valueSource: "reference", reason: "r" });
    recorder.recordRead({ reader: "r", function: "f", file: "file.ts", factSeqCursor: 1 });
    recorder.recordDecision({
      decisionType: "Verification",
      reader: "r",
      function: "f",
      decision: "d",
      inputSummary: "in",
      outputSummary: "out",
      factSeqCursor: 1,
    });
    recorder.recordRuleExecution({ ruleName: "n", passed: true, factSeqCursor: 1, reason: "r", durationMs: 1 });
    recorder.recordPerfSample({ operation: "Import", durationMs: 1 });
    await flush();

    expect(repo.events.map((e) => e.kind)).toEqual(["WriteTrace", "ReadTrace", "DecisionTrace", "RuleExecution", "PerfSample"]);
  });

  it("a failing repository write is caught and logged, never thrown into the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo: DiagnosticEventRepository = {
      append: async () => {
        throw new Error("boom");
      },
      getBySession: async () => [],
      getRecent: async () => [],
      pruneOlderThan: async () => 0,
    };
    const recorder = new RecordingDiagnosticsRecorder(repo, "session-1");

    expect(() => recorder.recordSessionEvent({ label: "App started" })).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

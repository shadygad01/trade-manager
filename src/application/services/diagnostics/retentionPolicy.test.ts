import { describe, expect, it } from "vitest";
import { pruneDiagnostics, EVENT_RETENTION_DAYS, EVENT_RETENTION_MAX_COUNT, CASE_RETENTION_MAX_COUNT } from "./retentionPolicy";
import type { DiagnosticEvent } from "@domain/entities/diagnostics/DiagnosticEvent";
import type { DiagnosticCase } from "@domain/entities/diagnostics/DiagnosticCase";
import type { DiagnosticEventRepository, DiagnosticCaseRepository } from "@domain/repositories";

function fakeEventRepo(events: DiagnosticEvent[]): DiagnosticEventRepository & { prunedCutoffs: string[] } {
  const prunedCutoffs: string[] = [];
  return {
    prunedCutoffs,
    async append(e) {
      const record = { ...e, seq: events.length + 1 } as DiagnosticEvent;
      events.push(record);
      return record;
    },
    async getBySession() {
      return events;
    },
    async getRecent(limit) {
      return events.slice(-limit);
    },
    async pruneOlderThan(cutoff) {
      prunedCutoffs.push(cutoff);
      const before = events.length;
      const kept = events.filter((e) => e.recordedAt >= cutoff);
      events.length = 0;
      events.push(...kept);
      return before - kept.length;
    },
  };
}

function fakeCaseRepo(cases: DiagnosticCase[]): DiagnosticCaseRepository & { pruneCalls: number[] } {
  const pruneCalls: number[] = [];
  return {
    pruneCalls,
    async getAll() {
      return cases;
    },
    async search() {
      return cases;
    },
    async replaceForGroupKeys() {},
    async pruneToMostRecent(limit) {
      pruneCalls.push(limit);
      const before = cases.length;
      const kept = cases.slice(0, limit);
      cases.length = 0;
      cases.push(...kept);
      return before - kept.length;
    },
  };
}

function event(recordedAt: string): DiagnosticEvent {
  return { id: crypto.randomUUID(), seq: 0, recordedAt, sessionId: "s1", kind: "SessionEvent", label: "x" };
}

describe("pruneDiagnostics", () => {
  it("prunes events older than the day-based cutoff when under the count cap", async () => {
    const now = new Date("2026-07-13T00:00:00.000Z");
    const events = [event("2026-01-01T00:00:00.000Z"), event("2026-07-01T00:00:00.000Z")];
    const eventRepo = fakeEventRepo(events);
    const caseRepo = fakeCaseRepo([]);

    const result = await pruneDiagnostics(eventRepo, caseRepo, now);

    expect(result.prunedEvents).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].recordedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("uses the count-based cutoff when it would keep fewer events than the day-based one", async () => {
    const now = new Date("2026-07-13T00:00:00.000Z");
    // All events are recent (within EVENT_RETENTION_DAYS), so only the count cap should bite.
    const events = Array.from({ length: EVENT_RETENTION_MAX_COUNT + 1 }, (_, i) =>
      event(new Date(now.getTime() - (EVENT_RETENTION_MAX_COUNT - i) * 1000).toISOString())
    );
    const eventRepo = fakeEventRepo(events);
    const caseRepo = fakeCaseRepo([]);

    const result = await pruneDiagnostics(eventRepo, caseRepo, now);

    expect(result.prunedEvents).toBe(1);
    expect(events).toHaveLength(EVENT_RETENTION_MAX_COUNT);
  });

  it("caps cases at CASE_RETENTION_MAX_COUNT", async () => {
    const cases = Array.from({ length: CASE_RETENTION_MAX_COUNT + 5 }, (_, i) => ({
      id: `c${i}`,
      groupKey: `g${i}`,
      severity: "INFO" as const,
      triggerType: "Unknown" as const,
      firstOccurrenceEventSeq: i,
      latestOccurrenceEventSeq: i,
      occurrenceCount: 1,
      context: { browser: "x", browserVersion: "1", appVersion: "0.1.0", schemaVersion: 5, featureFlags: [] },
    }));
    const eventRepo = fakeEventRepo([]);
    const caseRepo = fakeCaseRepo(cases);

    const result = await pruneDiagnostics(eventRepo, caseRepo);

    expect(result.prunedCases).toBe(5);
    expect(cases).toHaveLength(CASE_RETENTION_MAX_COUNT);
  });

  it("EVENT_RETENTION_DAYS is a sane positive number", () => {
    expect(EVENT_RETENTION_DAYS).toBeGreaterThan(0);
  });
});

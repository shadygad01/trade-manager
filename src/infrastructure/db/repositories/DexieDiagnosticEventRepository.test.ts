import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieDiagnosticEventRepository } from "./DexieDiagnosticEventRepository";
import type { SessionEventRecord } from "@domain/entities/diagnostics/DiagnosticEvent";

function sessionEvent(overrides: Partial<Omit<SessionEventRecord, "seq">> = {}): Omit<SessionEventRecord, "seq"> {
  return {
    id: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    sessionId: "session-1",
    kind: "SessionEvent",
    label: "App started",
    ...overrides,
  };
}

describe("DexieDiagnosticEventRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieDiagnosticEventRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieDiagnosticEventRepository(db);
  });

  it("assigns sequential seq numbers starting at 1, in append order", async () => {
    const first = await repo.append(sessionEvent());
    const second = await repo.append(sessionEvent({ label: "Import started" }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it("getBySession only returns events from that session, ordered by seq", async () => {
    await repo.append(sessionEvent({ sessionId: "session-1", label: "a" }));
    await repo.append(sessionEvent({ sessionId: "session-2", label: "b" }));
    await repo.append(sessionEvent({ sessionId: "session-1", label: "c" }));

    const forSession = await repo.getBySession("session-1");
    expect(forSession).toHaveLength(2);
    expect(forSession.map((e) => (e as SessionEventRecord).label)).toEqual(["a", "c"]);
  });

  it("getRecent returns the most recent N events in ascending seq order", async () => {
    await repo.append(sessionEvent({ label: "a" }));
    await repo.append(sessionEvent({ label: "b" }));
    await repo.append(sessionEvent({ label: "c" }));

    const recent = await repo.getRecent(2);
    expect(recent.map((e) => (e as SessionEventRecord).label)).toEqual(["b", "c"]);
  });

  it("pruneOlderThan deletes only events recorded before the cutoff", async () => {
    await repo.append(sessionEvent({ label: "old", recordedAt: "2026-01-01T00:00:00.000Z" }));
    await repo.append(sessionEvent({ label: "new", recordedAt: "2026-06-01T00:00:00.000Z" }));

    const pruned = await repo.pruneOlderThan("2026-03-01T00:00:00.000Z");
    expect(pruned).toBe(1);

    const remaining = await repo.getRecent(10);
    expect(remaining.map((e) => (e as SessionEventRecord).label)).toEqual(["new"]);
  });

  it("has no update or delete method beyond pruneOlderThan — immutability is enforced by the interface shape, not convention", () => {
    expect((repo as unknown as { update?: unknown }).update).toBeUndefined();
    expect((repo as unknown as { delete?: unknown }).delete).toBeUndefined();
  });
});

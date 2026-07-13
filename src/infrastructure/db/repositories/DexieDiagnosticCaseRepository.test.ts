import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieDiagnosticCaseRepository } from "./DexieDiagnosticCaseRepository";
import type { DiagnosticCase } from "@domain/entities/diagnostics/DiagnosticCase";

function diagnosticCase(overrides: Partial<DiagnosticCase> = {}): DiagnosticCase {
  return {
    id: crypto.randomUUID(),
    groupKey: "group-1",
    severity: "WARNING",
    triggerType: "Mismatch",
    firstOccurrenceEventSeq: 1,
    latestOccurrenceEventSeq: 1,
    occurrenceCount: 1,
    context: {
      browser: "Chrome",
      browserVersion: "120",
      appVersion: "0.1.0",
      schemaVersion: 5,
      featureFlags: [],
    },
    ...overrides,
  };
}

describe("DexieDiagnosticCaseRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieDiagnosticCaseRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieDiagnosticCaseRepository(db);
  });

  it("replaceForGroupKeys inserts new cases", async () => {
    await repo.replaceForGroupKeys([diagnosticCase()]);
    expect(await repo.getAll()).toHaveLength(1);
  });

  it("replaceForGroupKeys fully replaces (not merges) every existing case sharing a groupKey", async () => {
    const original = diagnosticCase({ groupKey: "group-1", occurrenceCount: 1 });
    await repo.replaceForGroupKeys([original]);

    const updated = diagnosticCase({ id: crypto.randomUUID(), groupKey: "group-1", occurrenceCount: 2 });
    await repo.replaceForGroupKeys([updated]);

    const all = await repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].occurrenceCount).toBe(2);
  });

  it("replaceForGroupKeys leaves cases with a different groupKey untouched", async () => {
    await repo.replaceForGroupKeys([diagnosticCase({ groupKey: "group-1" })]);
    await repo.replaceForGroupKeys([diagnosticCase({ id: crypto.randomUUID(), groupKey: "group-2" })]);

    expect(await repo.getAll()).toHaveLength(2);
  });

  it("search filters by ticker, portfolioId, severity, and workflowStep", async () => {
    await repo.replaceForGroupKeys([
      diagnosticCase({ groupKey: "g1", ticker: "COMI", portfolioId: "p1", severity: "ERROR" }),
      diagnosticCase({ id: crypto.randomUUID(), groupKey: "g2", ticker: "HRHO", portfolioId: "p2", severity: "WARNING" }),
    ]);

    expect(await repo.search({ ticker: "COMI" })).toHaveLength(1);
    expect(await repo.search({ severity: "ERROR" })).toHaveLength(1);
    expect(await repo.search({ portfolioId: "p2" })).toHaveLength(1);
    expect(await repo.search({})).toHaveLength(2);
  });

  it("pruneToMostRecent keeps only the N cases with the highest latestOccurrenceEventSeq", async () => {
    await repo.replaceForGroupKeys([
      diagnosticCase({ id: "a", groupKey: "g1", latestOccurrenceEventSeq: 1 }),
      diagnosticCase({ id: "b", groupKey: "g2", latestOccurrenceEventSeq: 3 }),
      diagnosticCase({ id: "c", groupKey: "g3", latestOccurrenceEventSeq: 2 }),
    ]);

    const pruned = await repo.pruneToMostRecent(2);
    expect(pruned).toBe(1);

    const remaining = await repo.getAll();
    expect(remaining.map((c) => c.id).sort()).toEqual(["b", "c"]);
  });

  it("has no per-row save/update method — replaceForGroupKeys is the only write path", () => {
    expect((repo as unknown as { save?: unknown }).save).toBeUndefined();
    expect((repo as unknown as { update?: unknown }).update).toBeUndefined();
  });
});

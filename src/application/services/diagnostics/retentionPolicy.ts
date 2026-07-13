import type { DiagnosticEventRepository, DiagnosticCaseRepository } from "@domain/repositories";

/**
 * docs/DIAGNOSTICS_CENTER_SPEC.md Part 9 — diagnostics data is debugging
 * exhaust, not business data, and must not grow unbounded on a machine that
 * never restarts the browser for weeks. Named constants in one place,
 * deliberately easy to tune after real-world usage without touching the
 * pruning logic itself.
 */
export const EVENT_RETENTION_DAYS = 30;
export const EVENT_RETENTION_MAX_COUNT = 5000;
export const CASE_RETENTION_MAX_COUNT = 200;

/**
 * Runs once per app boot when Developer Mode is on (Part 4.3), never from
 * business logic. Caps `diagnosticEvents` at the SMALLER of
 * EVENT_RETENTION_MAX_COUNT or EVENT_RETENTION_DAYS (whichever cutoff keeps
 * fewer rows wins) and caps `diagnosticCases` at CASE_RETENTION_MAX_COUNT
 * most-recently-active cases.
 */
export async function pruneDiagnostics(
  eventRepo: DiagnosticEventRepository,
  caseRepo: DiagnosticCaseRepository,
  now: Date = new Date()
): Promise<{ prunedEvents: number; prunedCases: number }> {
  const dayCutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const mostRecent = await eventRepo.getRecent(EVENT_RETENTION_MAX_COUNT);
  const countCutoff = mostRecent.length >= EVENT_RETENTION_MAX_COUNT ? mostRecent[0].recordedAt : null;
  const cutoff = countCutoff && countCutoff > dayCutoff ? countCutoff : dayCutoff;

  const prunedEvents = await eventRepo.pruneOlderThan(cutoff);
  const prunedCases = await caseRepo.pruneToMostRecent(CASE_RETENTION_MAX_COUNT);
  return { prunedEvents, prunedCases };
}

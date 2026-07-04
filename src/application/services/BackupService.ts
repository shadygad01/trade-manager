import type { Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { JournalEntry } from "@domain/entities/JournalEntry";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { AppRepositories } from "./types";

export const LEDGER_SNAPSHOT_VERSION = 1;

export interface LedgerSnapshot {
  schemaVersion: number;
  exportedAt: string;
  portfolios: Portfolio[];
  trades: Trade[];
  allocations: TradeAllocation[];
  timelineEvents: TimelineEvent[];
  journalEntries: JournalEntry[];
  verifications: PositionVerification[];
}

export class UnsupportedSnapshotVersionError extends Error {
  constructor(foundVersion: number) {
    super(
      `This backup file is from a newer app version (schema v${foundVersion}, this app reads up to v${LEDGER_SNAPSHOT_VERSION}) — update the app before restoring it.`
    );
    this.name = "UnsupportedSnapshotVersionError";
  }
}

export class InvalidSnapshotError extends Error {
  constructor(reason: string) {
    super(`This doesn't look like a Portfolio OS backup file: ${reason}`);
    this.name = "InvalidSnapshotError";
  }
}

/**
 * A full snapshot of every portfolio's data — everything needed to restore
 * the ledger on another device, or after a cleared browser profile (the
 * fully-client-side architecture's one accepted trade-off — see
 * ARCHITECTURE.md ADR-001). Deliberately excludes `Upload` rows: those are
 * OCR duplicate-file bookkeeping, not financial data, and are meaningless to
 * replay on a different browser anyway.
 */
export async function exportLedger(repos: AppRepositories): Promise<LedgerSnapshot> {
  const [portfolios, trades, allocations, timelineEvents, journalEntries, verifications] = await Promise.all([
    repos.portfolios.getAll(),
    repos.trades.getAll(),
    repos.allocations.getAll(),
    repos.timeline.getAll(),
    repos.journal.getAll(),
    repos.verifications.getAll(),
  ]);

  return {
    schemaVersion: LEDGER_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    portfolios,
    trades,
    allocations,
    timelineEvents,
    journalEntries,
    verifications,
  };
}

function assertValidSnapshot(value: unknown): asserts value is LedgerSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new InvalidSnapshotError("not a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.schemaVersion !== "number") {
    throw new InvalidSnapshotError("missing a schemaVersion.");
  }
  for (const key of ["portfolios", "trades", "allocations", "timelineEvents", "journalEntries", "verifications"]) {
    if (!Array.isArray(record[key])) {
      throw new InvalidSnapshotError(`missing or malformed "${key}".`);
    }
  }
}

export function parseLedgerSnapshot(json: string): LedgerSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidSnapshotError("the file isn't valid JSON.");
  }
  assertValidSnapshot(value);
  if (value.schemaVersion > LEDGER_SNAPSHOT_VERSION) {
    throw new UnsupportedSnapshotVersionError(value.schemaVersion);
  }
  return value;
}

/**
 * Replaces every portfolio's data with the snapshot's contents. This is a
 * full replace, not a merge — every existing portfolio/trade/allocation/
 * timeline event/journal entry/verification is deleted first, so the ledger
 * after import exactly matches the snapshot rather than a blend of old and
 * new. The caller is expected to have already confirmed this destructive
 * intent with the user before calling this.
 */
export async function importLedger(repos: AppRepositories, snapshot: LedgerSnapshot): Promise<void> {
  if (snapshot.schemaVersion > LEDGER_SNAPSHOT_VERSION) {
    throw new UnsupportedSnapshotVersionError(snapshot.schemaVersion);
  }

  const [existingAllocations, existingTimeline, existingJournal, existingVerifications, existingTrades, existingPortfolios] =
    await Promise.all([
      repos.allocations.getAll(),
      repos.timeline.getAll(),
      repos.journal.getAll(),
      repos.verifications.getAll(),
      repos.trades.getAll(),
      repos.portfolios.getAll(),
    ]);

  await Promise.all(existingAllocations.map((a) => repos.allocations.delete(a.id)));
  await Promise.all(existingTimeline.map((e) => repos.timeline.delete(e.id)));
  await Promise.all(existingJournal.map((j) => repos.journal.delete(j.id)));
  await Promise.all(existingVerifications.map((v) => repos.verifications.delete(v.id)));
  await Promise.all(existingTrades.map((t) => repos.trades.delete(t.id)));
  await Promise.all(existingPortfolios.map((p) => repos.portfolios.delete(p.id)));

  for (const portfolio of snapshot.portfolios) await repos.portfolios.save(portfolio);
  for (const trade of snapshot.trades) await repos.trades.save(trade);
  for (const allocation of snapshot.allocations) await repos.allocations.save(allocation);
  for (const event of snapshot.timelineEvents) await repos.timeline.save(event);
  for (const entry of snapshot.journalEntries) await repos.journal.save(entry);
  for (const verification of snapshot.verifications) await repos.verifications.save(verification);
}

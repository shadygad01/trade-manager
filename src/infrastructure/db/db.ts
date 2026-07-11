import Dexie, { type EntityTable } from "dexie";
import type { Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { JournalEntry } from "@domain/entities/JournalEntry";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { Upload } from "@domain/entities/Upload";
import type { RawTransaction } from "@domain/entities/RawTransaction";
import type { LedgerEvent } from "@domain/entities/LedgerEvent";
import type { Allocation } from "@domain/entities/Allocation";
import type { PendingExecution } from "@domain/entities/PendingExecution";

/** Storage row wrapping a LedgerEvent with the (portfolioId, ticker) keying Dexie needs — never exposed outside DexieCommittedLedgerRepository. `id` is composite (`portfolioId|eventId`) because LedgerEvent.eventId alone isn't unique across portfolios: two different portfolios could coincidentally hold economically identical trades. */
export interface LedgerCacheRow {
  id: string;
  portfolioId: string;
  ticker: string;
  event: LedgerEvent;
}

/** Same reasoning as LedgerCacheRow, for Allocation. */
export interface AllocationCacheRow {
  id: string;
  portfolioId: string;
  ticker: string;
  allocation: Allocation;
}

export class PortfolioOsDatabase extends Dexie {
  portfolios!: EntityTable<Portfolio, "id">;
  trades!: EntityTable<Trade, "id">;
  tradeAllocations!: EntityTable<TradeAllocation, "id">;
  timelineEvents!: EntityTable<TimelineEvent, "id">;
  journalEntries!: EntityTable<JournalEntry, "id">;
  verifications!: EntityTable<PositionVerification, "id">;
  uploads!: EntityTable<Upload, "id">;
  rawTransactions!: EntityTable<RawTransaction, "id">;
  ledgerCache!: EntityTable<LedgerCacheRow, "id">;
  allocationsCache!: EntityTable<AllocationCacheRow, "id">;
  pendingExecutions!: EntityTable<PendingExecution, "id">;

  constructor(name = "PortfolioOsDatabase") {
    super(name);

    this.version(1).stores({
      portfolios: "&id, kind, archivedAt",
      trades: "&id, portfolioId, ticker, [portfolioId+ticker], executionDate",
      tradeAllocations: "&id, portfolioId, tradeId, ticker, sellGroupId, [portfolioId+ticker]",
      timelineEvents: "&id, portfolioId, type, ticker, timestamp",
      journalEntries: "&id, tradeId, portfolioId",
      verifications: "&id, portfolioId, ticker, [portfolioId+ticker], capturedAt",
      uploads: "&id, portfolioId, fileHash, [portfolioId+fileHash], status",
    });

    // Additive only: every v1 table is re-listed with its exact original
    // index string so this upgrade cannot alter existing data, plus one new
    // table (rawTransactions) for the append-only fact log — see
    // RawTransaction's own doc comment. `seq` is not the Dexie primary key
    // (it isn't auto-increment-assignable there without making `id` a
    // number, breaking this app's uniform string-id convention); it's a
    // plain indexed field the repository assigns manually and atomically at
    // append time instead — see DexieRawTransactionRepository.append.
    this.version(2).stores({
      portfolios: "&id, kind, archivedAt",
      trades: "&id, portfolioId, ticker, [portfolioId+ticker], executionDate",
      tradeAllocations: "&id, portfolioId, tradeId, ticker, sellGroupId, [portfolioId+ticker]",
      timelineEvents: "&id, portfolioId, type, ticker, timestamp",
      journalEntries: "&id, tradeId, portfolioId",
      verifications: "&id, portfolioId, ticker, [portfolioId+ticker], capturedAt",
      uploads: "&id, portfolioId, fileHash, [portfolioId+fileHash], status",
      rawTransactions: "&id, seq, portfolioId, kind, ticker",
    });

    // Additive again: v1/v2 tables re-listed verbatim, plus the Commit
    // Engine's two materialized read-model tables (ledgerCache,
    // allocationsCache) — see CommittedLedgerRepository's own doc comment
    // for why they're always written together, never independently.
    this.version(3).stores({
      portfolios: "&id, kind, archivedAt",
      trades: "&id, portfolioId, ticker, [portfolioId+ticker], executionDate",
      tradeAllocations: "&id, portfolioId, tradeId, ticker, sellGroupId, [portfolioId+ticker]",
      timelineEvents: "&id, portfolioId, type, ticker, timestamp",
      journalEntries: "&id, tradeId, portfolioId",
      verifications: "&id, portfolioId, ticker, [portfolioId+ticker], capturedAt",
      uploads: "&id, portfolioId, fileHash, [portfolioId+fileHash], status",
      rawTransactions: "&id, seq, portfolioId, kind, ticker",
      ledgerCache: "&id, portfolioId, ticker, [portfolioId+ticker]",
      allocationsCache: "&id, portfolioId, ticker, [portfolioId+ticker]",
    });

    // Additive again: v1/v2/v3 tables re-listed verbatim, plus
    // pendingExecutions — partial-fill executions held outside the
    // Trade/TradeAllocation ledger until their broker invoice is confirmed
    // (see PendingExecution's own doc comment for why this is its own table
    // rather than a flag on Trade/TradeAllocation: a flagged-but-already-
    // created Trade was the actual bug this table fixes).
    this.version(4).stores({
      portfolios: "&id, kind, archivedAt",
      trades: "&id, portfolioId, ticker, [portfolioId+ticker], executionDate",
      tradeAllocations: "&id, portfolioId, tradeId, ticker, sellGroupId, [portfolioId+ticker]",
      timelineEvents: "&id, portfolioId, type, ticker, timestamp",
      journalEntries: "&id, tradeId, portfolioId",
      verifications: "&id, portfolioId, ticker, [portfolioId+ticker], capturedAt",
      uploads: "&id, portfolioId, fileHash, [portfolioId+fileHash], status",
      rawTransactions: "&id, seq, portfolioId, kind, ticker",
      ledgerCache: "&id, portfolioId, ticker, [portfolioId+ticker]",
      allocationsCache: "&id, portfolioId, ticker, [portfolioId+ticker]",
      pendingExecutions: "&id, portfolioId, ticker, [portfolioId+ticker], verificationStatus",
    });
  }
}

export const db = new PortfolioOsDatabase();

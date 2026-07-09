import Dexie, { type EntityTable } from "dexie";
import type { Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { JournalEntry } from "@domain/entities/JournalEntry";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { Upload } from "@domain/entities/Upload";
import type { RawTransaction } from "@domain/entities/RawTransaction";

export class PortfolioOsDatabase extends Dexie {
  portfolios!: EntityTable<Portfolio, "id">;
  trades!: EntityTable<Trade, "id">;
  tradeAllocations!: EntityTable<TradeAllocation, "id">;
  timelineEvents!: EntityTable<TimelineEvent, "id">;
  journalEntries!: EntityTable<JournalEntry, "id">;
  verifications!: EntityTable<PositionVerification, "id">;
  uploads!: EntityTable<Upload, "id">;
  rawTransactions!: EntityTable<RawTransaction, "id">;

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
  }
}

export const db = new PortfolioOsDatabase();

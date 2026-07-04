import Dexie, { type EntityTable } from "dexie";
import type { Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { JournalEntry } from "@domain/entities/JournalEntry";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { Upload } from "@domain/entities/Upload";

export class PortfolioOsDatabase extends Dexie {
  portfolios!: EntityTable<Portfolio, "id">;
  trades!: EntityTable<Trade, "id">;
  tradeAllocations!: EntityTable<TradeAllocation, "id">;
  timelineEvents!: EntityTable<TimelineEvent, "id">;
  journalEntries!: EntityTable<JournalEntry, "id">;
  verifications!: EntityTable<PositionVerification, "id">;
  uploads!: EntityTable<Upload, "id">;

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
  }
}

export const db = new PortfolioOsDatabase();

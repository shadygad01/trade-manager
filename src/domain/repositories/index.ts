import type { Portfolio } from "../entities/Portfolio";
import type { Trade } from "../entities/Trade";
import type { TradeAllocation } from "../entities/TradeAllocation";
import type { TimelineEvent } from "../entities/TimelineEvent";
import type { JournalEntry } from "../entities/JournalEntry";
import type { PositionVerification } from "../entities/PositionVerification";
import type { Upload } from "../entities/Upload";

export interface PortfolioRepository {
  getAll(): Promise<Portfolio[]>;
  getById(id: string): Promise<Portfolio | undefined>;
  save(portfolio: Portfolio): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TradeRepository {
  getAll(): Promise<Trade[]>;
  getByPortfolio(portfolioId: string): Promise<Trade[]>;
  getById(id: string): Promise<Trade | undefined>;
  save(trade: Trade): Promise<void>;
  saveRemainingShares(tradeId: string, remainingShares: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TradeAllocationRepository {
  getAll(): Promise<TradeAllocation[]>;
  getByPortfolio(portfolioId: string): Promise<TradeAllocation[]>;
  getByTrade(tradeId: string): Promise<TradeAllocation[]>;
  save(allocation: TradeAllocation): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TimelineRepository {
  getAll(): Promise<TimelineEvent[]>;
  getByPortfolio(portfolioId: string): Promise<TimelineEvent[]>;
  save(event: TimelineEvent): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface JournalRepository {
  getAll(): Promise<JournalEntry[]>;
  getByTrade(tradeId: string): Promise<JournalEntry | undefined>;
  getByPortfolio(portfolioId: string): Promise<JournalEntry[]>;
  save(entry: JournalEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface VerificationRepository {
  getAll(): Promise<PositionVerification[]>;
  getByPortfolio(portfolioId: string): Promise<PositionVerification[]>;
  getLatest(portfolioId: string, ticker: string): Promise<PositionVerification | undefined>;
  save(verification: PositionVerification): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface UploadRepository {
  getAll(): Promise<Upload[]>;
  getByPortfolio(portfolioId: string): Promise<Upload[]>;
  /** File-hash dedup is global — the same screenshot re-uploaded is a duplicate regardless of which portfolio its candidates end up assigned to. */
  getByHash(fileHash: string): Promise<Upload | undefined>;
  save(upload: Upload): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Read-only access to the single source of truth for current market prices. */
export interface PriceRepository {
  getPrice(ticker: string): Promise<number | undefined>;
  getAllPrices(): Promise<Record<string, number>>;
  getSnapshotTimestamp(): Promise<string | undefined>;
}

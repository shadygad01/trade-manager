import type {
  PortfolioRepository,
  TradeRepository,
  TradeAllocationRepository,
  TimelineRepository,
  JournalRepository,
  VerificationRepository,
  UploadRepository,
  RawTransactionRepository,
  CommittedLedgerRepository,
  PendingExecutionRepository,
} from "@domain/repositories";
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
import type { AppRepositories } from "@application/services/types";

export function createFakePortfolioRepository(seed: Portfolio[] = []): PortfolioRepository {
  const store = new Map(seed.map((p) => [p.id, p]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getById(id) {
      return store.get(id);
    },
    async save(portfolio) {
      store.set(portfolio.id, portfolio);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function createFakeTradeRepository(seed: Trade[] = []): TradeRepository {
  const store = new Map(seed.map((t) => [t.id, t]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByTicker(ticker) {
      return [...store.values()].filter((t) => t.ticker === ticker);
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((t) => t.portfolioId === portfolioId);
    },
    async getById(id) {
      return store.get(id);
    },
    async save(trade) {
      store.set(trade.id, trade);
    },
    async saveRemainingShares(tradeId, remainingShares) {
      const trade = store.get(tradeId);
      if (!trade) throw new Error(`fake trade repo: trade not found ${tradeId}`);
      store.set(tradeId, { ...trade, remainingShares });
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function createFakeTradeAllocationRepository(seed: TradeAllocation[] = []): TradeAllocationRepository {
  const store = new Map(seed.map((a) => [a.id, a]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByTicker(ticker) {
      return [...store.values()].filter((a) => a.ticker === ticker);
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((a) => a.portfolioId === portfolioId);
    },
    async getByTrade(tradeId) {
      return [...store.values()].filter((a) => a.tradeId === tradeId);
    },
    async save(allocation) {
      store.set(allocation.id, allocation);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function createFakeTimelineRepository(seed: TimelineEvent[] = []): TimelineRepository {
  const store = new Map(seed.map((e) => [e.id, e]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((e) => e.portfolioId === portfolioId);
    },
    async save(event) {
      store.set(event.id, event);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function createFakeJournalRepository(seed: JournalEntry[] = []): JournalRepository {
  const store = new Map(seed.map((e) => [e.id, e]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByTrade(tradeId) {
      return [...store.values()].find((e) => e.tradeId === tradeId);
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((e) => e.portfolioId === portfolioId);
    },
    async save(entry) {
      store.set(entry.id, entry);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function createFakeVerificationRepository(seed: PositionVerification[] = []): VerificationRepository {
  const store = new Map(seed.map((v) => [v.id, v]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByTicker(ticker) {
      return [...store.values()].filter((v) => v.ticker === ticker);
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((v) => v.portfolioId === portfolioId);
    },
    async getLatest(portfolioId, ticker) {
      const matches = [...store.values()].filter((v) => v.portfolioId === portfolioId && v.ticker === ticker);
      return matches.sort((a, b) => (a.capturedAt > b.capturedAt ? -1 : 1))[0];
    },
    async save(verification) {
      store.set(verification.id, verification);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function createFakeUploadRepository(seed: Upload[] = []): UploadRepository {
  const store = new Map(seed.map((u) => [u.id, u]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((u) => u.portfolioId === portfolioId);
    },
    async getByHash(fileHash) {
      return [...store.values()].find((u) => u.fileHash === fileHash);
    },
    async save(upload) {
      store.set(upload.id, upload);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

/** seq assignment mirrors DexieRawTransactionRepository.append: monotonic, atomic within this in-memory store. */
export function createFakeRawTransactionRepository(seed: RawTransaction[] = []): RawTransactionRepository {
  const store = new Map(seed.map((t) => [t.id, t]));
  let nextSeq = seed.reduce((max, t) => Math.max(max, t.seq), 0);
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((t) => t.portfolioId === portfolioId);
    },
    async getByTicker(ticker) {
      return [...store.values()].filter((t) => t.ticker === ticker);
    },
    async getById(id) {
      return store.get(id);
    },
    async getRevision() {
      return nextSeq;
    },
    async getControlFacts() {
      return [...store.values()].filter((t) => t.kind === "PortfolioAssignment" || t.kind === "Correction" || t.kind === "Retraction");
    },
    async append(transaction) {
      nextSeq += 1;
      const record = { ...transaction, seq: nextSeq };
      store.set(record.id, record);
      return record;
    },
  };
}

export function createFakePendingExecutionRepository(seed: PendingExecution[] = []): PendingExecutionRepository {
  const store = new Map(seed.map((p) => [p.id, p]));
  return {
    async getAll() {
      return [...store.values()];
    },
    async getByPortfolio(portfolioId) {
      return [...store.values()].filter((p) => p.portfolioId === portfolioId);
    },
    async getById(id) {
      return store.get(id);
    },
    async save(pendingExecution) {
      store.set(pendingExecution.id, pendingExecution);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

/** Mirrors DexieCommittedLedgerRepository: commitTicker is the only write path, full delete-and-replace per (portfolioId, ticker). */
export function createFakeCommittedLedgerRepository(): CommittedLedgerRepository {
  const events = new Map<string, LedgerEvent[]>();
  const allocations = new Map<string, Allocation[]>();
  const key = (portfolioId: string, ticker: string) => `${portfolioId}|${ticker}`;
  return {
    async getLedgerEvents(portfolioId, ticker) {
      return events.get(key(portfolioId, ticker)) ?? [];
    },
    async getAllocations(portfolioId, ticker) {
      return allocations.get(key(portfolioId, ticker)) ?? [];
    },
    async commitTicker(params) {
      events.set(key(params.portfolioId, params.ticker), params.events);
      allocations.set(key(params.portfolioId, params.ticker), params.allocations);
    },
  };
}

export function createFakeRepositories(seed?: {
  portfolios?: Portfolio[];
  trades?: Trade[];
  allocations?: TradeAllocation[];
  timeline?: TimelineEvent[];
  journal?: JournalEntry[];
  verifications?: PositionVerification[];
  uploads?: Upload[];
  pendingExecutions?: PendingExecution[];
}): AppRepositories {
  return {
    portfolios: createFakePortfolioRepository(seed?.portfolios),
    trades: createFakeTradeRepository(seed?.trades),
    allocations: createFakeTradeAllocationRepository(seed?.allocations),
    timeline: createFakeTimelineRepository(seed?.timeline),
    journal: createFakeJournalRepository(seed?.journal),
    verifications: createFakeVerificationRepository(seed?.verifications),
    uploads: createFakeUploadRepository(seed?.uploads),
    pendingExecutions: createFakePendingExecutionRepository(seed?.pendingExecutions),
  };
}

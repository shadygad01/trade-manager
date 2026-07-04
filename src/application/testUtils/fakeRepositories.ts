import type {
  PortfolioRepository,
  TradeRepository,
  TradeAllocationRepository,
  TimelineRepository,
} from "@domain/repositories";
import type { Portfolio } from "@domain/entities/Portfolio";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
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

export function createFakeRepositories(seed?: {
  portfolios?: Portfolio[];
  trades?: Trade[];
  allocations?: TradeAllocation[];
  timeline?: TimelineEvent[];
}): AppRepositories {
  return {
    portfolios: createFakePortfolioRepository(seed?.portfolios),
    trades: createFakeTradeRepository(seed?.trades),
    allocations: createFakeTradeAllocationRepository(seed?.allocations),
    timeline: createFakeTimelineRepository(seed?.timeline),
  };
}

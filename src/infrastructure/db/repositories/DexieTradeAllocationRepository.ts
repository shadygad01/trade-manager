import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TradeAllocationRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieTradeAllocationRepository implements TradeAllocationRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<TradeAllocation[]> {
    return this.db.tradeAllocations.toArray();
  }

  async getByTicker(ticker: string): Promise<TradeAllocation[]> {
    return this.db.tradeAllocations.where("ticker").equals(ticker).toArray();
  }

  async getByPortfolio(portfolioId: string): Promise<TradeAllocation[]> {
    return this.db.tradeAllocations.where("portfolioId").equals(portfolioId).toArray();
  }

  async getByTrade(tradeId: string): Promise<TradeAllocation[]> {
    return this.db.tradeAllocations.where("tradeId").equals(tradeId).toArray();
  }

  async save(allocation: TradeAllocation): Promise<void> {
    await this.db.tradeAllocations.put(allocation);
  }

  async delete(id: string): Promise<void> {
    await this.db.tradeAllocations.delete(id);
  }
}

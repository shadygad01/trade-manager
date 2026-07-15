import type { Trade } from "@domain/entities/Trade";
import type { TradeRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieTradeRepository implements TradeRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<Trade[]> {
    return this.db.trades.toArray();
  }

  async getByTicker(ticker: string): Promise<Trade[]> {
    return this.db.trades.where("ticker").equals(ticker).toArray();
  }

  async getByPortfolio(portfolioId: string): Promise<Trade[]> {
    return this.db.trades.where("portfolioId").equals(portfolioId).toArray();
  }

  async getById(id: string): Promise<Trade | undefined> {
    return this.db.trades.get(id);
  }

  async save(trade: Trade): Promise<void> {
    await this.db.trades.put(trade);
  }

  /** Targeted update so recomputing derived state never re-serializes attachments/notes. */
  async saveRemainingShares(tradeId: string, remainingShares: number): Promise<void> {
    await this.db.trades.update(tradeId, { remainingShares });
  }

  async delete(id: string): Promise<void> {
    await this.db.trades.delete(id);
  }
}

import type { JournalEntry } from "@domain/entities/JournalEntry";
import type { JournalRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieJournalRepository implements JournalRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getByTrade(tradeId: string): Promise<JournalEntry | undefined> {
    return this.db.journalEntries.where("tradeId").equals(tradeId).first();
  }

  async getByPortfolio(portfolioId: string): Promise<JournalEntry[]> {
    return this.db.journalEntries.where("portfolioId").equals(portfolioId).toArray();
  }

  async save(entry: JournalEntry): Promise<void> {
    await this.db.journalEntries.put(entry);
  }

  async delete(id: string): Promise<void> {
    await this.db.journalEntries.delete(id);
  }
}

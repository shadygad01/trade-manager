import type { Portfolio } from "@domain/entities/Portfolio";
import type { PortfolioRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexiePortfolioRepository implements PortfolioRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<Portfolio[]> {
    return this.db.portfolios.toArray();
  }

  async getById(id: string): Promise<Portfolio | undefined> {
    return this.db.portfolios.get(id);
  }

  async save(portfolio: Portfolio): Promise<void> {
    await this.db.portfolios.put(portfolio);
  }

  async delete(id: string): Promise<void> {
    await this.db.portfolios.delete(id);
  }
}

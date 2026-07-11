import type { PendingExecution } from "@domain/entities/PendingExecution";
import type { PendingExecutionRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexiePendingExecutionRepository implements PendingExecutionRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<PendingExecution[]> {
    return this.db.pendingExecutions.toArray();
  }

  async getByPortfolio(portfolioId: string): Promise<PendingExecution[]> {
    return this.db.pendingExecutions.where("portfolioId").equals(portfolioId).toArray();
  }

  async getById(id: string): Promise<PendingExecution | undefined> {
    return this.db.pendingExecutions.get(id);
  }

  async save(pendingExecution: PendingExecution): Promise<void> {
    await this.db.pendingExecutions.put(pendingExecution);
  }

  async delete(id: string): Promise<void> {
    await this.db.pendingExecutions.delete(id);
  }
}

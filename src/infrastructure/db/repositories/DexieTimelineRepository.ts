import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { TimelineRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieTimelineRepository implements TimelineRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getByPortfolio(portfolioId: string): Promise<TimelineEvent[]> {
    return this.db.timelineEvents.where("portfolioId").equals(portfolioId).toArray();
  }

  async save(event: TimelineEvent): Promise<void> {
    await this.db.timelineEvents.put(event);
  }

  async delete(id: string): Promise<void> {
    await this.db.timelineEvents.delete(id);
  }
}

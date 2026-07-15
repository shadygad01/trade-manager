import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { TimelineRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieTimelineRepository implements TimelineRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<TimelineEvent[]> {
    return this.db.timelineEvents.toArray();
  }

  async getByPortfolio(portfolioId: string): Promise<TimelineEvent[]> {
    return this.db.timelineEvents.where("portfolioId").equals(portfolioId).toArray();
  }

  async save(event: TimelineEvent): Promise<void> {
    await this.db.timelineEvents.put(event);
  }

  async saveMany(events: TimelineEvent[]): Promise<void> {
    if (events.length > 0) await this.db.timelineEvents.bulkPut(events);
  }

  async delete(id: string): Promise<void> {
    await this.db.timelineEvents.delete(id);
  }
}

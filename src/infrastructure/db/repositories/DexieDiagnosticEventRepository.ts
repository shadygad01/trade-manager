import type { DiagnosticEvent } from "@domain/entities/diagnostics/DiagnosticEvent";
import type { DiagnosticEventRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieDiagnosticEventRepository implements DiagnosticEventRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  /**
   * The only write path onto this table — no update/delete beyond
   * pruneOlderThan exists anywhere on this class, matching
   * DiagnosticEventRepository's interface exactly (same discipline as
   * DexieRawTransactionRepository.append).
   */
  async append(event: Omit<DiagnosticEvent, "seq">): Promise<DiagnosticEvent> {
    return this.db.transaction("rw", this.db.diagnosticEvents, async () => {
      const last = await this.db.diagnosticEvents.orderBy("seq").last();
      const record = { ...event, seq: (last?.seq ?? 0) + 1 } as DiagnosticEvent;
      await this.db.diagnosticEvents.add(record);
      return record;
    });
  }

  async getBySession(sessionId: string): Promise<DiagnosticEvent[]> {
    return this.db.diagnosticEvents.where("sessionId").equals(sessionId).sortBy("seq");
  }

  async getRecent(limit: number): Promise<DiagnosticEvent[]> {
    const rows = await this.db.diagnosticEvents.orderBy("seq").reverse().limit(limit).toArray();
    return rows.reverse();
  }

  /** Part 9 retention pruning — deletes events older than `cutoff`, oldest first. Never called from business logic, only from the Developer-Mode-only startup hook (Part 4.3). */
  async pruneOlderThan(cutoff: string): Promise<number> {
    const staleKeys = await this.db.diagnosticEvents.where("recordedAt").below(cutoff).primaryKeys();
    await this.db.diagnosticEvents.bulkDelete(staleKeys);
    return staleKeys.length;
  }
}

import type { DiagnosticCase } from "@domain/entities/diagnostics/DiagnosticCase";
import type { DiagnosticCaseRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieDiagnosticCaseRepository implements DiagnosticCaseRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<DiagnosticCase[]> {
    return this.db.diagnosticCases.toArray();
  }

  async search(filter: {
    ticker?: string;
    portfolioId?: string;
    severity?: DiagnosticCase["severity"];
    workflowStep?: DiagnosticCase["workflowStep"];
  }): Promise<DiagnosticCase[]> {
    const all = await this.db.diagnosticCases.toArray();
    return all.filter(
      (c) =>
        (filter.ticker === undefined || c.ticker === filter.ticker) &&
        (filter.portfolioId === undefined || c.portfolioId === filter.portfolioId) &&
        (filter.severity === undefined || c.severity === filter.severity) &&
        (filter.workflowStep === undefined || c.workflowStep === filter.workflowStep)
    );
  }

  /**
   * The only write path onto this table — no per-row save/update exists
   * anywhere on this class. Deletes every existing row whose groupKey
   * appears in `cases`, then inserts the given cases — full replace, never a
   * merge or patch, matching DexieCommittedLedgerRepository.commitTicker's
   * discipline.
   */
  async replaceForGroupKeys(cases: DiagnosticCase[]): Promise<void> {
    const groupKeys = [...new Set(cases.map((c) => c.groupKey))];
    if (groupKeys.length === 0) return;
    await this.db.transaction("rw", this.db.diagnosticCases, async () => {
      const existingKeys = await this.db.diagnosticCases.where("groupKey").anyOf(groupKeys).primaryKeys();
      await this.db.diagnosticCases.bulkDelete(existingKeys);
      await this.db.diagnosticCases.bulkAdd(cases);
    });
  }

  /** Part 9 retention pruning — caps the table at the most-recently-active `limit` cases. */
  async pruneToMostRecent(limit: number): Promise<number> {
    const all = await this.db.diagnosticCases.orderBy("latestOccurrenceEventSeq").reverse().toArray();
    const stale = all.slice(limit);
    if (stale.length === 0) return 0;
    await this.db.diagnosticCases.bulkDelete(stale.map((c) => c.id));
    return stale.length;
  }
}

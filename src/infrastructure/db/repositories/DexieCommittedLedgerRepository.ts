import type { LedgerEvent } from "@domain/entities/LedgerEvent";
import type { Allocation } from "@domain/entities/Allocation";
import type { CommittedLedgerRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieCommittedLedgerRepository implements CommittedLedgerRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getLedgerEvents(portfolioId: string, ticker: string): Promise<LedgerEvent[]> {
    const rows = await this.db.ledgerCache.where("[portfolioId+ticker]").equals([portfolioId, ticker]).toArray();
    return rows.map((r) => r.event);
  }

  async getAllocations(portfolioId: string, ticker: string): Promise<Allocation[]> {
    const rows = await this.db.allocationsCache.where("[portfolioId+ticker]").equals([portfolioId, ticker]).toArray();
    return rows.map((r) => r.allocation);
  }

  /**
   * The only write path onto either cache table — no per-row save/update
   * exists anywhere on this class. Deletes every existing row for
   * (portfolioId, ticker) in both tables and writes the fresh set, inside
   * one Dexie read-write transaction spanning both — a reader can never
   * observe ledgerCache updated while allocationsCache still reflects the
   * prior state, or vice versa. Full replace, never a merge or patch.
   */
  async commitTicker(params: { portfolioId: string; ticker: string; events: LedgerEvent[]; allocations: Allocation[] }): Promise<void> {
    const { portfolioId, ticker, events, allocations } = params;
    await this.db.transaction("rw", this.db.ledgerCache, this.db.allocationsCache, async () => {
      const existingLedgerRows = await this.db.ledgerCache.where("[portfolioId+ticker]").equals([portfolioId, ticker]).primaryKeys();
      const existingAllocationRows = await this.db.allocationsCache.where("[portfolioId+ticker]").equals([portfolioId, ticker]).primaryKeys();
      await this.db.ledgerCache.bulkDelete(existingLedgerRows);
      await this.db.allocationsCache.bulkDelete(existingAllocationRows);

      await this.db.ledgerCache.bulkAdd(
        events.map((event) => ({ id: `${portfolioId}|${event.eventId}`, portfolioId, ticker, event }))
      );
      await this.db.allocationsCache.bulkAdd(
        allocations.map((allocation) => ({ id: `${portfolioId}|${allocation.id}`, portfolioId, ticker, allocation }))
      );
    });
  }
}

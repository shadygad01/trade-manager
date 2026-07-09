import type { RawTransaction } from "@domain/entities/RawTransaction";
import type { RawTransactionRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieRawTransactionRepository implements RawTransactionRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<RawTransaction[]> {
    return this.db.rawTransactions.toArray();
  }

  async getByPortfolio(portfolioId: string): Promise<RawTransaction[]> {
    return this.db.rawTransactions.where("portfolioId").equals(portfolioId).toArray();
  }

  async getByTicker(ticker: string): Promise<RawTransaction[]> {
    return this.db.rawTransactions.where("ticker").equals(ticker).toArray();
  }

  async getById(id: string): Promise<RawTransaction | undefined> {
    return this.db.rawTransactions.get(id);
  }

  /**
   * The only write path onto this table — no update/delete exists anywhere
   * on this class, matching RawTransactionRepository's interface exactly.
   * `seq` can't be a Dexie auto-increment primary key without making `id` a
   * number (breaking this app's string-id convention everywhere else), so
   * it's assigned here, inside a single read-write transaction, by reading
   * the current max and adding one — atomic against concurrent appends from
   * the same page.
   */
  async append(transaction: Omit<RawTransaction, "seq">): Promise<RawTransaction> {
    return this.db.transaction("rw", this.db.rawTransactions, async () => {
      const last = await this.db.rawTransactions.orderBy("seq").last();
      const record: RawTransaction = { ...transaction, seq: (last?.seq ?? 0) + 1 };
      await this.db.rawTransactions.add(record);
      return record;
    });
  }
}

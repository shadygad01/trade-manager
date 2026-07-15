import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { VerificationRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieVerificationRepository implements VerificationRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getAll(): Promise<PositionVerification[]> {
    return this.db.verifications.toArray();
  }

  async getByTicker(ticker: string): Promise<PositionVerification[]> {
    return this.db.verifications.where("ticker").equals(ticker).toArray();
  }

  async getByPortfolio(portfolioId: string): Promise<PositionVerification[]> {
    return this.db.verifications.where("portfolioId").equals(portfolioId).toArray();
  }

  async getLatest(portfolioId: string, ticker: string): Promise<PositionVerification | undefined> {
    const matches = await this.db.verifications
      .where("[portfolioId+ticker]")
      .equals([portfolioId, ticker])
      .toArray();

    return matches.reduce<PositionVerification | undefined>((latest, current) => {
      if (!latest || current.capturedAt > latest.capturedAt) {
        return current;
      }
      return latest;
    }, undefined);
  }

  async save(verification: PositionVerification): Promise<void> {
    await this.db.verifications.put(verification);
  }

  async delete(id: string): Promise<void> {
    await this.db.verifications.delete(id);
  }
}

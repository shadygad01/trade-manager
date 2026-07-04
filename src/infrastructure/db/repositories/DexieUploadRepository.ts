import type { Upload } from "@domain/entities/Upload";
import type { UploadRepository } from "@domain/repositories";
import type { PortfolioOsDatabase } from "../db";

export class DexieUploadRepository implements UploadRepository {
  constructor(private readonly db: PortfolioOsDatabase) {}

  async getByPortfolio(portfolioId: string): Promise<Upload[]> {
    return this.db.uploads.where("portfolioId").equals(portfolioId).toArray();
  }

  async getByHash(portfolioId: string, fileHash: string): Promise<Upload | undefined> {
    return this.db.uploads
      .where("[portfolioId+fileHash]")
      .equals([portfolioId, fileHash])
      .first();
  }

  async save(upload: Upload): Promise<void> {
    await this.db.uploads.put(upload);
  }

  async delete(id: string): Promise<void> {
    await this.db.uploads.delete(id);
  }
}

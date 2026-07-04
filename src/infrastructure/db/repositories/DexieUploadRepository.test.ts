import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieUploadRepository } from "./DexieUploadRepository";
import type { Upload } from "@domain/entities/Upload";

function makeUpload(overrides: Partial<Upload> = {}): Upload {
  return {
    id: "upload-1",
    fileName: "statement.pdf",
    fileHash: "hash-1",
    contentType: "application/pdf",
    status: "parsed",
    candidates: [],
    createdAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DexieUploadRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieUploadRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieUploadRepository(db);
  });

  it("saves an upload with no portfolioId (a multi-portfolio import) and finds it by hash alone", async () => {
    const upload = makeUpload();
    await repo.save(upload);

    const found = await repo.getByHash("hash-1");
    expect(found).toEqual(upload);
  });

  it("finds an upload by hash regardless of which portfolio it was later assigned to", async () => {
    await repo.save(makeUpload({ id: "upload-1", fileHash: "hash-shared", portfolioId: "portfolio-1" }));

    const found = await repo.getByHash("hash-shared");
    expect(found?.portfolioId).toBe("portfolio-1");
  });

  it("returns undefined for an unknown hash", async () => {
    expect(await repo.getByHash("nope")).toBeUndefined();
  });

  it("deletes an upload", async () => {
    await repo.save(makeUpload());
    await repo.delete("upload-1");
    expect(await repo.getByHash("hash-1")).toBeUndefined();
  });
});

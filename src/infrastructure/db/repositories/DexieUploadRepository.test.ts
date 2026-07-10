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

  it("getAll returns every upload regardless of portfolio, for a full duplicate-history reset", async () => {
    await repo.save(makeUpload({ id: "upload-1", fileHash: "hash-1", portfolioId: "portfolio-1" }));
    await repo.save(makeUpload({ id: "upload-2", fileHash: "hash-2", portfolioId: undefined }));

    const all = await repo.getAll();
    expect(all.map((u) => u.id).sort()).toEqual(["upload-1", "upload-2"]);
  });

  it("persists the original document's bytes (fileBlob) permanently alongside its extracted text — the Evidence Repository durability fix", async () => {
    const originalBytes = new Blob(["%PDF-1.4 fake statement bytes"], { type: "application/pdf" });
    await repo.save(makeUpload({ rawText: "Buy COMI 10@45.50", fileBlob: originalBytes }));

    const found = await repo.getByHash("hash-1");
    expect(found?.fileBlob).toBeInstanceOf(Blob);
    expect(found?.fileBlob?.size).toBe(originalBytes.size);
    expect(await found?.fileBlob?.text()).toBe(await originalBytes.text());
    // The extracted text survives independently — re-parsing later never
    // requires re-reading the blob, but the blob is there if extraction
    // logic improves and a re-OCR/re-parse is ever needed.
    expect(found?.rawText).toBe("Buy COMI 10@45.50");
  });

  it("an upload with no fileBlob (e.g. a CSV, or one recorded before this field existed) round-trips fine with it left undefined", async () => {
    await repo.save(makeUpload());
    const found = await repo.getByHash("hash-1");
    expect(found?.fileBlob).toBeUndefined();
  });
});

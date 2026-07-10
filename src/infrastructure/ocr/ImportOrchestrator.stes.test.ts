import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as XLSX from "xlsx";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";
import { STES_PARSER_VERSION, STES_SCHEMA_NAME } from "../stes/StesWorkbookParser";

// pdfjs-dist requires browser globals (DOMMatrix) at import time and
// Tesseract spawns real workers — neither is reachable by the code paths
// under test (STES/CSV route before any image/PDF handling), so both are
// stubbed to make ImportOrchestrator importable in the node test env.
vi.mock("./pdfText", () => ({ extractPdfText: async () => "" }));
vi.mock("./tesseractClient", () => ({ recognizeWithFallback: async () => ({ text: "" }), recognizeBatch: async () => [] }));
vi.mock("./imagePreprocess", () => ({
  loadImageToCanvas: async () => null,
  cropHeaderBand: () => null,
  preprocessForOcr: () => null,
  segmentOrderRows: () => [],
}));

const { ImportOrchestrator } = await import("./ImportOrchestrator");

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function stesFile(): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Key", "Value"],
      ["Schema Name", STES_SCHEMA_NAME],
      ["Schema Version", "1.1"],
    ]),
    "Metadata",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Document ID", "File Name", "Document Type"],
      ["DOC-01", "statement.pdf", "STATEMENT"],
      ["DOC-02", "IMG_2214.png", "SCREENSHOT"],
    ]),
    "Documents",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Observation ID", "Document ID", "Transaction Type", "Ticker", "Trade Date", "Quantity", "Price", "Dividend Amount"],
      ["OBS-0001", "DOC-01", "BUY", "COMI", "2026-03-02", 100, 82.5, null],
      ["OBS-0002", "DOC-02", "DIVIDEND", "EAST", "2026-03-20", null, null, 340],
    ]),
    "Observations",
  );
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([bytes], "stes-import.xlsx", { type: XLSX_CONTENT_TYPE });
}

let originalTrackingStart: string;
beforeAll(() => {
  originalTrackingStart = getTrackingStartDate();
  setTrackingStartDate("2026-01-01");
});
afterAll(() => setTrackingStartDate(originalTrackingStart));

describe("ImportOrchestrator — STES workbook routing", () => {
  it("routes an .xlsx upload to the STES parser and converges into the standard ImportResult shape", async () => {
    const orchestrator = new ImportOrchestrator();
    const result = await orchestrator.importFile(stesFile());

    expect(result.status).toBe("parsed");
    expect(result.docType).toBe("stes-workbook");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      ticker: "COMI",
      side: "BUY",
      shares: 100,
      price: 82.5,
      date: "2026-03-02",
      source: "statement",
      extractionMethod: "stes-workbook",
      parserVersion: STES_PARSER_VERSION,
    });
    expect(result.dividends).toEqual([{ ticker: "EAST", companyName: undefined, date: "2026-03-20", amount: 340, source: "screenshot" }]);
    expect(result.verifications).toEqual([]);
    expect(result.orderEvidences).toEqual([]);
    // The workbook's own bytes are archived as the evidence document.
    expect(result.fileBlob).toBeDefined();
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawText).toContain("Observations");
  });

  it("fails an .xlsx that is not an STES workbook, with a specific reason", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Just", "Numbers"], [1, 2]]), "Sheet1");
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([bytes], "random.xlsx", { type: XLSX_CONTENT_TYPE });

    const orchestrator = new ImportOrchestrator();
    const result = await orchestrator.importFile(file);
    expect(result.status).toBe("failed");
    expect(result.docType).toBe("stes-workbook");
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]).toContain("Metadata");
  });

  it("still routes CSV text files through the existing CSV parser, unchanged", async () => {
    const csv = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,COMI,Buy,100,50.5"].join("\n");
    const file = new File([csv], "export.csv", { type: "text/csv" });

    const orchestrator = new ImportOrchestrator();
    const result = await orchestrator.importFile(file);
    expect(result.status).toBe("parsed");
    expect(result.docType).toBe("statement");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ ticker: "COMI", side: "BUY", shares: 100, price: 50.5, source: "csv", extractionMethod: "csv-text" });
  });
});

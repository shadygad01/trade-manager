import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as XLSX from "xlsx";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";
import { THNDR_ORDERS_WORKBOOK_PARSER_VERSION } from "../thndrOrders/ThndrOrdersWorkbookParser";

// See ImportOrchestrator.stes.test.ts for why these are stubbed — neither
// path under test (STES/Thndr-orders-workbook routing) reaches OCR/PDF code.
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

function thndrOrdersFile(): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Your Orders"],
      ["EAST"],
      ["08 Jul ’26 - 10:58 AM", "Buy Limit", "Good Till Cancel", "37.00 EGP", "34/34", "FULFILLED"],
      ["HRHO"],
      ["28 Jun ’26 - 11:20 AM", "Sell Limit SETTLED", "Good Till Cancel", "26.99 EGP", "0/39", "CANCELLED"],
    ]),
    "Sheet1",
  );
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([bytes], "your-orders.xlsx", { type: XLSX_CONTENT_TYPE });
}

let originalTrackingStart: string;
beforeAll(() => {
  originalTrackingStart = getTrackingStartDate();
  setTrackingStartDate("2026-01-01");
});
afterAll(() => setTrackingStartDate(originalTrackingStart));

describe("ImportOrchestrator — Thndr Orders workbook routing", () => {
  it("routes a native Thndr 'Your Orders' Excel export (not an STES workbook) into the standard ImportResult shape", async () => {
    const orchestrator = new ImportOrchestrator();
    const result = await orchestrator.importFile(thndrOrdersFile());

    expect(result.status).toBe("parsed");
    expect(result.docType).toBe("thndr-orders-workbook");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      ticker: "EAST",
      side: "BUY",
      shares: 34,
      price: 37,
      date: "2026-07-08",
      confidence: "high",
      source: "official-broker-excel",
      extractionMethod: "thndr-orders-workbook",
      parserVersion: THNDR_ORDERS_WORKBOOK_PARSER_VERSION,
    });
    expect(result.cancelledOrders).toEqual([
      expect.objectContaining({ ticker: "HRHO", side: "SELL", brokerStatus: "CANCELLED" }),
    ]);
    expect(result.fileBlob).toBeDefined();
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

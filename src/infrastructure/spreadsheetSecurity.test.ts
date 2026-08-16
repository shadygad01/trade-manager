import { describe, expect, it } from "vitest";
import { MAX_SPREADSHEET_BYTES, validateSpreadsheetBuffer, validateWorkbookShape } from "./spreadsheetSecurity";

const validZipHeader = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

describe("spreadsheet security boundaries", () => {
  it("rejects empty and non-ZIP uploads before SheetJS is invoked", () => {
    expect(validateSpreadsheetBuffer(new ArrayBuffer(0))).toContain("empty");
    expect(validateSpreadsheetBuffer(new TextEncoder().encode("not an xlsx").buffer)).toContain("valid .xlsx ZIP");
  });

  it("accepts a ZIP-shaped workbook buffer under the size limit", () => {
    expect(validateSpreadsheetBuffer(validZipHeader())).toBeUndefined();
  });

  it("rejects oversized workbook uploads", () => {
    const oversized = new ArrayBuffer(MAX_SPREADSHEET_BYTES + 1);
    const bytes = new Uint8Array(oversized);
    bytes.set([0x50, 0x4b, 0x03, 0x04]);
    expect(validateSpreadsheetBuffer(oversized)).toContain("too large");
  });

  it("rejects workbooks with no sheets", () => {
    expect(validateWorkbookShape({ SheetNames: [], Sheets: {} } as never)).toContain("no worksheets");
  });
});

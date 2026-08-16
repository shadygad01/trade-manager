import type { WorkBook, WorkSheet } from "xlsx";

/** Defensive limits for browser-side parsing of untrusted workbook uploads. */
export const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024;
export const MAX_SPREADSHEET_SHEETS = 32;
export const MAX_SPREADSHEET_ROWS = 100_000;
export const MAX_SPREADSHEET_COLUMNS = 256;

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function validateSpreadsheetBuffer(buffer: ArrayBuffer): string | undefined {
  if (buffer.byteLength === 0) return "The spreadsheet is empty.";
  if (buffer.byteLength > MAX_SPREADSHEET_BYTES) {
    return `The spreadsheet is too large. Maximum allowed size is ${Math.round(MAX_SPREADSHEET_BYTES / (1024 * 1024))} MB.`;
  }
  const bytes = new Uint8Array(buffer);
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  if (!isZip) return "The uploaded file is not a valid .xlsx ZIP package.";
  return undefined;
}

export function validateWorkbookShape(workbook: WorkBook): string | undefined {
  if (workbook.SheetNames.length === 0) return "The workbook contains no worksheets.";
  if (workbook.SheetNames.length > MAX_SPREADSHEET_SHEETS) return "The workbook contains too many worksheets.";
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const ref = sheet["!ref"];
    const address = typeof ref === "string" ? ref : undefined;
    const match = address?.match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/i);
    if (match && Number(match[2]) - Number(match[1]) + 1 > MAX_SPREADSHEET_ROWS) {
      return `Worksheet "${sheetName}" contains too many rows.`;
    }
  }
  return undefined;
}

/** Converts a worksheet to null-prototype records without attacker-controlled object keys. */
export function safeSheetToObjects(XLSX: typeof import("xlsx"), sheet: WorkSheet): Record<string, unknown>[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  if (matrix.length > MAX_SPREADSHEET_ROWS) throw new Error("Worksheet contains too many rows.");
  const headerRow = matrix.find((row) => row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ""));
  if (!headerRow) return [];
  const headers = headerRow.map((header) => String(header ?? "").trim()).slice(0, MAX_SPREADSHEET_COLUMNS);
  return matrix.slice(matrix.indexOf(headerRow) + 1).map((row) => {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    headers.forEach((header, index) => {
      if (header && !DANGEROUS_KEYS.has(header.toLowerCase())) record[header] = row[index] ?? null;
    });
    return record;
  });
}

export function safeReadOptions(): Record<string, unknown> {
  return {
    type: "array",
    cellDates: true,
    cellHTML: false,
    cellFormula: false,
    cellStyles: false,
    cellNF: false,
    bookDeps: false,
    bookFiles: false,
    bookProps: false,
    bookSheets: false,
    WTF: false,
  };
}

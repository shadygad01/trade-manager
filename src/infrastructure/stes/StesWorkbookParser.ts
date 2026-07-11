import type { ParsedDividendCandidate, ParsedTradeCandidate, ParsedCancelledOrder, ParseConfidence } from "@domain/entities/Upload";
import { defaultTrackedSince, isWithinTrackedRange } from "../ocr/parsers/trackedDateRange";

/**
 * Parser for the Standard Trading Exchange Schema (STES) v1.1 raw-extraction
 * workbook — the frozen input contract any external AI (ChatGPT, Claude,
 * Gemini, OCR pipelines, …) fills from broker documents. See
 * docs/STANDARD_TRADING_EXCHANGE_SCHEMA.md.
 *
 * This module does extraction + validation ONLY. Every Observations row is
 * converted into the exact same ParsedTradeCandidate/ParsedDividendCandidate
 * shapes the OCR parsers produce, so an STES upload converges into the one
 * existing Raw Evidence pipeline (importRecording → verification/
 * completeness engines → evidence graph). ZERO matching, deduplication,
 * verification, or ledger logic here — two observations of the same real
 * execution from two documents become two candidates, exactly as two
 * separately-uploaded documents would.
 */

export const STES_PARSER_ID = "stes";
export const STES_PARSER_VERSION = "1.0.0";
export const STES_SCHEMA_NAME = "Trade Manager Standard Trading Exchange";
export const STES_SUPPORTED_MAJOR = "1";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isStesWorkbookFile(file: { name: string; type: string }): boolean {
  return file.name.toLowerCase().endsWith(".xlsx") || file.type === XLSX_CONTENT_TYPE;
}

export interface StesParseResult {
  /** False only for file-level failures (unreadable workbook, missing sheet/column, wrong schema); row-level problems keep ok=true and surface per-row warnings instead. */
  ok: boolean;
  candidates: ParsedTradeCandidate[];
  dividends: ParsedDividendCandidate[];
  /** Fully-cancelled orders (Order Status contains "cancel" but not "partial") — audit trail only, never a trade candidate. See ParsedCancelledOrder's own doc comment. */
  cancelledOrders: ParsedCancelledOrder[];
  warnings: string[];
  /** Plain-text rendering of the workbook's sheets, for Upload.rawText (audit/debug) — the original bytes are archived separately via Upload.fileBlob. */
  rawText: string;
  documentCount: number;
  observationCount: number;
}

type DocumentSource = NonNullable<ParsedTradeCandidate["source"]>;

/**
 * Documents-sheet type → RawTransactionSource. STATEMENT/INVOICE/
 * ORDERS_SCREEN/CSV_EXPORT map onto the exact source values the OCR
 * pipeline already uses, so cross-source corroboration and evidence
 * authority treat an STES-imported statement observation identically to a
 * statement this app parsed itself. PDF deliberately maps to
 * "other-document", not "statement" — "some PDF" says nothing about which
 * document type it was, and inventing statement-level authority for it
 * would be fabricated trust.
 */
const DOCUMENT_TYPE_SOURCE: Record<string, DocumentSource> = {
  STATEMENT: "statement",
  INVOICE: "invoice",
  ORDERS_SCREEN: "orders-screen",
  CSV_EXPORT: "csv",
  NOTIFICATION: "notification",
  EMAIL: "email",
  SCREENSHOT: "screenshot",
  PDF: "other-document",
  OTHER: "other-document",
};

const CONFIDENCE_MAP: Record<string, ParseConfidence> = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

interface SheetRow {
  [header: string]: unknown;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/** Case/whitespace-insensitive cell lookup so a workbook whose headers differ only in casing still reads — the template's exact headers remain the documented contract. */
function cell(row: SheetRow, header: string): unknown {
  const wanted = normalizeHeader(header);
  for (const key of Object.keys(row)) {
    if (normalizeHeader(key) === wanted) return row[key];
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const text = String(value).trim();
  if (text.length === 0) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Excel's day-serial epoch (1899-12-30, accounting for the fabled Lotus leap-year bug xlsx already normalizes). */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The spec says ISO text dates, but "zero manual editing before upload"
 * means honoring what real generators actually emit: an ISO string, a JS
 * Date (cellDates reads), or a raw Excel day serial all coerce; anything
 * else is a per-row validation error, never a guess.
 */
function asIsoDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(EXCEL_EPOCH_UTC + Math.round(value) * MS_PER_DAY).toISOString().slice(0, 10);
  }
  const text = asText(value);
  if (!text) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return undefined;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return undefined;
  return iso;
}

function asTime(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  }
  const text = asText(value);
  if (!text) return undefined;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

const TICKER_PATTERN = /^[A-Z0-9]{2,6}$/;

interface ParsedDocument {
  source: DocumentSource;
  fileName?: string;
}

/**
 * Reads and validates an STES v1.1 workbook. File-level failures (not a
 * readable xlsx, missing sheet/column, wrong schema name/major version)
 * return ok=false with zero rows; every row-level problem rejects only that
 * observation, with a warning naming its Observation ID and the exact reason
 * — a partially-bad workbook is never silently dropped and never silently
 * completed.
 */
export async function parseStesWorkbook(buffer: ArrayBuffer): Promise<StesParseResult> {
  const failed = (warnings: string[], rawText = ""): StesParseResult => ({
    ok: false,
    candidates: [],
    dividends: [],
    cancelledOrders: [],
    warnings,
    rawText,
    documentCount: 0,
    observationCount: 0,
  });

  // Dynamic import so the xlsx library only ever loads (its own lazy chunk)
  // when an .xlsx file is actually imported — mirroring how Tesseract/pdfjs
  // are isolated from the main bundle.
  const XLSX = await import("xlsx");

  let workbook: import("xlsx").WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    return failed(["This .xlsx file couldn't be read as a spreadsheet — re-export it and try again."]);
  }

  const sheetByName = (name: string) => {
    const actual = workbook.SheetNames.find((n) => normalizeHeader(n) === normalizeHeader(name));
    return actual ? workbook.Sheets[actual] : undefined;
  };

  const metadataSheet = sheetByName("Metadata");
  const documentsSheet = sheetByName("Documents");
  const observationsSheet = sheetByName("Observations");
  const missingSheets = [
    !metadataSheet ? "Metadata" : null,
    !documentsSheet ? "Documents" : null,
    !observationsSheet ? "Observations" : null,
  ].filter((s): s is string => s !== null);
  if (missingSheets.length > 0) {
    return failed([
      `This workbook is missing the required sheet(s): ${missingSheets.join(", ")}. Use the STES v1.1 raw-extraction template (sheets: Metadata, Documents, Observations).`,
    ]);
  }

  const rawText = ["Metadata", "Documents", "Observations"]
    .map((name) => `--- ${name} ---\n${XLSX.utils.sheet_to_csv(sheetByName(name)!)}`)
    .join("\n\n");

  // --- Metadata: schema self-identification ---
  const metadataRows = XLSX.utils.sheet_to_json<SheetRow>(metadataSheet!, { defval: null });
  const metadata = new Map<string, string>();
  for (const row of metadataRows) {
    const key = asText(cell(row, "Key"));
    const value = asText(cell(row, "Value"));
    if (key) metadata.set(normalizeHeader(key), value ?? "");
  }
  const schemaName = metadata.get("schema name");
  if (schemaName !== STES_SCHEMA_NAME) {
    return failed(
      [
        schemaName
          ? `The Metadata sheet declares "${schemaName}" — not an STES workbook. Expected Schema Name: "${STES_SCHEMA_NAME}".`
          : `The Metadata sheet has no "Schema Name" entry — not an STES workbook. Use the STES v1.1 raw-extraction template.`,
      ],
      rawText,
    );
  }
  const schemaVersion = metadata.get("schema version") ?? "";
  const major = schemaVersion.split(".")[0];
  if (major !== STES_SUPPORTED_MAJOR) {
    return failed(
      [`Unsupported STES schema version "${schemaVersion || "(missing)"}" — this app supports version ${STES_SUPPORTED_MAJOR}.x.`],
      rawText,
    );
  }

  const warnings: string[] = [];

  // --- Documents: one evidence source per row ---
  const documentRows = XLSX.utils.sheet_to_json<SheetRow>(documentsSheet!, { defval: null });
  const documents = new Map<string, ParsedDocument>();
  for (let i = 0; i < documentRows.length; i++) {
    const row = documentRows[i];
    const id = asText(cell(row, "Document ID"));
    const typeText = asText(cell(row, "Document Type"))?.toUpperCase();
    if (!id && !typeText) continue;
    if (!id) {
      warnings.push(`Documents row ${i + 2}: missing Document ID — the row was ignored.`);
      continue;
    }
    if (documents.has(id)) {
      return failed([`Documents sheet: Document ID "${id}" appears more than once — every document needs a unique ID.`], rawText);
    }
    const source = typeText ? DOCUMENT_TYPE_SOURCE[typeText] : undefined;
    if (!source) {
      warnings.push(
        `Document "${id}": unknown Document Type "${typeText ?? "(blank)"}" — its observations were imported as "other document" evidence.`,
      );
    }
    documents.set(id, { source: source ?? "other-document", fileName: asText(cell(row, "File Name")) });
  }
  if (documents.size === 0) {
    return failed(["The Documents sheet has no document rows — every observation must reference a listed source document."], rawText);
  }

  // --- Observations ---
  const observationRows = XLSX.utils.sheet_to_json<SheetRow>(observationsSheet!, { defval: null });
  const headerCells = (XLSX.utils.sheet_to_json<unknown[]>(observationsSheet!, { header: 1 })[0] ?? []) as unknown[];
  const presentHeaders = new Set(headerCells.filter((h): h is string => typeof h === "string").map(normalizeHeader));
  const requiredColumns = ["Observation ID", "Document ID", "Transaction Type", "Ticker", "Trade Date", "Quantity", "Price", "Dividend Amount"];
  const missingColumns = requiredColumns.filter((c) => !presentHeaders.has(normalizeHeader(c)));
  if (observationRows.length > 0 && missingColumns.length > 0) {
    return failed(
      [`The Observations sheet is missing required column(s): ${missingColumns.join(", ")}. Use the STES v1.1 raw-extraction template.`],
      rawText,
    );
  }

  const candidates: ParsedTradeCandidate[] = [];
  const dividends: ParsedDividendCandidate[] = [];
  const cancelledOrders: ParsedCancelledOrder[] = [];
  const seenObservationIds = new Set<string>();
  const trackedSince = defaultTrackedSince();
  let outOfRangeCount = 0;
  let observationCount = 0;

  for (let i = 0; i < observationRows.length; i++) {
    const row = observationRows[i];
    const rowLabel = () => asText(cell(row, "Observation ID")) ?? `Observations row ${i + 2}`;
    const reject = (reason: string) => warnings.push(`${rowLabel()}: ${reason} — the observation was not imported.`);

    const observationId = asText(cell(row, "Observation ID"));
    const documentId = asText(cell(row, "Document ID"));
    const typeText = asText(cell(row, "Transaction Type"))?.toUpperCase();
    if (!observationId && !documentId && !typeText) continue;
    observationCount += 1;

    if (observationId) {
      if (seenObservationIds.has(observationId)) {
        reject(`duplicate Observation ID "${observationId}" — every observation row needs its own unique ID`);
        continue;
      }
      seenObservationIds.add(observationId);
    }

    if (!documentId || !documents.has(documentId)) {
      reject(documentId ? `references Document ID "${documentId}" which is not listed in the Documents sheet` : "missing Document ID");
      continue;
    }
    const document = documents.get(documentId)!;

    if (typeText !== "BUY" && typeText !== "SELL" && typeText !== "DIVIDEND") {
      reject(`unsupported Transaction Type "${typeText ?? "(blank)"}" — only BUY, SELL and DIVIDEND are accepted`);
      continue;
    }

    const date = asIsoDate(cell(row, "Trade Date"));
    if (!date) {
      reject(`missing or invalid Trade Date "${asText(cell(row, "Trade Date")) ?? "(blank)"}" — expected YYYY-MM-DD`);
      continue;
    }

    const currency = asText(cell(row, "Currency"))?.toUpperCase();
    if (currency && currency !== "EGP") {
      reject(`currency "${currency}" is not supported — this app is EGP-denominated`);
      continue;
    }

    const tickerText = asText(cell(row, "Ticker"))?.toUpperCase();
    const companyName = asText(cell(row, "Company Name"));
    const confidenceText = asText(cell(row, "Extraction Confidence"))?.toUpperCase();
    const confidence: ParseConfidence = confidenceText ? (CONFIDENCE_MAP[confidenceText] ?? "medium") : "medium";
    if (confidenceText && !CONFIDENCE_MAP[confidenceText]) {
      warnings.push(`${rowLabel()}: unknown Extraction Confidence "${confidenceText}" — treated as MEDIUM.`);
    }

    if (typeText === "DIVIDEND") {
      const amount = asNumber(cell(row, "Dividend Amount"));
      if (amount === undefined || amount <= 0) {
        reject("a DIVIDEND observation needs a positive Dividend Amount");
        continue;
      }
      if (asNumber(cell(row, "Quantity")) !== undefined || asNumber(cell(row, "Price")) !== undefined) {
        reject("a DIVIDEND observation must leave Quantity and Price blank — a filled value suggests the row was misclassified");
        continue;
      }
      if (!tickerText) {
        reject(`missing Ticker${companyName ? ` (company "${companyName}")` : ""} — a dividend can't be assigned without one`);
        continue;
      }
      if (!isWithinTrackedRange(date, trackedSince)) {
        outOfRangeCount += 1;
        continue;
      }
      dividends.push({ ticker: tickerText, companyName, date, amount, source: document.source });
      continue;
    }

    // BUY / SELL
    if (asNumber(cell(row, "Dividend Amount")) !== undefined) {
      reject(`a ${typeText} observation must leave Dividend Amount blank — a filled value suggests the row was misclassified`);
      continue;
    }
    if (!tickerText) {
      reject(
        `missing Ticker${companyName ? ` (company "${companyName}")` : ""} — fix the Ticker cell in the workbook, or record the trade manually`,
      );
      continue;
    }
    if (!TICKER_PATTERN.test(tickerText)) {
      reject(`Ticker "${tickerText}" is not a valid symbol (2-6 letters/digits)`);
      continue;
    }

    // Order Status classifies the row into one of the three execution
    // states this app recognizes (see docs/STANDARD_TRADING_EXCHANGE_SCHEMA.md):
    // "cancel" without "partial" = fully cancelled (zero shares ever
    // executed — never a trade candidate, no Quantity/Price required);
    // "partial" (with or without "cancel", e.g. "Partially filled" /
    // "Partially filled, canceled" / "Partial fill") = needs confirmation.
    // The old convention (Extraction Notes = "Needs Confirmation" with no
    // Order Status column at all) still works — a workbook generated before
    // this column existed must keep importing unchanged.
    const orderStatusText = asText(cell(row, "Order Status"));
    const orderStatusLower = orderStatusText?.toLowerCase() ?? "";
    const notesText = asText(cell(row, "Extraction Notes"));
    const legacyNeedsConfirmation = notesText?.trim().toLowerCase() === "needs confirmation";
    const isCancelled = /cancel/.test(orderStatusLower) && !/partial/.test(orderStatusLower);
    const isPartialFill = /partial/.test(orderStatusLower) || legacyNeedsConfirmation;

    if (isCancelled) {
      if (!isWithinTrackedRange(date, trackedSince)) {
        outOfRangeCount += 1;
        continue;
      }
      cancelledOrders.push({
        ticker: tickerText,
        companyName,
        side: typeText,
        originalShares: asNumber(cell(row, "Quantity")),
        originalPrice: asNumber(cell(row, "Price")),
        date,
        time: asTime(cell(row, "Trade Time")),
        brokerStatus: orderStatusText ?? "Cancelled",
        source: document.source,
      });
      continue;
    }

    const shares = asNumber(cell(row, "Quantity"));
    if (shares === undefined || shares <= 0 || !Number.isInteger(shares)) {
      reject(`missing or invalid Quantity "${asText(cell(row, "Quantity")) ?? "(blank)"}" — expected a positive whole-share count`);
      continue;
    }
    const price = asNumber(cell(row, "Price"));
    if (price === undefined || price <= 0) {
      reject(`missing or invalid Price "${asText(cell(row, "Price")) ?? "(blank)"}" — expected a positive per-share price`);
      continue;
    }
    const fees = asNumber(cell(row, "Fees"));
    const taxes = asNumber(cell(row, "Taxes"));
    if ((fees !== undefined && fees < 0) || (taxes !== undefined && taxes < 0)) {
      reject("Fees/Taxes can't be negative");
      continue;
    }
    // Gross/Net are deliberate redundancy: they exist to catch a misread
    // digit in Quantity or Price that no single field could reveal. A
    // failing cross-check flags the row (visible, review-worthy) but still
    // imports it — the numbers came from a real document and the
    // verification engines are the ones equipped to investigate further.
    const gross = asNumber(cell(row, "Gross Amount"));
    if (gross !== undefined) {
      const expected = shares * price;
      const tolerance = Math.max(0.05, expected * 0.001);
      if (Math.abs(gross - expected) > tolerance) {
        warnings.push(
          `${rowLabel()}: Gross Amount ${gross} doesn't match Quantity × Price = ${expected.toFixed(2)} — double-check this row before confirming it.`,
        );
      }
    }
    if (!isWithinTrackedRange(date, trackedSince)) {
      outOfRangeCount += 1;
      continue;
    }

    candidates.push({
      ticker: tickerText,
      companyName,
      side: typeText,
      shares,
      price,
      fees,
      taxes,
      date,
      time: asTime(cell(row, "Trade Time")),
      confidence,
      source: document.source,
      transactionNumber: asText(cell(row, "Transaction Reference")),
      needsConfirmation: isPartialFill ? true : undefined,
      brokerStatus: isPartialFill ? (orderStatusText ?? "Needs Confirmation") : undefined,
    });
  }

  if (outOfRangeCount > 0) {
    warnings.push(
      `${outOfRangeCount} observation(s) were outside the tracked date range (too old, or future-dated — a likely misread) and were excluded.`,
    );
  }
  if (observationCount === 0) {
    warnings.push("The Observations sheet has no observation rows — fill it from the source documents and re-upload.");
  }

  return {
    ok: true,
    candidates,
    dividends,
    cancelledOrders,
    warnings,
    rawText,
    documentCount: documents.size,
    observationCount,
  };
}

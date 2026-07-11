import type { ParsedCancelledOrder, ParsedTradeCandidate } from "@domain/entities/Upload";
import { parsePrice } from "../ocr/parsers/ThndrParser";

/**
 * Parser for Thndr's native "Your Orders" screen exported directly to Excel
 * (Account > Orders > Export) — distinct from both the STES raw-extraction
 * template (Metadata/Documents/Observations sheets) and the OCR subsystem's
 * screenshot-based Orders-screen parsing. Every field is read straight from
 * spreadsheet cells rather than reconstructed from flattened OCR text, so
 * there is no OCR uncertainty at all: every row this produces a candidate
 * from gets `confidence: "high"`.
 *
 * Layout (single sheet, title "Your Orders" in A1): a single-cell row
 * (column A only) introduces a ticker section; every order placed under that
 * ticker follows as a 6-column row (date/time, order type, time-in-force,
 * price, filled/total quantity, status) until the next single-cell row
 * changes ticker.
 */

export const THNDR_ORDERS_WORKBOOK_PARSER_ID = "thndr-orders-workbook";
export const THNDR_ORDERS_WORKBOOK_PARSER_VERSION = "1.0.0";

export interface ThndrOrdersWorkbookParseResult {
  /** False only when this file isn't recognized as a Thndr "Your Orders" export at all (wrong title cell, unreadable workbook). */
  ok: boolean;
  candidates: ParsedTradeCandidate[];
  /** CANCELLED/REJECTED/EXPIRED orders — audit trail only, see ParsedCancelledOrder's own doc comment. */
  cancelledOrders: ParsedCancelledOrder[];
  warnings: string[];
  /** Plain-text (CSV) rendering of the sheet, for Upload.rawText (audit/debug) — the original bytes are archived separately via Upload.fileBlob. */
  rawText: string;
}

const TICKER_PATTERN = /^[A-Z0-9]{2,6}$/;

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// "08 Jul '26 - 10:58 AM" (the apostrophe before the year is a typographic
// U+2019 in the real export; a straight apostrophe is accepted too in case a
// future export or manual edit uses one).
const ORDER_DATE_TIME_PATTERN = /^(\d{1,2})\s+([A-Za-z]{3})\s*[’']\s*(\d{2})\s*[-–]\s*(\d{1,2}:\d{2}\s*[AP]M)$/i;

function parseOrderDateTime(raw: string): { date: string; time: string } | null {
  const m = ORDER_DATE_TIME_PATTERN.exec(raw.trim());
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTH_MAP[m[2].toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  const year = 2000 + parseInt(m[3], 10);
  return { date: `${year}-${pad2(month)}-${pad2(day)}`, time: m[4].replace(/\s+/g, "").toUpperCase() };
}

function parseOrderPrice(raw: string): number | null {
  const m = /^([\d,]+(?:\.\d+)?)\s*EGP$/i.exec(raw.trim());
  if (!m) return null;
  const value = parsePrice(m[1]);
  return Number.isFinite(value) ? value : null;
}

// Excel/the exporting tool auto-converts a bare "N1/N2" quantity into an
// actual date whenever both numbers happen to look like a valid day/month —
// "12/12" (a fully-filled 12-share order) round-trips through Excel's own
// date parser and comes back out formatted as "12-Dec"; "7/50" (7 of 50
// executed) comes back as "Jul-50" (year-suffix format, since 50 isn't a
// valid day). Recovering the original two integers from the display text is
// exact for both shapes — "D-MMM" reads back as day/month, "MMM-YY" as
// month/year-suffix — verified against every such row in a real ~1000-order
// export (always symmetric for the "D-MMM" shape: a fully-filled small order
// always has day === month numerically). Deliberately conservative: an
// unexpected "D-MMM" row where day and month DISAGREE is never seen in real
// data, and guessing an ordering for it risks fabricating a share count in a
// financial ledger — so it's left unrecovered (caller reports it, never
// guesses).
function recoverAutoDatedFraction(raw: string): { executed: number; total: number } | null {
  let m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(raw.trim());
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTH_MAP[m[2].toLowerCase()];
    if (month && day === month) return { executed: day, total: day };
    return null;
  }
  m = /^([A-Za-z]{3})-(\d{2})$/.exec(raw.trim());
  if (m) {
    const month = MONTH_MAP[m[1].toLowerCase()];
    if (!month) return null;
    return { executed: month, total: parseInt(m[2], 10) };
  }
  return null;
}

function parseFraction(raw: string): { executed: number; total: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (m) return { executed: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  return recoverAutoDatedFraction(raw);
}

function parseSide(raw: string): "BUY" | "SELL" | null {
  if (/^buy\b/i.test(raw.trim())) return "BUY";
  if (/^sell\b/i.test(raw.trim())) return "SELL";
  return null;
}

/**
 * Reads and validates a Thndr "Your Orders" Excel export. File-level
 * non-recognition (not readable as a workbook, or the first populated cell
 * isn't the "Your Orders" title) returns ok=false with zero rows; every
 * row-level problem (unreadable ticker section, missing quantity, malformed
 * date) rejects only that row, surfaced as a summarized warning — never
 * silently dropped and never silently completed.
 */
export async function parseThndrOrdersWorkbook(buffer: ArrayBuffer): Promise<ThndrOrdersWorkbookParseResult> {
  const notRecognized = (): ThndrOrdersWorkbookParseResult => ({ ok: false, candidates: [], cancelledOrders: [], warnings: [], rawText: "" });

  // Dynamic import so the xlsx library only ever loads when an .xlsx file is
  // actually imported — mirroring StesWorkbookParser.ts.
  const XLSX = await import("xlsx");

  let workbook: import("xlsx").WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    return notRecognized();
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return notRecognized();

  // sheet_to_json pads every row out to the sheet's declared dimension
  // (this export declares "A1:F<n>"), so a "single-cell" header row still
  // comes back as a 6-element array with 5 nulls — row shape has to be read
  // from which cells are actually populated, never from array length.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: null });
  const firstRow = rows.find((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
  const title = firstRow ? String(firstRow[0] ?? "").trim().toLowerCase() : "";
  if (title !== "your orders") return notRecognized();

  const rawText = XLSX.utils.sheet_to_csv(sheet);
  const candidates: ParsedTradeCandidate[] = [];
  const cancelledOrders: ParsedCancelledOrder[] = [];
  const warnings: string[] = [];

  let currentTicker: string | null = null;
  let skippedNoTicker = 0;
  let skippedValueOrders = 0;
  let skippedMalformed = 0;
  let skippedContradictoryFulfilled = 0;

  for (const row of rows) {
    const cells = row.map((c) => (c === null || c === undefined ? "" : String(c).trim()));
    const populated = cells.filter((c) => c !== "").length;
    if (populated === 0) continue;

    if (populated === 1) {
      const header = cells[0].toUpperCase();
      if (header === "YOUR ORDERS") continue;
      currentTicker = TICKER_PATTERN.test(header) ? header : null;
      continue;
    }

    if (populated !== 6) {
      skippedMalformed += 1;
      continue;
    }

    const [dateRaw, typeRaw, , priceRaw, fractionRaw, statusRaw] = cells;
    const dateTime = parseOrderDateTime(dateRaw);
    const side = parseSide(typeRaw);
    const status = statusRaw.toUpperCase();

    if (!dateTime || !side) {
      skippedMalformed += 1;
      continue;
    }

    if (status === "CANCELLED" || status === "REJECTED" || status === "EXPIRED") {
      if (!currentTicker) {
        skippedNoTicker += 1;
        continue;
      }
      const fraction = parseFraction(fractionRaw);
      cancelledOrders.push({
        ticker: currentTicker,
        side,
        originalShares: fraction?.total,
        originalPrice: parseOrderPrice(priceRaw) ?? undefined,
        date: dateTime.date,
        time: dateTime.time,
        brokerStatus: statusRaw,
        source: "orders-screen",
      });
      continue;
    }

    if (status !== "FULFILLED" && status !== "PARTIALLY FILLED") {
      // PENDING (not yet executed) and any other/unknown status never
      // create a trade or a cancelled-order audit row.
      continue;
    }

    if (!currentTicker) {
      skippedNoTicker += 1;
      continue;
    }

    if (fractionRaw.trim() === "-") {
      // A "buy this many EGP worth" order — this export prints no share
      // count for it at all, so it can never be reconstructed here.
      skippedValueOrders += 1;
      continue;
    }

    const fraction = parseFraction(fractionRaw);
    const price = parseOrderPrice(priceRaw);
    if (!fraction || price === null) {
      skippedMalformed += 1;
      continue;
    }

    if (fraction.executed <= 0) {
      if (status === "FULFILLED") skippedContradictoryFulfilled += 1;
      continue;
    }

    candidates.push({
      ticker: currentTicker,
      side,
      shares: fraction.executed,
      price,
      date: dateTime.date,
      time: dateTime.time,
      confidence: "high",
      source: "orders-screen",
      needsConfirmation: status === "PARTIALLY FILLED" ? true : undefined,
      brokerStatus: status === "PARTIALLY FILLED" ? statusRaw : undefined,
    });
  }

  if (skippedNoTicker > 0) {
    warnings.push(`${skippedNoTicker} order row(s) skipped — the ticker section they belonged to couldn't be identified.`);
  }
  if (skippedValueOrders > 0) {
    warnings.push(
      `${skippedValueOrders} cash-amount order(s) skipped — this export prints no share count for "invest by EGP amount" orders.`,
    );
  }
  if (skippedMalformed > 0) {
    warnings.push(`${skippedMalformed} order row(s) skipped — couldn't be read (malformed date, type, or quantity).`);
  }
  if (skippedContradictoryFulfilled > 0) {
    warnings.push(`${skippedContradictoryFulfilled} order row(s) marked FULFILLED but showed 0 executed shares — skipped as contradictory.`);
  }

  return { ok: true, candidates, cancelledOrders, warnings, rawText };
}

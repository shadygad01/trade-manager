import type { ParsedDividendCandidate, ParsedTradeCandidate } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { BrokerParser, OrderRowText, OrderRowsParseResult, OrdersScreenParseResult, OrdersTimelineParseResult } from "./BrokerParser";
import { defaultTrackedSince, isWithinTrackedRange, partitionByRange } from "./trackedDateRange";

/**
 * Second BrokerParser implementation (after ThndrParser), proving the
 * "modular and continuously extensible" OCR subsystem requirement against a
 * genuinely different input shape rather than a second screenshot layout:
 * a plain CSV/TSV transaction export, the format most brokers and banks
 * offer as an alternative to screenshots. No OCR/image processing is
 * involved — the file's bytes already are the text (see
 * ImportOrchestrator's non-image/non-PDF branch).
 */

const HEADER_ALIASES: Record<"date" | "side" | "ticker" | "shares" | "price" | "fees" | "taxes", string[]> = {
  date: ["date", "trade date", "execution date", "transaction date"],
  side: ["type", "side", "transaction type", "action", "buy/sell"],
  ticker: ["ticker", "symbol", "stock", "security"],
  shares: ["quantity", "shares", "qty", "units"],
  price: ["price", "execution price", "unit price", "fill price"],
  fees: ["fees", "commission", "brokerage fee"],
  taxes: ["taxes", "tax"],
};

type ColumnMap = Partial<Record<keyof typeof HEADER_ALIASES, number>>;

function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t"];
  return candidates.reduce((best, d) => (headerLine.split(d).length > headerLine.split(best).length ? d : best));
}

function mapColumns(headerCells: string[]): ColumnMap {
  const normalized = headerCells.map((c) => c.trim().toLowerCase());
  const map: ColumnMap = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof typeof HEADER_ALIASES, string[]][]) {
    const index = normalized.findIndex((cell) => aliases.includes(cell));
    if (index >= 0) map[field] = index;
  }
  return map;
}

/** Accepts "2026-02-19", "19/2/2026", and "2/19/2026" (assumed d/m/y, matching the region this product targets) without a locale-dependent Date() parse. */
function parseCsvDate(raw: string): string | null {
  const trimmed = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function parseCsvNumber(raw: string): number {
  return parseFloat(raw.replace(/[,\s]/g, ""));
}

function parseRows(text: string): ParsedTradeCandidate[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const delimiter = detectDelimiter(lines[0]);
  const columns = mapColumns(lines[0].split(delimiter));
  if (columns.date === undefined || columns.ticker === undefined || columns.shares === undefined || columns.price === undefined) {
    return [];
  }

  const candidates: ParsedTradeCandidate[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter).map((c) => c.trim());
    const date = parseCsvDate(cells[columns.date]);
    const ticker = cells[columns.ticker];
    const shares = parseCsvNumber(cells[columns.shares]);
    const price = parseCsvNumber(cells[columns.price]);
    if (!date || !ticker || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) continue;

    const sideRaw = columns.side !== undefined ? cells[columns.side] : "";
    const side: "BUY" | "SELL" = /sell/i.test(sideRaw) ? "SELL" : "BUY";
    const fees = columns.fees !== undefined ? parseCsvNumber(cells[columns.fees]) : undefined;
    const taxes = columns.taxes !== undefined ? parseCsvNumber(cells[columns.taxes]) : undefined;

    candidates.push({
      ticker: normalizeTicker(ticker),
      side,
      shares,
      price,
      date,
      fees: Number.isFinite(fees) ? fees : undefined,
      taxes: Number.isFinite(taxes) ? taxes : undefined,
      // A structured column match (not a fuzzy company-name guess) is the
      // most reliable ticker resolution the OCR subsystem can produce.
      confidence: "high",
      source: "csv",
    });
  }
  return candidates;
}

const EMPTY_ORDERS_RESULT: OrdersScreenParseResult = {
  candidates: [],
  incompleteRowCount: 0,
  fulfilledStatusCount: 0,
  statusCountMismatch: false,
};

const EMPTY_ROWS_RESULT: OrderRowsParseResult = {
  candidates: [],
  incompleteRowCount: 0,
  fulfilledStatusCount: 0,
  statusCountMismatch: false,
  resolvedRowCount: 0,
};

export class CsvStatementParser implements BrokerParser {
  readonly id = "csv-generic";
  private readonly trackedSince: string;

  constructor(trackedSince: string = defaultTrackedSince()) {
    this.trackedSince = trackedSince;
  }

  isWithinTrackedRange(dateIso: string): boolean {
    return isWithinTrackedRange(dateIso, this.trackedSince);
  }

  looksLikeOwnDocument(text: string): boolean {
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!firstLine) return false;
    const columns = mapColumns(firstLine.split(detectDelimiter(firstLine)));
    return columns.date !== undefined && columns.ticker !== undefined && columns.shares !== undefined && columns.price !== undefined;
  }

  // A CSV transaction export is always a trade log, never a single-ticker
  // "My position" ground-truth screen — that concept doesn't exist in this format.
  looksLikePositionVerification(): boolean {
    return false;
  }

  parseStatementText(text: string): ParsedTradeCandidate[] {
    const { inRange } = partitionByRange(parseRows(text), (d) => this.isWithinTrackedRange(d));
    return inRange;
  }

  parseOrdersScreenText(): OrdersScreenParseResult {
    return EMPTY_ORDERS_RESULT;
  }

  // An orders timeline is an app-screen screenshot format — never a CSV export.
  looksLikeOrdersTimeline(): boolean {
    return false;
  }

  parseOrdersTimeline(): OrdersTimelineParseResult {
    return { evidences: [], unreadRowCount: 0 };
  }

  parsePositionVerification(): Omit<PositionVerification, "id" | "portfolioId">[] {
    return [];
  }

  // A CSV transaction export has no "governing image" dividend history section.
  parseDividends(): ParsedDividendCandidate[] {
    return [];
  }

  resolveHeaderTicker(): string | null {
    return null;
  }

  parseOrderRowsText(_rows: OrderRowText[]): OrderRowsParseResult {
    return EMPTY_ROWS_RESULT;
  }
}

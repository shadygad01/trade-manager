import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/** One order row's OCR text plus the status already read from its slice's pixel colors (see imagePreprocess.ts segmentOrderRows). */
export interface OrderRowText {
  text: string;
  colorStatus: "fulfilled" | "cancelled" | null;
}

export interface OrderRowsParseResult {
  candidates: ParsedTradeCandidate[];
  incompleteRowCount: number;
  fulfilledStatusCount: number;
  statusCountMismatch: boolean;
  resolvedRowCount: number;
  /** Candidates found but excluded for falling outside the parser's tracked date range (see isWithinTrackedRange). */
  outOfRangeCount?: number;
}

export interface OrdersScreenParseResult {
  candidates: ParsedTradeCandidate[];
  incompleteRowCount: number;
  fulfilledStatusCount: number;
  statusCountMismatch: boolean;
  outOfRangeCount?: number;
}

/**
 * Extension point for the OCR subsystem: one implementation per broker.
 * ImportOrchestrator holds a `BrokerParser[]` registry — adding a second
 * broker is purely additive (register another implementation), no changes
 * to the orchestration pipeline itself.
 */
export interface BrokerParser {
  /** Stable identifier, e.g. "thndr". */
  id: string;

  /** True when the extracted text looks like a document this broker parser understands at all (used for OCR fallback + routing decisions). */
  looksLikeOwnDocument(text: string): boolean;

  /** True when the extracted text looks like a "My position" ground-truth verification screen for this broker (checked before the trade parsers so it's never mistaken for one). */
  looksLikePositionVerification(text: string): boolean;

  /** Parses a "Customer Account Statement" style document (PDF or screenshot) into trade candidates. */
  parseStatementText(text: string): ParsedTradeCandidate[];

  /** Parses a per-stock "Orders" screen screenshot (flat, non-row-isolated) into trade candidates plus row-completeness warning signals. */
  parseOrdersScreenText(text: string): OrdersScreenParseResult;

  /** Parses a "My position" ground-truth verification screen. Empty array when the ticker/units couldn't be read. */
  parsePositionVerification(text: string): Omit<PositionVerification, "id" | "portfolioId">[];

  /** Resolves the ticker shown in an Orders/position screen's header, used to route the row-isolated re-scan fallback. */
  resolveHeaderTicker(text: string): string | null;

  /** Row-isolated counterpart to parseOrdersScreenText: each entry is exactly one order row's OCR text, so cross-row status mispairing is structurally impossible. */
  parseOrderRowsText(rows: OrderRowText[], ticker: string): OrderRowsParseResult;

  /** True when a candidate's date falls within this broker parser's tracked date range (excludes stale and future-misread dates). */
  isWithinTrackedRange(dateIso: string): boolean;
}

import type { ParsedDividendCandidate, ParsedOrderEvidence, ParsedTradeCandidate } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { extractPdfText } from "./pdfText";
import { loadImageToCanvas, cropHeaderBand, preprocessForOcr, segmentOrderRows } from "./imagePreprocess";
import { recognizeWithFallback, recognizeBatch } from "./tesseractClient";
import type { BrokerParser, OrderRowText } from "./parsers/BrokerParser";
import { flatResultIsDeficient, missingFulfilledCount, shouldPreferRowScan } from "./ordersScanSelection";
import { ThndrParser } from "./parsers/ThndrParser";
import { CsvStatementParser } from "./parsers/CsvStatementParser";
import { normalizeExtractedText } from "./textNormalize";

export type ImportDocType = "statement" | "orders-screen" | "orders-timeline" | "position-verification";

export interface ImportResult {
  status: "parsed" | "failed";
  docType?: ImportDocType;
  candidates: ParsedTradeCandidate[];
  verifications: Omit<PositionVerification, "id" | "portfolioId">[];
  /** Dividend payouts read from a "My Position" screen's dividend-history section, if present. */
  dividends: ParsedDividendCandidate[];
  /** Per-order corroborating evidence read from an account-wide "Orders" timeline screen — undated, so never trade candidates (see ParsedOrderEvidence). */
  orderEvidences: ParsedOrderEvidence[];
  rawText: string;
  warnings: string[];
  /** SHA-256 hex digest of the file's bytes — callers persisting an Upload entity use this for its fileHash field / per-file dedup. */
  fileHash: string;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const MIN_TEXT_LENGTH = 20;

/**
 * Full client-side import pipeline: hash the file, extract text (PDF text
 * layer or OCR for images), route it through the registered broker parsers,
 * and surface any data-quality warnings the parse uncovered. Framework
 * agnostic — no React/DOM event handling; the presentation layer drives this
 * from a file input or drop zone and renders the returned ImportResult.
 */
export class ImportOrchestrator {
  constructor(private readonly parsers: BrokerParser[] = [new ThndrParser(), new CsvStatementParser()]) {}

  async importFile(file: File): Promise<ImportResult> {
    const buffer = await file.arrayBuffer();
    const fileHash = await sha256Hex(buffer);

    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf";
    let rawText = "";
    let sourceCanvas: HTMLCanvasElement | null = null;

    if (isImage) {
      sourceCanvas = await loadImageToCanvas(file);
      // Two passes: the header (ticker code + company name, next to the
      // back/bell/heart icons) is silently dropped by full-page OCR —
      // isolating it recovers it. The body gets the white-background
      // threshold since pastel status labels are otherwise invisible to
      // Tesseract's default binarization. See imagePreprocess.ts.
      const headerBand = cropHeaderBand(sourceCanvas);
      const body = preprocessForOcr(sourceCanvas);
      const isRecognizedDocument = (text: string) =>
        this.parsers.some(
          (p) => p.looksLikeOwnDocument(text) || p.looksLikePositionVerification(text) || p.looksLikeOrdersTimeline(text),
        );
      const { text } = await recognizeWithFallback(headerBand, body, isRecognizedDocument);
      rawText = text;
    } else if (isPdf) {
      rawText = await extractPdfText(buffer);
    } else {
      // CSV/plain-text broker exports carry no images to OCR and no PDF text
      // layer to extract — the file's bytes already are the text.
      rawText = new TextDecoder("utf-8").decode(buffer);
    }

    // Normalize once, before ANY parser: Eastern Arabic digits, Arabic
    // decimal/thousands separators, hidden bidi/zero-width chars, and exotic
    // Unicode spaces all silently break regexes written for clean text.
    rawText = normalizeExtractedText(rawText);

    if (!rawText || rawText.trim().length < MIN_TEXT_LENGTH) {
      return {
        status: "failed",
        candidates: [],
        verifications: [],
        dividends: [],
        orderEvidences: [],
        rawText,
        warnings: ["No text could be read from the file — try another file."],
        fileHash,
      };
    }

    // Prefer whichever registered parser claims ownership of this document
    // (avoids one broker's regexes accidentally matching another broker's
    // screenshot); fall back to trying every registered parser when none
    // claims it, so an unrecognized-but-plausible document still gets a shot.
    const owner =
      this.parsers.find((p) => p.looksLikeOwnDocument(rawText)) ??
      this.parsers.find((p) => p.looksLikePositionVerification(rawText));
    const candidateParsers = owner ? [owner] : this.parsers;

    // 1. "My position" ground-truth verification screens are routed first
    // and exclusively — they have no buy/sell rows, and must never be
    // mistaken for a near-empty statement/orders upload.
    for (const parser of candidateParsers) {
      if (parser.looksLikePositionVerification(rawText)) {
        const verifications = parser.parsePositionVerification(rawText);
        if (verifications.length === 0) {
          return {
            status: "failed",
            docType: "position-verification",
            candidates: [],
            verifications: [],
            dividends: [],
            orderEvidences: [],
            rawText,
            warnings: ["Recognized a position screen but couldn't read the ticker/units — try a clearer screenshot."],
            fileHash,
          };
        }
        return {
          status: "parsed",
          docType: "position-verification",
          candidates: [],
          verifications,
          dividends: parser.parseDividends(rawText),
          orderEvidences: [],
          rawText,
          warnings: [],
          fileHash,
        };
      }
    }

    // 2. Account-wide "Orders" timeline screens: undated per-order rows
    // (real ticker code + side/type/price + total + Fulfilled/Cancelled) that
    // corroborate transactions extracted from dated documents rather than
    // becoming trade candidates themselves. Routed before the statement/
    // orders-screen parsers because its rows carry none of the fields those
    // need (no date, no "N shares"), so they'd otherwise fall through to a
    // generic "no transactions found" failure.
    for (const parser of candidateParsers) {
      if (!parser.looksLikeOrdersTimeline(rawText)) continue;
      const { evidences, unreadRowCount } = parser.parseOrdersTimeline(rawText);
      if (evidences.length === 0) {
        return {
          status: "failed",
          docType: "orders-timeline",
          candidates: [],
          verifications: [],
          dividends: [],
          orderEvidences: [],
          rawText,
          warnings: ["Recognized an Orders history screen but couldn't read any order rows — try a clearer or larger screenshot."],
          fileHash,
        };
      }
      const warnings: string[] = [];
      if (unreadRowCount > 0) {
        warnings.push(
          `${unreadRowCount} order row(s) on the Orders screen couldn't be fully read (missing ticker/total/status) — try re-uploading a clearer or larger screenshot if an order seems to be missing.`,
        );
      }
      return {
        status: "parsed",
        docType: "orders-timeline",
        candidates: [],
        verifications: [],
        dividends: [],
        orderEvidences: evidences,
        rawText,
        warnings,
        fileHash,
      };
    }

    // 3. Statement rows (dated, per-row "Buy/Sell <company> (qty@price)").
    for (const parser of candidateParsers) {
      const candidates = parser.parseStatementText(rawText);
      if (candidates.length > 0) {
        return { status: "parsed", docType: "statement", candidates, verifications: [], dividends: [], orderEvidences: [], rawText, warnings: [], fileHash };
      }
    }

    // 4. Orders-screen screenshots: flat parse first, then — whenever the
    // flat parse found nothing OR its own signals say it lost/mispaired a
    // row, and this is an image — the row-isolated re-scan, which eliminates
    // cross-row action/status mispairing by construction (each image slice
    // can only ever contain one row). Re-scanning on a merely *partial* flat
    // result matters just as much as on an empty one: a clear screenshot
    // that flat-parsed 4-of-5 used to ship with a "may be missing" warning
    // without ever trying the more reliable path.
    for (const parser of candidateParsers) {
      const flatResult = parser.parseOrdersScreenText(rawText);
      let chosen: typeof flatResult = flatResult;
      let usedRowScan = false;
      let rowScanLog = "";

      if (flatResultIsDeficient(flatResult) && isImage && sourceCanvas) {
        const headerTicker = parser.resolveHeaderTicker(rawText);
        if (headerTicker) {
          const slices = segmentOrderRows(sourceCanvas);
          if (slices.length > 0) {
            const rowTexts = await recognizeBatch(
              slices.map((s) => s.canvas),
              ["eng"],
            );
            const rows: OrderRowText[] = slices.map((s, i) => ({
              text: normalizeExtractedText(rowTexts[i]),
              colorStatus: s.colorStatus,
            }));
            const rowResult = parser.parseOrderRowsText(rows, headerTicker);
            // Adoption is guarded so switching can never lose a trade the
            // flat parse already extracted (see ordersScanSelection.ts) —
            // including the legitimate all-cancelled case where zero
            // candidates from a resolved row scan is the correct answer.
            if (shouldPreferRowScan(flatResult, rowResult)) {
              chosen = rowResult;
              usedRowScan = true;
            }
            // Kept so a wrong outcome can be diagnosed from what each
            // isolated row actually OCR'd as, whether or not it was trusted.
            rowScanLog =
              `\n\n--- row-isolated scan (${slices.length} slice(s), used: ${usedRowScan}) ---\n` +
              rows
                .map((r, idx) => `[row ${idx + 1} | color: ${r.colorStatus ?? "none"}] ${r.text.replace(/\s+/g, " ").trim()}`)
                .join("\n");
          }
        }
      }

      const { candidates, incompleteRowCount, fulfilledStatusCount, statusCountMismatch } = chosen;
      const outOfRangeCount = chosen.outOfRangeCount ?? 0;

      if (candidates.length > 0 || usedRowScan) {
        const warnings: string[] = [];
        // Broader cross-check than incompleteRowCount alone: compares what
        // the screenshot visually shows as fulfilled against what actually
        // made it into the result, regardless of the specific cause.
        const missingCount = missingFulfilledCount(chosen);
        if (missingCount > 0) {
          warnings.push(
            `Screenshot shows ${fulfilledStatusCount} "Fulfilled" order(s) but only ${candidates.length} were extracted — ${missingCount} may be missing. Try re-uploading a clearer or larger screenshot.`,
          );
        } else if (incompleteRowCount > 0) {
          warnings.push(
            `${incompleteRowCount} order row(s) were detected but couldn't be fully read (missing price/date/status) — try re-uploading a clearer or larger screenshot if a trade seems to be missing.`,
          );
        }
        if (statusCountMismatch) {
          warnings.push(
            "Order row count and status-label count don't match — a Cancelled/Rejected/Pending order may have been mispaired with the wrong status.",
          );
        }
        if (outOfRangeCount > 0) {
          warnings.push(`${outOfRangeCount} transaction(s) were outside the tracked date range (too old, or future-dated — a likely misread) and were excluded.`);
        }
        return {
          status: "parsed",
          docType: "orders-screen",
          candidates,
          verifications: [],
          dividends: [],
          orderEvidences: [],
          rawText: rawText + rowScanLog,
          warnings,
          fileHash,
        };
      }
    }

    // A document can be a real, recognized broker document with zero
    // trades in scope (e.g. a statement covering a period with only
    // deposits/transfers) — different from a file that isn't a recognized
    // document at all, so the message differs.
    const looksLikeAnyKnownDocument = candidateParsers.some((p) => p.looksLikeOwnDocument(rawText));
    return {
      status: "failed",
      candidates: [],
      verifications: [],
      dividends: [],
      orderEvidences: [],
      rawText,
      warnings: [
        looksLikeAnyKnownDocument
          ? "This looks like a recognized broker document, but it has no buy/sell trades in this period."
          : "No transactions found in the file. Make sure it's a supported broker report.",
      ],
      fileHash,
    };
  }
}

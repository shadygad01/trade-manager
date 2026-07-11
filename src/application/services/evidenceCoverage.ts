import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload, OrderEvidenceCapturePayload, PositionVerificationCapturePayload } from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { isRetracted } from "./rawTransactionFolds";

/**
 * Evidence Coverage Engine: what does each uploaded document actually prove
 * ground for, independent of whether it happens to name any specific
 * missing transaction. A Statement covering April doesn't need to mention
 * SKPC at all to tell you "SKPC had no activity in April, if it's not on
 * this Statement's coverage window and Statement rows are otherwise dense" —
 * coverage is a claim about a WINDOW, not a list of hits. This is what lets
 * the Minimal Document Engine (completenessEngine.recoveryPlan) stop
 * recommending a document type that already covered the gap window and
 * simply didn't contain the missing row — the "known simplification" its
 * own doc comment has named since the closed-position fix.
 *
 * Derived entirely from already-extracted RawTransaction facts (grouped by
 * `sourceUploadId`), never from re-reading the original document — no new
 * parsing, no change to any BrokerParser. A Statement/Transactions upload's
 * coverage window is approximated as [min, max] of the execution dates it
 * actually contains, a conservative under-estimate (the real document may
 * also cover a date with zero activity that this can't see) rather than a
 * fabricated precise one — the Statement's own literal "From X To Y" header
 * text is not captured by ThndrParser today; extracting it would mean
 * reworking already-battle-tested parsing code for a case this
 * approximation already resolves correctly whenever the gap date falls
 * strictly between two real rows.
 */

export type CoverageClaim =
  | { kind: "date-range"; sourceUploadId: string; documentType: "statement" | "transactions"; from: string; to: string }
  | { kind: "ticker-history"; sourceUploadId: string; documentType: "orders"; ticker: string; from?: string; to?: string }
  | { kind: "exact-execution"; sourceUploadId: string; documentType: "invoice"; ticker: string; date: string }
  | { kind: "current-holdings"; sourceUploadId: string; documentType: "my-position"; ticker: string; capturedAt: string };

function tickerAndDateOf(txn: RawTransaction): { ticker?: string; date?: string } {
  switch (txn.kind) {
    case "BuyExecution":
    case "SellExecution": {
      const p = txn.payload as BuyExecutionPayload | SellExecutionPayload;
      return { ticker: p.ticker, date: p.executionDate };
    }
    case "OrderEvidenceCapture": {
      const p = txn.payload as OrderEvidenceCapturePayload;
      return { ticker: p.ticker, date: p.date };
    }
    case "PositionVerificationCapture": {
      const p = txn.payload as PositionVerificationCapturePayload;
      return { ticker: p.ticker, date: p.capturedAt };
    }
    default:
      return {};
  }
}

/**
 * CoverageClaim(s) per Upload referenced by `transactions` (grouped by
 * `sourceUploadId`, retracted facts excluded — a fully-retracted upload
 * proves nothing). A single upload almost always produces exactly ONE
 * claim: its document type is fixed at extraction time (see
 * RawTransactionSource), so an Invoice upload is always exact-execution, a
 * Statement upload is always date-range, etc. The one exception is
 * "official-broker-excel" — a single native export spans every ticker the
 * account ever traded, so it produces one ticker-history claim PER TICKER
 * actually present, not one claim for the whole upload.
 */
export function buildCoverageClaims(transactions: RawTransaction[]): CoverageClaim[] {
  const live = transactions.filter((t) => !isRetracted(transactions, t.id) && t.sourceUploadId !== undefined);
  const byUpload = new Map<string, RawTransaction[]>();
  for (const t of live) {
    const bucket = byUpload.get(t.sourceUploadId!) ?? [];
    bucket.push(t);
    byUpload.set(t.sourceUploadId!, bucket);
  }

  const claims: CoverageClaim[] = [];
  for (const [uploadId, rows] of byUpload) {
    const source = rows[0].source;
    const dated = rows.map((r) => tickerAndDateOf(r)).filter((d): d is { ticker: string; date: string } => d.date !== undefined);

    if (source === "invoice") {
      const first = dated[0];
      if (first) claims.push({ kind: "exact-execution", sourceUploadId: uploadId, documentType: "invoice", ticker: normalizeTicker(first.ticker), date: first.date });
      continue;
    }
    if (source === "position-verification") {
      const first = dated[0];
      if (first) claims.push({ kind: "current-holdings", sourceUploadId: uploadId, documentType: "my-position", ticker: normalizeTicker(first.ticker), capturedAt: first.date });
      continue;
    }
    if (source === "orders-screen") {
      const ticker = normalizeTicker(rows[0].ticker ?? dated[0]?.ticker ?? "");
      const dates = dated.map((d) => d.date).sort();
      claims.push({ kind: "ticker-history", sourceUploadId: uploadId, documentType: "orders", ticker, from: dates[0], to: dates[dates.length - 1] });
      continue;
    }
    if (source === "official-broker-excel") {
      // Unlike a per-ticker "Orders" screenshot, one native Excel export
      // spans every ticker the account ever traded — one ticker-history
      // claim per ticker actually present, not a single claim for the whole
      // upload.
      const byTicker = new Map<string, string[]>();
      for (const d of dated) {
        const ticker = normalizeTicker(d.ticker);
        const list = byTicker.get(ticker) ?? [];
        list.push(d.date);
        byTicker.set(ticker, list);
      }
      for (const [ticker, dates] of byTicker) {
        dates.sort();
        claims.push({ kind: "ticker-history", sourceUploadId: uploadId, documentType: "orders", ticker, from: dates[0], to: dates[dates.length - 1] });
      }
      continue;
    }
    if (source === "orders-timeline") {
      // The account-wide "Orders" timeline (undated) and the dated
      // "Transactions" list share this same source — only the dated shape
      // makes a real date-range claim; the undated shape corroborates
      // specific rows but proves no window on its own.
      if (dated.length === 0) continue;
      const dates = dated.map((d) => d.date).sort();
      claims.push({ kind: "date-range", sourceUploadId: uploadId, documentType: "transactions", from: dates[0], to: dates[dates.length - 1] });
      continue;
    }
    if (source === "statement" || source === "csv") {
      if (dated.length === 0) continue;
      const dates = dated.map((d) => d.date).sort();
      claims.push({ kind: "date-range", sourceUploadId: uploadId, documentType: "statement", from: dates[0], to: dates[dates.length - 1] });
    }
  }
  return claims;
}

/** True when `date` falls within any already-uploaded Statement/Transactions coverage window for this exact date — used to stop the Minimal Document Engine re-recommending a document TYPE that already covered the gap and simply didn't contain the missing row. */
export function isDateAlreadyCovered(date: string, claims: CoverageClaim[]): boolean {
  return claims.some((c) => (c.kind === "date-range") && date >= c.from && date <= c.to);
}

/** True when `ticker` already has an Orders-history upload on file, regardless of whether it covers the specific gap date — the real, disclosed simplification this module cannot yet fully close: it can tell you Orders History was uploaded for this ticker, not whether that specific upload's own window included the missing date. */
export function hasOrdersHistoryFor(ticker: string, claims: CoverageClaim[]): boolean {
  const normalized = normalizeTicker(ticker);
  return claims.some((c) => c.kind === "ticker-history" && c.ticker === normalized);
}

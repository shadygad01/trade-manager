import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { canonicalizeTradeEntries, type CanonicalTrade } from "./ledgerRebuild";

/**
 * Ledger Engine: the Buy/Sell economic record ("the ledger," exactly the
 * scope ledgerRebuild.ts's own doc comment already uses that term for),
 * generated fresh from verified raw transactions every time it's called —
 * never edited, never patched, never a target of a write. Reuses
 * canonicalizeTradeEntries (ledgerRebuild.ts's dedup/aggregation core)
 * verbatim; this module only adapts RawTransaction into that function's
 * input shape and maps its output into typed events.
 */

interface LedgerEventBase {
  /** Deterministic identity for "one real execution" — ledgerRebuild.ts's canonicalKey, so regenerating from an unchanged input set always reproduces the same id. */
  eventId: string;
  executionDate: string;
  executionTime?: string;
  ticker: string;
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  transactionNumber?: string;
  /** Every RawTransaction that corroborates this same real execution, not just whichever row survived as the canonical read. */
  sourceTransactionIds: string[];
}

export interface LotOpenedEvent extends LedgerEventBase {
  type: "LotOpened";
  companyName?: string;
}

export interface SellRecordedEvent extends LedgerEventBase {
  type: "SellRecorded";
}

export type LedgerEvent = LotOpenedEvent | SellRecordedEvent;

function toCandidateSource(source: RawTransaction["source"]): ParsedTradeCandidate["source"] {
  if (source === "statement" || source === "invoice" || source === "orders-screen" || source === "csv") return source;
  return undefined;
}

function toCanonicalizationEntries(transactions: RawTransaction[]): { key: string; candidate: ParsedTradeCandidate; uploadId: string }[] {
  const entries: { key: string; candidate: ParsedTradeCandidate; uploadId: string }[] = [];
  for (const txn of transactions) {
    if (txn.kind !== "BuyExecution" && txn.kind !== "SellExecution") continue;
    const payload = txn.payload as BuyExecutionPayload | SellExecutionPayload;
    entries.push({
      key: txn.id,
      // The raw transaction IS its own backing fact at this layer — there's
      // no separate Upload concept once Import writes straight to
      // RawTransaction, so its own id fills the role sourceUploadIds plays
      // for buildCanonicalTrades' own Upload-sourced callers.
      uploadId: txn.id,
      candidate: {
        ticker: payload.ticker,
        companyName: "companyName" in payload ? payload.companyName : undefined,
        side: txn.kind === "BuyExecution" ? "BUY" : "SELL",
        shares: payload.shares,
        price: payload.price,
        fees: payload.fees,
        taxes: payload.taxes,
        date: payload.executionDate,
        time: payload.executionTime,
        source: toCandidateSource(txn.source),
        transactionNumber: payload.transactionNumber,
      },
    });
  }
  return entries;
}

function toEvent(c: CanonicalTrade): LedgerEvent {
  const base: LedgerEventBase = {
    eventId: c.key,
    executionDate: c.executionDate,
    executionTime: c.executionTime,
    ticker: c.ticker,
    shares: c.shares,
    price: c.price,
    fees: c.fees,
    taxes: c.taxes,
    transactionNumber: c.transactionNumber,
    sourceTransactionIds: c.sourceUploadIds,
  };
  return c.side === "BUY" ? { type: "LotOpened", ...base, companyName: c.companyName } : { type: "SellRecorded", ...base };
}

/** "Oldest -> newest" by real execution time, not ingestion order — a late-arriving old document should land in its correct chronological position on a full regeneration, not be appended at the end. `eventId` (deterministic, per canonicalKey) breaks ties between events sharing an identical timestamp, which is routine given OCR's "00:00" unknown-time placeholder. */
function chronoKey(e: LedgerEvent): string {
  return `${e.executionDate}T${e.executionTime ?? "00:00"}`;
}

export function generateLedgerEvents(verifiedTransactions: RawTransaction[]): LedgerEvent[] {
  const entries = toCanonicalizationEntries(verifiedTransactions);
  const { buys, sells } = canonicalizeTradeEntries(entries);
  const events = [...buys.map(toEvent), ...sells.map(toEvent)];
  return events.sort((a, b) => {
    const byTime = chronoKey(a).localeCompare(chronoKey(b));
    return byTime !== 0 ? byTime : a.eventId.localeCompare(b.eventId);
  });
}

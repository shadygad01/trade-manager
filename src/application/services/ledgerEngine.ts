import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import type { LedgerEvent, LotOpenedEvent } from "@domain/entities/LedgerEvent";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { canonicalizeTradeEntries, type CanonicalTrade } from "./ledgerRebuild";

export type { LedgerEvent, LotOpenedEvent, SellRecordedEvent } from "@domain/entities/LedgerEvent";

/**
 * Ledger Engine: the Buy/Sell economic record ("the ledger," exactly the
 * scope ledgerRebuild.ts's own doc comment already uses that term for),
 * generated fresh from verified raw transactions every time it's called —
 * never edited, never patched, never a target of a write. Reuses
 * canonicalizeTradeEntries (ledgerRebuild.ts's dedup/aggregation core)
 * verbatim; this module only adapts RawTransaction into that function's
 * input shape and maps its output into typed events (see
 * @domain/entities/LedgerEvent for the event shapes themselves).
 *
 * "manual" and "backfill" sourced facts skip canonicalizeTradeEntries'
 * dedup/corroboration pass entirely and go straight to their own event,
 * keyed by the RawTransaction's own real (always-unique) id. That pass
 * exists to tell "the same real execution read from two different
 * documents" (legitimate corroboration — merge them) apart from "two
 * coincidentally-identical real executions" (never merge), using price/time
 * closeness as its only signal — a heuristic that's appropriate for OCR
 * candidates but meaningless for a manual entry or a 1:1 historical-Trade
 * conversion: neither is ever a second "read" of another row, so there is
 * no corroboration question to answer, and running the heuristic anyway
 * risks silently merging two genuinely different manual/backfilled trades
 * that happen to share ticker/date/shares/price (an ordinary occurrence —
 * two same-price orders the same day). See crossTransactionIsolation.test.ts.
 */

function toCandidateSource(source: RawTransaction["source"]): ParsedTradeCandidate["source"] {
  if (source === "statement" || source === "invoice" || source === "official-broker-excel" || source === "orders-screen" || source === "csv") return source;
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
  const base: Omit<LotOpenedEvent, "type" | "companyName"> = {
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

/** Direct 1:1 mapping for a manual/backfill fact — see this module's doc comment. */
function toDirectEvent(txn: RawTransaction): LedgerEvent {
  const payload = txn.payload as BuyExecutionPayload | SellExecutionPayload;
  const base: Omit<LotOpenedEvent, "type" | "companyName"> = {
    eventId: txn.id,
    executionDate: payload.executionDate,
    executionTime: payload.executionTime,
    ticker: normalizeTicker(payload.ticker),
    shares: payload.shares,
    price: payload.price,
    fees: payload.fees,
    taxes: payload.taxes,
    transactionNumber: payload.transactionNumber,
    sourceTransactionIds: [txn.id],
  };
  return txn.kind === "BuyExecution"
    ? { type: "LotOpened", ...base, companyName: (payload as BuyExecutionPayload).companyName }
    : { type: "SellRecorded", ...base };
}

/** "Oldest -> newest" by real execution time, not ingestion order — a late-arriving old document should land in its correct chronological position on a full regeneration, not be appended at the end. `eventId` (deterministic, per canonicalKey) breaks ties between events sharing an identical timestamp, which is routine given OCR's "00:00" unknown-time placeholder. */
function chronoKey(e: LedgerEvent): string {
  return `${e.executionDate}T${e.executionTime ?? "00:00"}`;
}

export function generateLedgerEvents(verifiedTransactions: RawTransaction[]): LedgerEvent[] {
  const direct = verifiedTransactions.filter((t) => t.source === "manual" || t.source === "backfill");
  const dedupCandidates = verifiedTransactions.filter((t) => t.source !== "manual" && t.source !== "backfill");

  const entries = toCanonicalizationEntries(dedupCandidates);
  const { buys, sells } = canonicalizeTradeEntries(entries);
  const directEvents = direct.filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution").map(toDirectEvent);

  const events = [...buys.map(toEvent), ...sells.map(toEvent), ...directEvents];
  return events.sort((a, b) => {
    const byTime = chronoKey(a).localeCompare(chronoKey(b));
    return byTime !== 0 ? byTime : a.eventId.localeCompare(b.eventId);
  });
}

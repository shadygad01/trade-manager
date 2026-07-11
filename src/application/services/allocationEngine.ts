import type { RawTransaction, SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import type { Allocation } from "@domain/entities/Allocation";
import type { LedgerEvent, SellRecordedEvent } from "./ledgerEngine";

export type { Allocation } from "@domain/entities/Allocation";

/**
 * Allocation Engine: replays explicit SellAllocationDecision facts against
 * the Ledger's LotOpened/SellRecorded events, in the chronological order
 * their referenced sells actually executed. This is the ONLY place lot
 * selection happens, and it is never inferred (no FIFO, no average cost) —
 * every allocation here traces back to a raw, explicit user decision. Reads
 * only Ledger events + decision facts; never touches a raw BuyExecution/
 * SellExecution directly, never touches Holdings, price data, or anything
 * downstream of itself. See @domain/entities/Allocation for the output shape.
 */

function allocationId(sellEventId: string, lotEventId: string): string {
  return `${sellEventId}|${lotEventId}`;
}

/**
 * Indexes events for lookup by every id a decision might legitimately use to
 * reference them: the event's own `eventId` (a decision written against the
 * value-keyed identity, including old data predating per-transaction
 * identity), and every id in `sourceTransactionIds` (a decision written
 * against the real, always-unique RawTransaction id — see
 * TradeService.ensureSellFacts/ledgerProjection.resolveLotRef). Both schemes
 * must resolve so a decision recorded under either convention keeps
 * replaying correctly forever, even across a rebuild that changes which
 * scheme new writes use.
 */
function indexEventsByReference<E extends LedgerEvent>(events: E[]): Map<string, E> {
  const byRef = new Map<string, E>();
  for (const e of events) {
    byRef.set(e.eventId, e);
    for (const sourceId of e.sourceTransactionIds) {
      if (!byRef.has(sourceId)) byRef.set(sourceId, e);
    }
  }
  return byRef;
}

export function generateAllocations(ledgerEvents: LedgerEvent[], verifiedDecisionTransactions: RawTransaction[]): Allocation[] {
  const lots = indexEventsByReference(ledgerEvents.filter((e) => e.type === "LotOpened"));
  const sells = indexEventsByReference(ledgerEvents.filter((e): e is SellRecordedEvent => e.type === "SellRecorded"));

  const decisions = verifiedDecisionTransactions
    .filter((t) => t.kind === "SellAllocationDecision")
    .map((t) => ({ txn: t, payload: t.payload as SellAllocationDecisionPayload }))
    // A decision whose sell was retracted/never verified has nothing to allocate against — excluded, not crashed.
    .filter((d) => sells.has(d.payload.sellExecutionId))
    // Chronological by the sell's real execution time, matching the Ledger's
    // own ordering rule (turn 6 §4) — a decision can only close a lot that
    // was already open at the time its sell actually executed. `seq`
    // (ingestion order) breaks ties between sells sharing an identical
    // timestamp, the same routine case the Ledger already handles.
    .sort((a, b) => {
      const sellA = sells.get(a.payload.sellExecutionId)!;
      const sellB = sells.get(b.payload.sellExecutionId)!;
      const timeA = `${sellA.executionDate}T${sellA.executionTime ?? "00:00"}`;
      const timeB = `${sellB.executionDate}T${sellB.executionTime ?? "00:00"}`;
      const byTime = timeA.localeCompare(timeB);
      return byTime !== 0 ? byTime : a.txn.seq - b.txn.seq;
    });

  const remainingByLot = new Map(ledgerEvents.filter((e) => e.type === "LotOpened").map((e) => [e.eventId, e.shares]));
  const allocations: Allocation[] = [];

  for (const decision of decisions) {
    const sell = sells.get(decision.payload.sellExecutionId)!;
    for (const { lotRef, shares } of decision.payload.allocations) {
      const lot = lots.get(lotRef);
      // Always key off the lot's own canonical eventId, never the decision's
      // raw `lotRef` string — two different decisions may reference the same
      // lot via two different aliases (its eventId vs. one of its
      // sourceTransactionIds), and both must draw down the SAME balance.
      const remaining = lot ? remainingByLot.get(lot.eventId) : undefined;
      // The decision's referenced lot may no longer exist, or no longer
      // have enough balance, if a Correction changed the underlying
      // execution's identity since the decision was recorded (see the
      // canonical-model spec's discussion of this exact case). Excluded
      // from this replay, not silently reinterpreted or crashed — surfaced
      // to a review queue by whichever caller notices the decision produced
      // no matching allocation, exactly like an unresolved Verification
      // "Needs Review" case.
      if (!lot || remaining === undefined || shares > remaining) continue;

      remainingByLot.set(lot.eventId, remaining - shares);
      const proration = shares / sell.shares;
      allocations.push({
        id: allocationId(sell.eventId, lot.eventId),
        sellEventId: sell.eventId,
        lotEventId: lot.eventId,
        shares,
        price: sell.price,
        fees: (sell.fees ?? 0) * proration,
        taxes: (sell.taxes ?? 0) * proration,
        executionDate: sell.executionDate,
        executionTime: sell.executionTime,
        transactionNumber: sell.transactionNumber,
      });
    }
  }

  return allocations;
}

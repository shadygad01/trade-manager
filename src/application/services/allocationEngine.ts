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

export function generateAllocations(ledgerEvents: LedgerEvent[], verifiedDecisionTransactions: RawTransaction[]): Allocation[] {
  const lots = new Map(ledgerEvents.filter((e) => e.type === "LotOpened").map((e) => [e.eventId, e]));
  const sells = new Map<string, SellRecordedEvent>(
    ledgerEvents.filter((e): e is SellRecordedEvent => e.type === "SellRecorded").map((e) => [e.eventId, e])
  );

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
      const remaining = remainingByLot.get(lotRef);
      // The decision's referenced lot may no longer exist, or no longer
      // have enough balance, if a Correction changed the underlying
      // execution's identity since the decision was recorded (see the
      // canonical-model spec's discussion of this exact case). Excluded
      // from this replay, not silently reinterpreted or crashed — surfaced
      // to a review queue by whichever caller notices the decision produced
      // no matching allocation, exactly like an unresolved Verification
      // "Needs Review" case.
      if (!lot || remaining === undefined || shares > remaining) continue;

      remainingByLot.set(lotRef, remaining - shares);
      const proration = shares / sell.shares;
      allocations.push({
        id: allocationId(sell.eventId, lotRef),
        sellEventId: sell.eventId,
        lotEventId: lotRef,
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

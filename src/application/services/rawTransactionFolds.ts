import type { RawTransaction, RetractionPayload } from "@domain/entities/RawTransaction";

/**
 * Shared supersede/retract folds over the append-only RawTransaction log (see
 * RawTransaction.ts's own doc comment: "Readers resolve 'the current view of
 * fact X' by folding a row's supersede/retract chain, not by mutating it.").
 * A leaf module so commitEngine.ts and verificationEngine.ts can both depend
 * on it without depending on each other — extracted out of commitEngine.ts
 * (isRetracted originated there, private) rather than duplicated.
 */

/** Whether any Retraction targets `transactionId` — a retracted row is never a subject of commit, assignment, or verification again, permanently. */
export function isRetracted(all: RawTransaction[], transactionId: string): boolean {
  return all.some((t) => t.kind === "Retraction" && (t.payload as RetractionPayload).targetId === transactionId);
}

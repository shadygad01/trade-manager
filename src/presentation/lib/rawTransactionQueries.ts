import { useLiveQuery } from "dexie-react-hooks";
import { repos } from "./data";
import type { RawTransaction } from "@domain/entities/RawTransaction";

/**
 * Phase 9.7: a reactive read of the canonical RawTransaction log, available
 * for a future Verification Read Cutover — NOT consumed by ImportPage.tsx
 * yet. ImportPage.tsx still reads its pending pool from localStorage
 * (importSession) and its committed facts from repos.trades/allocations/
 * verifications via its own separate useLiveQuery calls; this hook exists so
 * that cutover, whenever it's authorized, doesn't need to invent this wiring
 * from scratch — it can call useLiveRawTransactions() and feed the result
 * straight into verificationEngine.verifyAllDetailed().
 *
 * Backed by dexie-react-hooks' useLiveQuery, which re-runs the query
 * automatically on any write to the observed Dexie table — including the
 * retraction dual-writes ImportPage.tsx's Skip/Dismiss/Discard actions now
 * perform (see ImportPage.tsx's retractRawTransactionKeys) — so a consumer
 * of this hook always reflects the current, retraction-aware state without
 * polling or manual invalidation.
 */
export function useLiveRawTransactions(): RawTransaction[] | undefined {
  return useLiveQuery(() => repos.rawTransactions.getAll(), []);
}

/** Scoped variant of useLiveRawTransactions for one ticker — thin wrapper over the same reactive repository, using the index-backed getByTicker read instead of a full-table scan. */
export function useLiveRawTransactionsForTicker(ticker: string | undefined): RawTransaction[] | undefined {
  return useLiveQuery(() => (ticker ? repos.rawTransactions.getByTicker(ticker) : Promise.resolve([])), [ticker]);
}

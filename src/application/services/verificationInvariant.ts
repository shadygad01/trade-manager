import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { isRetracted, resolveCurrentTicker } from "./rawTransactionFolds";
import { latestByTicker } from "./reconciliation";
import type { TickerMatchStatus } from "./importVerification";

/**
 * Product invariant (see docs/ROADMAP.md's "ABUK class of bug" entries):
 * a ticker's Verification verdict (`matched`/`reason`) may change ONLY when
 * one of its three legitimate inputs changes — its live economic facts (the
 * Buy/Sell executions themselves: ticker/side/shares/price/date/source), its
 * corroborating evidence (the latest broker "My Position" verification), or
 * which source authored them. An allocation-only operation (Smart Allocate,
 * Lot Manager's setSellAllocation/resetSellAllocation) writes a
 * SellAllocationDecision — a fact about WHICH lot a sell closes — which is
 * deliberately NOT part of this fingerprint: deciding a sell's allocation
 * must never, by itself, be able to flip whether that sell's own execution
 * facts are trusted.
 *
 * This module is a detector, not an enforcer — see smartAllocateSell's own
 * doc comment on why a verified financial write is logged, never rolled
 * back, on violation.
 */

function liveEconomicFacts(rawTransactions: RawTransaction[], ticker: string): RawTransaction[] {
  const normalized = normalizeTicker(ticker);
  return rawTransactions
    .filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution")
    .filter((t) => !isRetracted(rawTransactions, t.id))
    .filter((t) => {
      const resolved = resolveCurrentTicker(rawTransactions, t);
      return resolved !== undefined && normalizeTicker(resolved) === normalized;
    });
}

/** Stable, order-independent fingerprint of every live Buy/Sell execution fact for one ticker — deliberately excludes SellAllocationDecision (which lot a sell closes is not an economic fact about the sell itself). */
export function fingerprintEconomicFacts(rawTransactions: RawTransaction[], ticker: string): string {
  const rows = liveEconomicFacts(rawTransactions, ticker)
    .map((t) => {
      const p = t.payload as BuyExecutionPayload | SellExecutionPayload;
      return [t.kind, t.source, p.executionDate, p.executionTime ?? "", p.shares, p.price].join("|");
    })
    .sort();
  return rows.join(";");
}

/**
 * The remaining-shares figure the ticker's economic facts alone imply — sum
 * of every live BuyExecution's shares minus every live SellExecution's
 * shares, computed directly from the facts, with no dependency on how the
 * Allocation Engine/Lot Manager internally attributed which sell closed
 * which lot. An allocation-identity bug (see docs/ROADMAP.md's "sourceUploadIds"
 * root cause) can misattribute a sell to the wrong lot while leaving every
 * fact's own value untouched — silently corrupting the DERIVED remaining-
 * shares total (e.g. Trade.remainingShares summed across lots) without
 * changing a single fact. This is the independent, facts-only ground truth
 * to check that derived total against.
 */
export function expectedNetSharesFromFacts(rawTransactions: RawTransaction[], ticker: string): number {
  return liveEconomicFacts(rawTransactions, ticker).reduce((sum, t) => {
    const p = t.payload as BuyExecutionPayload | SellExecutionPayload;
    return t.kind === "BuyExecution" ? sum + p.shares : sum - p.shares;
  }, 0);
}

export interface ShareArithmeticViolation {
  ticker: string;
  expectedNetShares: number;
  actualRemainingShares: number;
  responsibleFunction: string;
  file: string;
}

/**
 * Second, independent guard: the ledger's own derived remaining-shares total
 * for a ticker must always equal what its live economic facts alone imply.
 * Unlike `checkVerificationInvariant` (which only ever fires on a real
 * before/after pair), this needs no snapshot — the facts and the derived
 * total are both always available from the current state alone.
 */
export function checkShareArithmeticInvariant(params: {
  rawTransactions: RawTransaction[];
  ticker: string;
  actualRemainingShares: number;
  responsibleFunction: string;
  file: string;
}): ShareArithmeticViolation | undefined {
  const expectedNetShares = expectedNetSharesFromFacts(params.rawTransactions, params.ticker);
  if (Math.abs(expectedNetShares - params.actualRemainingShares) < 1e-6) return undefined;
  return {
    ticker: params.ticker,
    expectedNetShares,
    actualRemainingShares: params.actualRemainingShares,
    responsibleFunction: params.responsibleFunction,
    file: params.file,
  };
}

/** Stable fingerprint of the corroborating evidence (the latest broker "My Position" capture) for one ticker — undefined when none exists. */
export function fingerprintEvidence(verifications: PositionVerification[], ticker: string): string | undefined {
  const latest = latestByTicker(verifications).get(normalizeTicker(ticker));
  if (!latest) return undefined;
  return [latest.units, latest.avgCost ?? "", latest.capturedAt].join("|");
}

export interface VerificationSnapshot {
  operation: string;
  ticker: string;
  economicFacts: string;
  evidence: string | undefined;
  status: Pick<TickerMatchStatus, "matched" | "reason">;
  responsibleFunction: string;
  file: string;
}

export interface VerificationInvariantViolation {
  operation: string;
  ticker: string;
  previousVerification: Pick<TickerMatchStatus, "matched" | "reason">;
  currentVerification: Pick<TickerMatchStatus, "matched" | "reason">;
  changedField: "matched" | "reason";
  responsibleFunction: string;
  file: string;
}

/**
 * Compares a before/after pair captured around one operation. Returns a
 * violation only when the economic facts AND evidence fingerprints are
 * byte-identical but the verdict changed anyway — the exact "raw facts and
 * evidence unchanged, verification changed regardless" shape this invariant
 * exists to catch. A verdict change alongside a fingerprint change is never
 * reported: that's the system working as designed (new information arrived).
 */
export function checkVerificationInvariant(
  before: VerificationSnapshot,
  after: VerificationSnapshot
): VerificationInvariantViolation | undefined {
  if (before.economicFacts !== after.economicFacts) return undefined;
  if (before.evidence !== after.evidence) return undefined;
  if (before.status.matched === after.status.matched && before.status.reason === after.status.reason) return undefined;

  return {
    operation: after.operation,
    ticker: after.ticker,
    previousVerification: before.status,
    currentVerification: after.status,
    changedField: before.status.matched !== after.status.matched ? "matched" : "reason",
    responsibleFunction: after.responsibleFunction,
    file: after.file,
  };
}

/** Formats a violation exactly per docs/ROADMAP.md's invariant-guard spec (Operation Name, Previous/Current Verification, Changed Field, Responsible Function, File) — one line, safe for console.error. */
export function formatVerificationInvariantViolation(v: VerificationInvariantViolation): string {
  return (
    `Verification invariant violated — Operation: ${v.operation} | Ticker: ${v.ticker} | ` +
    `Previous: matched=${v.previousVerification.matched} reason=${v.previousVerification.reason} | ` +
    `Current: matched=${v.currentVerification.matched} reason=${v.currentVerification.reason} | ` +
    `Changed field: ${v.changedField} | Responsible function: ${v.responsibleFunction} | File: ${v.file}`
  );
}

/** Formats a share-arithmetic violation for console.error — same one-line, structured shape as formatVerificationInvariantViolation. */
export function formatShareArithmeticViolation(v: ShareArithmeticViolation): string {
  return (
    `Share arithmetic invariant violated — Ticker: ${v.ticker} | ` +
    `Expected (from facts): ${v.expectedNetShares} | Actual (ledger): ${v.actualRemainingShares} | ` +
    `Responsible function: ${v.responsibleFunction} | File: ${v.file}`
  );
}

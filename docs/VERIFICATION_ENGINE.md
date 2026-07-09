# Verification Engine

`src/application/services/verificationEngine.ts`. Part of the raw-transaction
architecture foundation (see `ROADMAP.md`'s "Architecture Foundation" entry) —
depends only on `@domain` types, `importVerification.ts`, `duplicateDetection.ts`,
`orderEvidence.ts`, and `reconciliation.ts`. Never writes anything: no ledger,
no allocations, no holdings, no transaction edits.

## What it does

For every `BuyExecution`/`SellExecution` `RawTransaction` in scope, gathers
the same evidence signals the codebase already computes elsewhere
(cross-source corroboration, order-history confirmation, ledger-duplicate
detection, broker "My Position" reconciliation via `checkTickerMatch`,
wrong-ticker hints) and folds them into a `Verified` / `Rejected` /
`Needs Review` verdict per transaction.

## Old API (unchanged, still the only thing existing callers use)

```ts
function verifyAll(params: VerifyAllParams): Map<string, TransactionVerification>
function verifyTransaction(transactionId: string, params: VerifyAllParams): TransactionVerification | undefined

interface VerifyAllParams {
  transactions: RawTransaction[];
  positions: PositionAggregate[];
}

interface TransactionVerification {
  transactionId: string;
  evidence: EvidenceItem[];
  verdict: "Verified" | "Rejected" | "Needs Review";
}
```

`commitEngine.ts` (`shouldCommit`, `commitTicker`) is the only production
caller today, and calls `verifyAll` exactly as it always has — this contract
completion changed nothing about it.

`verifyAll` internally computes a full `TickerMatchStatus` per ticker (via
`checkTickerMatch`, the same function `ImportPage.tsx`'s legacy read path
calls directly) in order to decide each transaction's verdict — but until
now, everything except the `.reason` string was discarded once that fold
finished. That was the audited blocker: the numbers every legacy UI banner
needs (net shares, existing/pending share breakdown, the broker's verified
count, which side a discrepancy sits on) existed for a moment inside this
function and then vanished.

## New API (additive — nothing above was removed or changed)

```ts
/** checkTickerMatch()'s own result, tagged with the ticker it was computed for. */
interface TickerStatus extends TickerMatchStatus {
  ticker: string;
}

interface VerificationResult {
  /** Identical to verifyAll()'s own return value. */
  transactions: Map<string, TransactionVerification>;
  /** One entry per ticker present in params.transactions, keyed by normalizeTicker(ticker). */
  tickers: Map<string, TickerStatus>;
}

function verifyAllDetailed(params: VerifyAllParams): VerificationResult
function verifyTicker(ticker: string, params: VerifyAllParams): TickerStatus | undefined
```

`TickerMatchStatus` (`importVerification.ts`) carries: `matched`, `reason`,
`netShares`, `existingRemainingShares`, `pendingBuyShares`, `pendingSellShares`,
`verifiedUnits`, `verifiedAvgCost`, `alreadyFullyRecorded`, `discrepancySide`
— every field the legacy `ImportPage.tsx` banners (Missing Buy History, Needs
Broker Screenshot, Mismatch, matches-broker) are templated from today.

### How it's implemented

`verifyAll`'s original body was renamed to a private `computeVerification`,
which now returns `{ transactions, tickers }` instead of just `transactions`.
`verifyAll` is a one-line wrapper (`computeVerification(params).transactions`)
so its signature, behavior, and return value are byte-for-byte unchanged.
`checkTickerMatch` is still called exactly once per ticker, at the same call
site as before — the ticker-level loop now also stashes `{ ticker, ...status }`
into a second map (`tickerStatuses`) alongside the existing `tickerReason` map
it already built. No calculation moved, none was duplicated, no verification
rule changed.

## Example payload

```ts
import { verifyAllDetailed } from "@application/services/verificationEngine";

const result = verifyAllDetailed({
  transactions: rawTransactionsForThisTicker, // e.g. from repos.rawTransactions.getAll()
  positions: [],
});

result.transactions.get(buyTxn.id);
// => { transactionId: "buy-1", verdict: "Needs Review",
//      evidence: [{ type: "contradicted-position-mismatch", detail: "Ticker-level reconciliation: mismatch." }] }

result.tickers.get("COMI");
// => {
//      ticker: "COMI",
//      matched: false,
//      reason: "mismatch",
//      netShares: 150,
//      existingRemainingShares: 100,
//      pendingBuyShares: 50,
//      pendingSellShares: 0,
//      verifiedUnits: 999,
//      discrepancySide: "sell",
//    }
```

`result.tickers.get("COMI")` is exactly what a future UI would need to render
today's "Missing Buy History" / "Needs Broker Screenshot" / "Mismatch"
banners without re-deriving anything itself.

## Migration notes

This change is a **contract completion, not a cutover**. `ImportPage.tsx`
still reads from the legacy path (`repos.trades/allocations/verifications`
+ `importSession` localStorage + `checkTickerMatch` called directly) and was
not touched. See the prior architectural audit for the full blocker list —
this closes one of them (the ticker-level facts being discarded).

## Phase 9.6 — blocker elimination (additive, still not a cutover)

Six more blockers from the same audit are now closed inside VerificationEngine
itself. `ImportPage.tsx` is still untouched and still computes its own
(now-redundant) copies of every one of these signals — closing a blocker here
does not make the legacy UI read from it.

1. **Retractions.** `computeVerification` now filters `params.transactions`
   through `isRetracted` (moved to a new leaf module, `rawTransactionFolds.ts`,
   so `commitEngine.ts` and `verificationEngine.ts` both depend on it instead
   of `verificationEngine.ts` depending sideways on `commitEngine.ts`) before
   doing anything else. A RawTransaction with a live `Retraction` pointed at
   it now disappears from both `transactions` and `tickers` entirely, not
   just from the verdict. This closes the ENGINE-side half of the gap only —
   `ImportPage.tsx`'s skip/dismiss/discard actions still don't emit a
   `Retraction` (that requires editing `ImportPage.tsx`, out of scope this
   phase), so nothing in production calls this path yet.
2. **Evidence completion.** `findDateMisreadDuplicateHints`,
   `findOrphanedFulfilledEvidence`, `mismatchResolver.suggestRemovalsToReconcile`,
   and `netShareTimeline.findLastBalancedDate` are now called inside
   `computeVerification`, with the same gating conditions `ImportPage.tsx`'s
   own `useMemo`s applied. `reconcileSuggestion`'s `existingCostBasis` input
   deliberately reproduces `ImportPage.tsx`'s fees/taxes-EXCLUSIVE formula
   (`entryPrice * remainingShares`), not `PositionAggregate.costBasis` (which
   includes fees/taxes) — those are different numbers and the avg-cost
   ranking is sensitive to which one it's given. A new `contradicted-date-misread`
   `EvidenceType` was added, explicitly excluded from the verdict fold's
   `hasDirectMatch` check (advisory only, same as the legacy badge — it must
   never itself force Rejected).
3. **Wrong-ticker detection.** The hardcoded `[], []` committed-pool
   arguments to `findWrongTickerCandidateKeys` are gone. In an all-
   RawTransaction world there's no separate "committed" table, so every live
   Buy/Sell entry in scope is reshaped into the same `{ticker, executionDate,
   shares, entryPrice}` / `{..., sharesClosed, exitPrice}` pool the function
   already expects, and doubles as its own comparison pool. Self-matches are
   structurally impossible (the committed check requires a different ticker;
   `findDateMisreadDuplicateHints`' requires a different, OCR-misread-shaped
   date) — verified by a dedicated regression test, not just asserted.
4. **Merge suggestions.** `ImportPage.tsx`'s `mergeSuggestions` signature
   (sorted `side|shares|price|date` across a ticker's whole row set, gated to
   all-low-confidence tickers, preferring a non-all-low-confidence sibling)
   is ported verbatim into `computeVerification`'s per-batch pre-pass and
   exposed as `TickerStatus.mergeSuggestion`.
5. **Placeholder replacement.** `ImportPage.tsx`'s dateless-"Opening balance"-
   lot detection is ported into `computeVerification`, sourced from
   `PositionAggregate.openTrades` — already part of the existing
   `VerifyAllParams` contract, no new input needed. Forward-compat caveat:
   once a future Holdings Engine cutover replaces `TradeService.computePositions`
   as the `positions` source, `openTrades[].notes` (the only signal this
   reads) has no `LedgerEvent` equivalent yet.
6. **Constraint Validation.** `constraintValidation.ts` needed no code
   change — it was already a pure facts-in/report-out function with no
   service imports of its own. `verificationEngine.ts` gained
   `buildConstraintReport(ticker, params)`, composing `verifyTicker` +
   `buildTickerConstraintReport` in one call from fields already sitting on
   `TickerStatus` (items 2-5 above), so a future caller needs zero separate
   calculation.

New exports: `TickerStatus` gained `orphanedOrderEvidence`,
`wrongTickerHintCount`, `dateMisreadHintCount`, `reconcileSuggestion`,
`lastBalancedDate`, `mergeSuggestion`, `placeholderReplacement`. New function
`buildConstraintReport`. `EvidenceType` gained `contradicted-date-misread`.
`verifyAll`/`verifyTransaction`/`verifyAllDetailed`/`verifyTicker`'s existing
signatures and behavior are unchanged.

## Tests

- `verificationEngine.test.ts`: 40 tests (21 from Phase 9.5 unchanged, plus
  19 new Phase 9.6 tests — one per blocker's behavior, several cross-checking
  the engine's output against calling the ported function directly with
  equivalent inputs, using the real COMI/HRHO/CSAG/ORWE/PHAR historical
  shapes from `docs/ROADMAP.md` where one exists for that blocker).
- `commitEngine.test.ts`: 26 tests, unchanged since Phase 9.5 (the
  `isRetracted` extraction into `rawTransactionFolds.ts` is a pure move, not
  a behavior change).
- Full suite: 751 tests green (738 from Phase 9.5 + 13 more once Phase 9.6's
  additions are counted individually), `tsc --noEmit` and `arch:check` clean.

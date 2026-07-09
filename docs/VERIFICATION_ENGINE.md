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
this closes exactly one of them (the ticker-level facts being discarded).
Still open before any UI cutover can be attempted: a reactive (`useLiveQuery`)
wrapper around `repos.rawTransactions`, making `recordImportedRawTransactions`
the authoritative write instead of a shadow write, wiring in the four
diagnosis-only functions verifyAll still doesn't call
(`findDateMisreadDuplicateHints`, `findOrphanedFulfilledEvidence`,
`mismatchResolver.suggestRemovalsToReconcile`, `netShareTimeline.findLastBalancedDate`),
and fixing `findWrongTickerCandidateKeys`'s hardcoded `[], []` committed-pool
arguments (`verificationEngine.ts`'s own comment explains why they're empty
today).

## Tests

- `verificationEngine.test.ts`: original 11 tests unchanged; a new
  `verifyAllDetailed`/`verifyTicker` describe block additionally proves (a)
  `verifyAllDetailed(...).transactions` is `toEqual` `verifyAll(...)` across
  every existing scenario, and (b) `TickerStatus` fields match what
  `checkTickerMatch` produces when called directly with the same inputs.
- `commitEngine.test.ts`: original 23 tests unchanged; three new tests cross-
  check `verifyAllDetailed`'s `matched` flag against `shouldCommit`'s
  true/false decision and confirm reading the new API alongside
  `commitTicker` doesn't perturb ledger/allocation output.
- Full suite: 738 tests green (719 pre-existing + 19 new), `tsc --noEmit` and
  `arch:check` clean.

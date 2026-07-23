# Architecture Refactor Handoff

## Repository and current state

- Repository: `shadygad01/trade-manager`, branch `codex/import-page-architecture-refactor` (PR #140, draft).
- All work is committed and pushed. Each iteration below is its own commit.
- `ImportPage.tsx` is currently ~2,581 lines (started this phase at ~3,297; was 3,175 lines as of the earlier checkpoint commit `90c9a52`).
- Preserve identical observable behavior. Work in small, independently validated iterations.

## Goal

Complete the architecture roadmap:

1. Make `ImportPage` a thin composition layer.
2. Decompose import coordination and commit services without creating God hooks.
3. Decompose `TradeService`, `commitEngine`, `duplicateDetection`, and `ThndrParser`.
4. Make large presentation pages presentation-only.
5. Split oversized tests by responsibility.
6. Perform a final architecture audit.

After every iteration run exactly:

```bash
npm run lint
npm test -- --reporter=dot
npm run build
git diff --check
```

(This environment uses plain `npm`, not `npm.cmd` — the Windows-specific note from earlier sessions doesn't apply here. Run `npm ci` first if `node_modules` is missing.)

## Completed extractions

### Application rules (`src/application/services/`)

- `importReviewRules.ts`
  - `hasSharesToReconcile`, `isLotEligibleForSell`
  - `selectStillPendingCandidates` — the "not added, not skipped, not dismissed" filter, previously duplicated three times inline in `TickerGroupCard`.
  - Has its own `importReviewRules.test.ts` (previously untested).
- `dividendDuplicateDetection.ts` — split out of `duplicateDetection.ts`: `dividendContentKey`, `buildExistingDividendKeys`, `isDividendAlreadyRecorded`, `suggestDuplicateDividendIdsToDelete`. `duplicateDetection.ts` re-exports all four. Own `dividendDuplicateDetection.test.ts`.
- `wrongTickerHints.ts` — split out of `duplicateDetection.ts`: `findWrongTickerCandidateKeys`, `findDateMisreadDuplicateHints`, and their private `wrongTickerConfidenceRank`/`datesLikelyOcrMisread` helpers. `duplicateDetection.ts` re-exports both. Own `wrongTickerHints.test.ts`.
- `officialBrokerRepair.ts` — split out of `commitEngine.ts`: `findOfficialBrokerDuplicateIds`, `retractOfficialBrokerDuplicates`, `convergeOfficialBrokerAuthority`, `repairOfficialBrokerSellAllocations`, and their private `executionOrder`/`buyKey`/`sellKey`/`lotWasOpenBeforeSell` helpers. Imports `CommitEngineRepos`/`resolveCurrentPortfolioId` back from `commitEngine.ts` (a deliberate two-way type/function import, safe since neither module calls the other at top level — see that commit's message for the full reasoning). `commitEngine.ts` re-exports `convergeOfficialBrokerAuthority`/`repairOfficialBrokerSellAllocations`.
- `duplicateAuthorityReconciliation.ts` — split out of `commitEngine.ts`: `reconcileDuplicateAuthority` (~207 lines), called from exactly one place inside `commitTicker` (right after `ensureLegacyFactsExist`, inside its existing non-fatal try/catch, untouched). Same two-way type-only import pattern as `officialBrokerRepair.ts`. This move also fixed a pre-existing misplaced-comment bug — the function's large doc comment (twin-lot guard, canonicalKey convergence, authorityRank tie-breaking) had been sitting above `executionOrder`'s old position in `commitEngine.ts`, not above `reconcileDuplicateAuthority` itself; it now sits directly above the function it actually describes.

For all four of the above: pure move + re-export, zero logic change, each verified against the full suite plus the specific test files that exercise that code path.

### Commit-coordination extraction (the one piece of the "sensitive" work done so far)

- `commitOfficialBrokerSell` — extracted from `ImportPage.tsx`'s `commitTickerGroupLocked`. That function (~320 lines) is the single most ordering-sensitive piece of code in this codebase: its buy/dividend/verification/portfolio-assignment phases inside a `processBatch()` closure have extensive comments documenting specific, previously-reproduced race conditions with `commitEngine`'s reactive `appendAndMaybeCommit` trigger. **`processBatch()` itself was deliberately left untouched.** The one part safe to pull out without touching that ordering: the official-broker-Excel sell loop, which runs entirely *after* `processBatch`'s transaction has already committed. Its per-entry body moved verbatim into a named function, matching the "loop does lock acquire/finally-release, calls a named per-entry function" shape `addBuyCandidate`/`addDividend`/`acceptVerification` already use. Same call order, same lock positions, same non-rethrow-on-error contract. Verified against `ImportPage.brokerExcelClosedPosition.test.tsx` and the full suite.

### Small hooks (`src/presentation/hooks/`)

- `useImportQueries.ts`, `useCommitLock.ts`, `useCommitQueue.ts` — unchanged this round; see prior handoff history in git log if needed. Do not combine these into a large `useImportCommit` hook.

### Presentation components (`src/presentation/components/`)

Extracted from `ImportPage`/`TickerGroupCard`, all presentation-only (already-derived data + delegated callbacks, no business logic): `AutoCommitRow.tsx`, `CandidateRow.tsx`, `ImportMatchBadge.tsx`, `ImportReviewPanels.tsx`, `TickerEvidenceRows.tsx`, `RecordedTradesPanel.tsx`, `TickerGroupHeader.tsx`, `TickerSuggestionBanners.tsx`, `TickerResolutionBanners.tsx`, `TickerBuyRows.tsx`, `TickerSellRows.tsx`, `TickerGroupCard.tsx`, `ImportUploadPanel.tsx`, `CompletedTickersPanel.tsx`, `ImportReviewSummaryBar.tsx`.

`CandidateRow`/`AutoCommitRow`/`TickerGroupCard` all have compatibility re-exports from `ImportPage.tsx` (`export { X } from "@presentation/components/X"`) because their dedicated test files (`src/presentation/pages/{AutoCommitRow,CandidateRow,TickerGroupCard}.test.tsx`) import via `./ImportPage`, not the component module directly. Keep this pattern if you extract anything else with its own pre-existing test file.

`ImportPage()`'s own JSX (the `return (...)` block) is now almost entirely composition: `PageHeader`, an `EmptyState` for the no-portfolios case, `ImportUploadPanel`, `ImportReviewSummaryBar`, `CompletedTickersPanel`, the `TickerGroupCard` map, and a `Modal`+`SellAllocationForm` for sell allocation. It still owns all calculations, state transitions, eligibility decisions, reconciliation logic, allocation, commit actions, and mutations — intentional; see "What's explicitly NOT done" below.

### Test splits (`src/presentation/pages/`, `src/application/services/`)

- `TickerGroupCard.test.tsx` — split out of `ImportPage.test.tsx` (which had grown to 1766 lines, 16 of 17 `describe` blocks being `TickerGroupCard` scenarios).
- `dividendDuplicateDetection.test.ts`, `wrongTickerHints.test.ts` — split out of `duplicateDetection.test.ts` alongside their function moves.

`ImportPage.test.tsx` now only holds `hasSharesToReconcile` and `Smart Allocate chronology` (28 lines) — the actual page-level tests live in the separate `ImportPage.*.test.tsx` suffixed files, untouched this round.

### Dormant CRLF cleanup

Several older files (`ImportPage.test.tsx`, `duplicateDetection.ts`/`.test.ts`, `commitEngine.ts`) had accumulated stray CRLF line endings, invisible because no prior diff had touched enough of any one file to surface it under `git diff --check`. Each time this session's work touched one of those files enough to trigger the check, it was normalized to LF (the rest of the codebase's standard) as part of that same commit. If you hit `git diff --check` failures that look like every line in a file you touched is flagged, this is almost certainly why — check with `grep -c $'\r' <file>`; if it's the whole file, `sed -i 's/\r$//' <file>` and re-run the gate.

## Latest checkpoint

All of the above passed, as of commit `f7f7455` — **locked**; the session stopped here deliberately rather than continuing further into `commitTicker`/`appendAndMaybeCommit` itself:

- TypeScript
- Project lint
- Dependency Cruiser: zero violations
- Full Vitest suite: 131 test files, 1119 tests passed, 2 skipped (same pre-existing skips as always — see below)
- Production Vite build
- `git diff --check`
- Additionally verified beyond the standard gate: the production build was served with `vite preview` and both the HTML shell and the main JS/CSS bundles loaded with HTTP 200 (confirms the circular imports introduced by the `officialBrokerRepair.ts`/`duplicateAuthorityReconciliation.ts` splits resolve correctly in the actual bundler output, not just under `tsc`/Vitest).

Also added this session: `duplicateAuthorityReconciliation.ts` (split out of `commitEngine.ts`, see below).

Known existing test output includes non-fatal `canonicalHoldings` fallback warnings and the intentionally unapproved determinism golden warning (`determinism.golden.json is NOT approved`). Pre-existing, do not "fix" as part of this refactor.

## Important architectural constraints

- Do not create a large orchestration hook or replacement God component.
- Keep locking, queueing, execution, reconciliation, verification, refresh, allocation, and business rules separate.
- Do not move business decisions into presentation components.
- Do not change behavior, translation keys, persisted data formats, or public test/import contracts.
- Validate after each bounded extraction before starting the next. Do not combine multiple unrelated extractions into one commit.
- Before extracting anything from `commitTickerGroupLocked` (ImportPage.tsx) or `commitTicker`/`appendAndMaybeCommit`/`shouldCommit`/`assignPortfolio`/`reconcileDuplicateAuthority` (commitEngine.ts), read that function's full doc comment end to end and identify exactly which race condition it protects against and how. Several of these comments describe real, previously-reproduced production bugs. A "pure move" is only actually pure if every `await` point, every lock acquire/release, and every "must run before/after X" ordering stays byte-for-byte identical relative to its neighbors.

## What's explicitly NOT done (and why it's riskier)

The presentation-layer extraction (goal 1 and most of goal 4) is essentially complete for `ImportPage`/`TickerGroupCard`. Straightforward file-splitting of pure/stateless application-layer functions is well underway. What's left is the genuinely hard core:

1. **`processBatch()` inside `commitTickerGroupLocked` (ImportPage.tsx, goal 2).** The buy loop → `recordBuyBatch` → dividend loop → verification loop → `assignPortfolio` sweep sequence. The doc comments explain a real, reproduced duplicate-Trade bug caused by running the portfolio-assignment sweep in the wrong position relative to the other three loops (it reactively re-triggers `commitEngine`'s own commit path). Untouched. Any decomposition here must preserve this exact ordering.
2. **`commitTicker`/`appendAndMaybeCommit`/`shouldCommit`/`assignPortfolio`/`assignPortfolioToFact`/`retractRawTransaction` (commitEngine.ts, goal 3).** The reactive commit-trigger core itself — now down to ~330 lines after both splits, but this remaining core is the highest-risk part of the whole codebase and was deliberately left alone. `commitEngine.ts` now consists of: this reactive core, plus two-way type-only imports from `officialBrokerRepair.ts` and `duplicateAuthorityReconciliation.ts`, plus `renameRawTransactionsTicker` (small, standalone, easy future split if wanted).
3. **`TradeService.ts` (1341 lines), `ThndrParser.ts` (1110 lines).** Not yet touched at all this session. Unknown internal risk profile — read them before assuming they're as decomposable as `duplicateDetection.ts`/`commitEngine.ts` were.
4. **`ImportPage.tsx`'s other ~20 handler functions** (`processFiles`, `confirmAndDistributeAll`, `renameTickerGroup`, `addBuyCandidate`, `allocateOrPendSell`, `smartAllocateSell`, etc.) — not reviewed for extraction this session beyond `commitOfficialBrokerSell`.
5. **Other large presentation pages (goal 4).** `PortfolioDetailPage.tsx` (974 lines), `TradesPage.tsx` (745 lines) — smaller, not part of this session's scope.
6. **Splitting other oversized tests (goal 5).** The other `ImportPage.*.test.tsx` suffixed files weren't reviewed for size.
7. **Final architecture audit (goal 6).** Not started — only once 1–6 above are actually done.

## Recommended next step

This session stopped here deliberately — commit `f7f7455` is a clean, fully-validated checkpoint, and going further into `commitTicker`/`appendAndMaybeCommit` itself is a materially different risk tier from everything done so far (those two both directly participate in the documented re-entrant-commit race, unlike everything split out this session, which was called BY them but never called back into them). Before touching either:

1. Read `commitTicker` (commitEngine.ts) and `processBatch()`/`commitTickerGroupLocked` (ImportPage.tsx) in full, end to end, together.
2. Write out — in a scratch file, not committed — every documented ordering invariant between them (there are at least three distinct ones across the two files' comments).
3. Only then consider whether any sub-step can be named/extracted without changing that ordering — and validate with the full gate plus every `ImportPage.brokerExcel*`/`ImportPage.*Duplicate*`/`crossTransactionIsolation` test file explicitly, not just the aggregate pass/fail count.

A mechanical extraction here is exactly the failure mode the existing comments were written to prevent someone from repeating. If less risk is wanted instead, `TradeService.ts`/`ThndrParser.ts` are unreviewed and might turn out to have the same easily-separable-pure-function shape `duplicateDetection.ts` did — read them first rather than assuming either way.

# Architecture Refactor Handoff

## Repository and current state

- Repository: `shadygad01/trade-manager`, branch `codex/import-page-architecture-refactor` (PR #140, draft).
- All work is committed and pushed. Each iteration below is its own commit.
- `ImportPage.tsx` is currently ~2,581 lines (started this phase at ~3,297; was 3,175 lines as of the last checkpoint commit `90c9a52`).
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
  - `hasSharesToReconcile`
  - `isLotEligibleForSell`
  - `selectStillPendingCandidates` — the "not added, not skipped, not dismissed" filter, previously duplicated three times inline in `TickerGroupCard`.
  - Has its own `importReviewRules.test.ts` (previously untested).
- `dividendDuplicateDetection.ts` — split out of `duplicateDetection.ts`:
  - `dividendContentKey`, `buildExistingDividendKeys`, `isDividendAlreadyRecorded`, `suggestDuplicateDividendIdsToDelete`.
  - `duplicateDetection.ts` re-exports all four; `ImportPage.tsx`/`TimelinePage.tsx` needed no import changes.
  - Has its own `dividendDuplicateDetection.test.ts`, split out of `duplicateDetection.test.ts`.

### Small hooks (`src/presentation/hooks/`)

- `useImportQueries.ts` — query/read aggregation only.
- `useCommitLock.ts` — in-flight registry, acquisition/release, lock status, exception-safe cleanup only.
- `useCommitQueue.ts` — serialized queue-key ownership only.
- Tests exist for the lock and queue hooks.

Do not combine these into a large `useImportCommit` hook.

### Presentation components (`src/presentation/components/`)

Extracted from `ImportPage`/`TickerGroupCard`, all presentation-only (already-derived data + delegated callbacks, no business logic):

- `AutoCommitRow.tsx`, `CandidateRow.tsx` — row rendering; `ImportPage.tsx` keeps compatibility re-exports (`export { CandidateRow } ...`, `export { AutoCommitRow } ...`) since dedicated test files (`src/presentation/pages/AutoCommitRow.test.tsx`, `CandidateRow.test.tsx`) still import via `./ImportPage`.
- `ImportMatchBadge.tsx`
- `ImportReviewPanels.tsx` — constraint report and recovery plan rendering.
- `TickerEvidenceRows.tsx` — verification, dividend, and fulfilled-order evidence rows.
- `RecordedTradesPanel.tsx` — recorded-trade display and delegated deletion action.
- `TickerGroupHeader.tsx` — rename controls, restore/reset buttons, match badge, portfolio selector, confirm button.
- `TickerSuggestionBanners.tsx` — merge/known-symbol suggestions, portfolio hints, ticker errors.
- `TickerResolutionBanners.tsx` — no-verification, mismatch, placeholder replacement, reconciliation, ambiguous-portfolio banners.
- `TickerBuyRows.tsx` — buy row-list rendering; composes `AutoCommitRow` per still-visible entry.
- `TickerSellRows.tsx` — sell row-list rendering; composes `CandidateRow` per still-visible entry.
- `TickerGroupCard.tsx` — the full ticker card, moved verbatim out of `ImportPage.tsx`. `ImportPage.tsx` keeps a compatibility re-export (`export { TickerGroupCard } ...`) since `src/presentation/pages/TickerGroupCard.test.tsx` imports it via `./ImportPage`, following the same pattern as `AutoCommitRow`/`CandidateRow`.
- `ImportUploadPanel.tsx` — Step 1: tracking-start-date picker, drag/drop-or-choose dropzone, per-file results, extracted-rows summary line.
- `CompletedTickersPanel.tsx` — the collapsible "N tickers fully recorded" summary with per-ticker reset.
- `ImportReviewSummaryBar.tsx` — Step 2's "N of M matched" status line plus its two batch actions (clear suspected duplicates, confirm & distribute all).

`ImportPage()`'s own JSX (the `return (...)` block) is now almost entirely composition: `PageHeader`, an `EmptyState` for the no-portfolios case, `ImportUploadPanel`, `ImportReviewSummaryBar`, `CompletedTickersPanel`, the `TickerGroupCard` map, and a `Modal`+`SellAllocationForm` for sell allocation. It still owns all calculations, state transitions, eligibility decisions, reconciliation logic, allocation, commit actions, and mutations — that's intentional; see "What's explicitly NOT done" below.

### Test splits (`src/presentation/pages/`, `src/application/services/`)

- `TickerGroupCard.test.tsx` — split out of `ImportPage.test.tsx` (which had grown to 1766 lines, 16 of 17 describe blocks being `TickerGroupCard` scenarios). Follows the same pattern as `AutoCommitRow.test.tsx`/`CandidateRow.test.tsx`: imports `TickerGroupCard` via the `./ImportPage` compatibility re-export. `ImportPage.test.tsx` now only holds `hasSharesToReconcile` and `Smart Allocate chronology` (28 lines).
- `dividendDuplicateDetection.test.ts` — split out of `duplicateDetection.test.ts` alongside the dividend-function move above.

Also fixed along the way: `ImportPage.test.tsx` and `duplicateDetection.ts`/`duplicateDetection.test.ts` had accumulated stray CRLF line endings (dormant — no prior diff had touched enough of any of those files to surface it under `git diff --check`). Normalized to LF, matching the rest of the codebase, when those files were touched anyway.

## Latest checkpoint

All of the above passed, as of commit `fbc1fa9`:

- TypeScript
- Project lint
- Dependency Cruiser: zero violations
- Full Vitest suite: 130 test files, 1119 tests passed, 2 skipped (same pre-existing skips as always — see below)
- Production Vite build
- `git diff --check`

Known existing test output includes non-fatal `canonicalHoldings` fallback warnings and the intentionally unapproved determinism golden warning (`determinism.golden.json is NOT approved`). These are pre-existing and do not fail the suite — do not try to "fix" them as part of this refactor.

## Important architectural constraints

- Do not create a large orchestration hook or replacement God component.
- Keep locking, queueing, execution, reconciliation, verification, refresh, allocation, and business rules separate.
- Do not move business decisions into presentation components.
- Do not change behavior, translation keys, persisted data formats, or public test/import contracts.
- Validate after each bounded extraction before starting the next. Do not combine multiple unrelated extractions into one commit.
- If a file you're about to touch turns out to have dormant CRLF line endings, normalize the whole file to LF as part of that commit (see above) rather than fighting `git diff --check` line by line.

## What's explicitly NOT done (and why it's riskier)

The presentation-layer extraction (goal 1 and most of goal 4) is essentially complete for `ImportPage`/`TickerGroupCard` — its JSX is now thin composition. What's left is qualitatively different and higher-risk:

1. **Import coordination and commit services (goal 2).** `ImportPage.tsx` still has ~25 handler functions (`processFiles`, `commitTickerGroupLocked`, `confirmAndDistributeAll`, `renameTickerGroup`, etc.), several hundred lines each. `commitTickerGroupLocked` in particular (~320 lines) has extensive comments documenting subtle **ordering-dependent race-condition fixes** between the commit queue, `commitEngine`'s reactive `appendAndMaybeCommit` trigger, and concurrent Smart-Allocate/Allocate-Sell calls. Decomposing this safely requires deeply understanding each documented race before moving anything — a mechanical split risks silently reintroducing one of the bugs the comments describe. Do this in its own dedicated, carefully-validated session, not as a quick iteration.
2. **`TradeService.ts` (1341 lines), `commitEngine.ts` (1140 lines), `ThndrParser.ts` (1110 lines).** Not yet touched. `commitEngine.ts` is the other half of the race-condition-sensitive commit pathway above — same caution applies. `duplicateDetection.ts` (947 → now ~700 lines after the dividend split) is partway decomposed; it's a much safer target since its functions are pure and well-tested — continuing to peel off cohesive groups (e.g. wrong-ticker/date-misread hints, or aggregate-statement matching, each already tested by its own `describe` block in `duplicateDetection.test.ts`) is a reasonable next low-risk iteration.
3. **Other large presentation pages (goal 4).** `PortfolioDetailPage.tsx` (974 lines) and `TradesPage.tsx` (745 lines) are next-largest after `ImportPage.tsx`, but far smaller and not part of this session's scope — the whole handoff to date has been `ImportPage`-focused.
4. **Splitting other oversized tests (goal 5).** The other `ImportPage.*.test.tsx` suffixed files (e.g. `ImportPage.reconciliation.test.tsx`) weren't reviewed for size this session.
5. **Final architecture audit (goal 6).** Not started — do this only once 1–4 above are actually done, not before.

## Recommended next step

Lowest-risk, highest-value next iteration: keep decomposing `duplicateDetection.ts` one cohesive group at a time, the same way `dividendDuplicateDetection.ts` was split off — e.g. `wrongTickerHints.ts` (`wrongTickerConfidenceRank`, `findWrongTickerCandidateKeys`, `datesLikelyOcrMisread`, `findDateMisreadDuplicateHints`) next, since those four are self-contained and already have their own `describe` blocks in the test file to split alongside them.

Do **not** attempt `commitTickerGroupLocked`/`commitEngine.ts` decomposition without first reading every doc comment in both files end to end and writing down the specific ordering invariants each one protects — see "What's explicitly NOT done" above.

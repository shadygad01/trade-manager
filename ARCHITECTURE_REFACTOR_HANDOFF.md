# Architecture Refactor Handoff

## Repository and current state

- Repository: `C:\Users\Lap001\Documents\smart-trader`
- Work is intentionally uncommitted in the current worktree.
- Do not delete or modify the unrelated untracked `.codex-tmp/` directory.
- `ImportPage.tsx` is currently about 3,297 physical lines.
- Preserve identical observable behavior. Work in small, independently validated iterations.

## Goal

Complete the architecture roadmap:

1. Make `ImportPage` a thin composition layer.
2. Decompose import coordination and commit services without creating God hooks.
3. Decompose `TradeService`, `commitEngine`, `duplicateDetection`, and `ThndrParser`.
4. Make large presentation pages presentation-only.
5. Split oversized tests by responsibility.
6. Perform a final architecture audit.

After every iteration run:

```powershell
npm.cmd run lint
npm.cmd test -- --reporter=dot
npm.cmd run build
git diff --check
```

`npm.cmd` is required in the current PowerShell environment because script execution blocks `npm.ps1`. Vite/esbuild may require permission to resolve repository configuration outside the restricted sandbox.

## Completed extractions

### Application rules

- `src/application/services/importReviewRules.ts`
  - `hasSharesToReconcile`
  - `isLotEligibleForSell`

### Small hooks

- `src/presentation/hooks/useImportQueries.ts`
  - Query/read aggregation only.
- `src/presentation/hooks/useCommitLock.ts`
  - In-flight registry, acquisition/release, lock status, and exception-safe cleanup only.
- `src/presentation/hooks/useCommitQueue.ts`
  - Serialized queue-key ownership only.
- Tests exist for the lock and queue hooks.

Do not combine these into a large `useImportCommit` hook.

### Presentation components extracted from ImportPage/TickerGroupCard

- `AutoCommitRow.tsx`
  - Buy batch-commit status rendering; `ImportPage` keeps a compatibility re-export for existing tests.
- `CandidateRow.tsx`
- `ImportMatchBadge.tsx`
- `ImportReviewPanels.tsx`
  - Constraint report and recovery plan rendering.
- `TickerEvidenceRows.tsx`
  - Verification, dividend, and fulfilled-order evidence rows.
- `RecordedTradesPanel.tsx`
  - Recorded-trade display and delegated deletion action.
- `TickerGroupHeader.tsx`
  - Rename controls, restore/reset buttons, match badge, portfolio selector, confirm button.
- `TickerSuggestionBanners.tsx`
  - Merge/known-symbol suggestions, portfolio hints, ticker errors.
- `TickerResolutionBanners.tsx`
  - No-verification, mismatch, placeholder replacement, reconciliation, and ambiguous-portfolio banners.
- `TickerBuyRows.tsx`
  - Buy row-list rendering; composes `AutoCommitRow` per still-visible entry.
- `TickerSellRows.tsx`
  - Sell row-list rendering; composes `CandidateRow` per still-visible entry.

The parent still owns all calculations, state transitions, eligibility decisions, solver limits, and mutations. Extracted components receive already-derived values and callbacks.

## Test maintenance already performed

- Updated stale expectations in:
  - `ImportPage.aggregateStatement.test.tsx`
  - `ImportPage.brokerExcelLoadRace.test.tsx`
- Preserved the existing `CandidateRow` export from `ImportPage` through a compatibility re-export.

## Latest checkpoint

The latest fully validated iteration extracted `TickerBuyRows` and `TickerSellRows` from `TickerGroupCard` and passed:

- TypeScript
- Project lint
- Dependency Cruiser with zero violations
- Full Vitest suite (127 files, 1110 passed, 2 skipped — same pre-existing skips as before)
- Production Vite build
- `git diff --check`

`TickerGroupCard`'s buy `.map()` block (rendering `AutoCommitRow`) and sell `.map()` block (rendering `CandidateRow`) moved into `src/presentation/components/TickerBuyRows.tsx` and `src/presentation/components/TickerSellRows.tsx` respectively. Both are presentation-only: they receive `group.buys`/`group.sells`, the same key sets, hint maps, and the `duplicateMatch`/`onAllocateSell`/`onSmartAllocate`/`onDiscardPending`/`onDeleteAutoAdded` callbacks `TickerGroupCard` already had, and render the identical JSX that used to live inline. No duplicate matching, eligibility, reconciliation, allocation, or mutation logic moved — it's all still computed in `TickerGroupCard`/`ImportPage` and passed down as already-derived props. The direct `CandidateRow`/`AutoCommitRow` imports in `ImportPage.tsx` were removed since nothing in that file references them directly anymore; the compatibility re-exports (`export { CandidateRow } ...` / `export { AutoCommitRow } ...`) are untouched and still resolve from their own component modules.

Run `git diff --check` once more after reading this file.

Known existing test output includes non-fatal `canonicalHoldings` fallback warnings and the intentionally unapproved determinism golden warning. These were present before the current extraction and do not fail the suite.

## Important architectural constraints

- Do not create a large orchestration hook or replacement God component.
- Keep locking, queueing, execution, reconciliation, verification, refresh, allocation, and business rules separate.
- Do not move business decisions into presentation components.
- Do not change behavior, translation keys, persisted data formats, or public test/import contracts.
- Preserve user-owned/unrelated work and `.codex-tmp/`.
- Use `apply_patch` for edits.
- Validate after each bounded extraction before starting the next.

## Recommended next step

The buy/sell row lists are now extracted. `TickerGroupCard` (still defined inside `ImportPage.tsx`) is the next candidate: extract it into its own component file (e.g. `src/presentation/components/TickerGroupCard.tsx`), keeping its existing prop surface unchanged — it already receives fully-derived data and callbacks from `ImportPage`, so this should be a pure move, not a rewrite. After that, look at moving `TickerGroupCard`'s own derived-state `useMemo`s (`lastBalanced`, `duplicateFlaggedNet`, `constraintReport`, `completenessReport`, etc.) into small pure helpers by concern, one at a time. Only then continue to commit execution/coordination and the service decomposition phases (`TradeService`, `commitEngine`, `duplicateDetection`, `ThndrParser`).

## Prompt for Claude

Copy the following prompt into Claude:

> You are continuing an in-progress production architecture refactor in `C:\Users\Lap001\Documents\smart-trader`. Read `ARCHITECTURE_REFACTOR_HANDOFF.md` completely, inspect the current dirty worktree as authoritative, and continue from the validated checkpoint. Do not reset, discard, or overwrite existing changes, and do not touch the unrelated untracked `.codex-tmp/` directory.
>
> The full objective is to make `ImportPage` a thin composition layer; decompose import coordination and commit services; decompose `TradeService`, `commitEngine`, `duplicateDetection`, and `ThndrParser`; make large presentation pages presentation-only; split oversized tests; then perform a final architecture audit. Preserve identical business behavior throughout.
>
> Work in small, independently validated iterations. Do not create a large `useImportCommit` hook, another God hook, or a replacement God component. Keep locking, queueing, execution, reconciliation, verification, refresh, allocation, and business rules separate. Presentation components must receive already-derived data and delegated callbacks; they must not own business decisions or mutations.
>
> Start by verifying the current state and running `git diff --check`. The latest fully validated extraction is `AutoCommitRow.tsx`; TypeScript, project lint, Dependency Cruiser, full Vitest, the production build, and `git diff --check` passed afterward. The recommended next iteration is to extract the buy/sell row-list rendering from `TickerGroupCard` while keeping duplicate calculations, eligibility decisions, reconciliation highlights, allocation, and actions in the parent.
>
> After every iteration run exactly: `npm.cmd run lint`, `npm.cmd test -- --reporter=dot`, `npm.cmd run build`, and `git diff --check`. Stop and fix any failure before continuing. Report files changed, architectural benefit, remaining responsibilities, and the next recommended extraction after each checkpoint.

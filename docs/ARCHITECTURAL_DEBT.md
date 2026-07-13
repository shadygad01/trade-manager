# Architectural Debt Dashboard

**Purpose**: a single, honest catalog of every known architectural debt item in the v2 migration —
what it is, why it exists, how severe it is, and what (if anything) currently prevents it from getting
worse. This is not a TODO list to clear all at once; per `docs/ROADMAP.md`'s own working convention, only
the highest-priority gap gets picked up per sprint.

**Keep this in sync**: update this file in the same commit as any change that closes, worsens, or adds a
debt item — especially any commit that touches an allowlist in `src/architecture/regressionGuards.test.ts`
(Part "CI Regression Guards" below). A regression-guard allowlist changing without a matching update here
is itself a form of the drift this file exists to prevent.

**Last verified**: commit `a49c1ba` + this sprint's changes (System Snapshot exporter, Determinism Test,
CI regression guards, this dashboard). Test suite at time of writing: 986 passed, 1 skipped (987 total),
`tsc --noEmit` clean, `arch:check` clean.

---

## How to read this file

Each item has:
- **Status**: `OPEN` (unaddressed), `FROZEN` (can't get worse — a CI regression guard enforces the current
  count/set, but it hasn't been reduced), `MITIGATED` (a real safeguard exists short of full closure), or
  `CLOSED` (no longer exists — kept here with a strikethrough-style note for history, not deleted, so the
  record of what closed a debt item is never lost).
- **Guard**: the exact test (if any) that would fail if this got worse.
- **Closure path**: which future PR (see `docs/PORTFOLIO_OS_V2_SPEC.md` Part 9/19.2 for full PR
  definitions) is expected to close it — or "none planned" if it's an accepted, permanent trade-off.

---

## 1. Multiple Writers

### 1.1 `Trade`/`TradeAllocation` — two writers
**Status: FROZEN.** `TradeService.ts` (the primary use-case layer, direct `.trades.save`/`.allocations.save`)
and `ledgerProjection.ts` (`projectLegacyTicker`, rewriting the same rows from replayed facts) both write
these tables. Three more files touch them for narrower, disclosed reasons: `ledgerRebuild.ts`
(auto-applicable metadata-only corrections), `lotManager.ts` (stale-allocation cleanup on retraction),
`BackupService.ts` (bulk import/export, not a business write path).
**Guard**: `src/architecture/regressionGuards.test.ts` → "no new direct writers of Trade/TradeAllocation"
— fails if a 6th file starts calling `.trades`/`.allocations` `.save()`/`.delete()` directly.
**Closure path**: PR4 (Guardian pipeline) + PR6 (legacy table retirement).

### 1.2 `Portfolio.cash` — six-plus writers, no projection live yet
**Status: OPEN**, but its data prerequisite is now met. `recordBuy`, `recordSell`, `recordDividend`,
`recordCashAdjustment`, `moveTrade`, deposit/withdrawal actions all mutate `Portfolio.cash` directly.
`computeCashProjection` (`cashProjection.ts`) is fully built and tested but not read live anywhere.
**What changed this sprint**: BF-1 (the one-time RawTransaction backfill, see item 6 below) means every
existing portfolio's fact log will be complete on next app load — the actual blocker PR2 was waiting on.
**Guard**: none direct (this item isn't "can it get worse," it's "when does it get fixed").
**Closure path**: PR2, gated on its own shadow-mode trial (Part 10) — BF-1 landing does NOT itself
authorize starting PR2's live cutover.

## 2. Multiple Ownership / Duplicate Computation

### 2.1 Holdings — three computations
**Status: FROZEN.** `computePositions` (`TradeService.ts`, legacy), `computeHoldings`
(`holdingsEngine.ts`, canonical replay), `computeCanonicalPositions` (`canonicalHoldings.ts`, hybrid with
fallback). Three presentation pages (`DashboardPage`, `PortfolioDetailPage`, `PortfoliosPage`) read the
hybrid; three more (`TradesPage`, `SellAllocationForm`, `lotManager.ts`) read `Trade` directly for
entity-CRUD/lot-picking reasons.
**Guard**: `regressionGuards.test.ts` → "computePositions/computeHoldings/computeCanonicalPositions stay
the only three position-computation functions."
**Closure path**: PR5 (single Holdings/Position read model).

### 2.2 Ticker rename — two mechanisms
**Status: OPEN.** `TradeService.renameTickerEverywhere` physically mutates already-recorded `Trade`/
`TradeAllocation`/`TimelineEvent`/`PositionVerification` rows directly — the one place in the whole system
where "Facts are immutable" (the Fact Store's own core guarantee) is violated in practice, even though
`RawTransaction`'s `CorrectionPayload` already has an unused `ticker` patch field built for exactly this.
Found during Stage 1 baseline re-verification, not previously documented.
**Guard**: none yet — would need a guard asserting `Trade`/`TradeAllocation`/`TimelineEvent`/
`PositionVerification` rows are never `.save()`'d with a different `ticker` than they were created with,
outside the Correction-fact path. Not built this sprint (out of scope — no legacy code removal/rewrite).
**Closure path**: part of PR4 (Guardian pipeline) — renames become Correction facts + replay, never a
direct mutation.

## 3. Duplicate/Scattered Policy Logic

### 3.1 Canonical policy functions — currently NOT duplicated, actively guarded
**Status: MITIGATED.** `authorityRank`/`higherAuthority` (`evidenceAuthority.ts`),
`isTickerFullyOfficialBrokerExcelSourced` (`reconciliation.ts`), `checkTickerMatch`
(`importVerification.ts`), `verifyAll`/`verifyTransaction`/`verifyAllDetailed`/`verifyTicker`
(`verificationEngine.ts`) are each defined in exactly one file today. Historically this was NOT true —
`constraintValidation.ts` once re-derived its own inventory check, and `ledgerRebuild.ts`'s trust exemption
was computed independently of Import's before being unified (both fixed in earlier sprints, per
`docs/ROADMAP.md`).
**Guard**: `regressionGuards.test.ts` → "every known trust/authority/verification-judgment function is
still defined in exactly the one file that owns it" + "no file outside evidenceAuthority.ts defines its
own authority/trust ranking table."
**Closure path**: none needed for the functions above (already singular) — PR3 is about consolidating
them into one `src/application/policy/` MODULE (a location, not a correctness fix) and porting
`ImportPage.tsx`'s remaining re-derivations (item 3.2) to call the canonical functions instead.

### 3.2 `ImportPage.tsx` re-derives some verification signals instead of consuming `verifyAllDetailed`
**Status: OPEN.** Per `docs/VERIFICATION_ENGINE.md`: "`ImportPage.tsx` still reads from the legacy path...
was not touched" — this is a real, disclosed policy-drift risk (two code paths computing the same
judgment, one not guaranteed to stay in sync with the other) even though today's actual VALUES happen to
agree.
**Guard**: none (would require presentation-layer source scanning `regressionGuards.test.ts` doesn't do
today — a plausible small follow-up).
**Closure path**: PR3.

## 4. Legacy/Parallel Replay Paths

### 4.1 `ledgerRebuild.ts`'s Upload-based reconstruction — a second replay pipeline
**Status: FROZEN, by design, not yet closed.** `generateLedgerEvents`/`generateAllocations` (the
RawTransaction-based Ledger/Allocation Engines) are the canonical replay. `dryRunLedgerRebuild` is a
structurally separate pipeline reconstructing from `Upload.candidates` instead — kept alive because its
diff-against-legacy-tables view is still useful (and used by this sprint's own Determinism Test's "Rebuild"
stage) until nothing can drift from the fact log for it to reconcile against.
**Guard**: `regressionGuards.test.ts` → "`dryRunLedgerRebuild` stays defined in exactly one file" (a THIRD
replay-shaped pipeline appearing anywhere would be the same bug class as this file's own genesis: "two
ledgers disagreeing" — see `docs/ROADMAP.md`'s "Rebuild Ledger vs. Import disagreement" incident).
**Closure path**: PR6, once its only remaining legitimate job (historical backfill) is confirmed fully
covered by `backfillRawTransactions.ts`.

## 5. Coarse-Key-Reused-As-Identity (the dominant historical bug class)

**Status: MITIGATED for the 5 functions the repo-wide audit found; structurally guarded going forward for
new code.** `GroupingSignature` (`src/domain/value-objects/identity.ts`, PR1a) is a branded type applied to
`canonicalKey`, `pendingCandidateSignature`, and the three composite sell-order-grouping keys — a plain
`string` can no longer be silently assigned where a `GroupingSignature` is expected without an explicit
cast, closing the compile-time gap behind ABUK/ADPC/`canonicalTransaction.ts`/`retractMatchingRawTransaction`
(five historical incidents, `docs/ROADMAP.md`).
**Known, disclosed limitation**: an explicit `as GroupingSignature` cast at a NEW, wrong call site is still
possible — the branding makes misuse visible and greppable, not literally impossible. `LedgerEvent.eventId`/
`RawTransaction.id` are NOT yet branded as a distinct `EntityId` (PR1b, deferred — see item 7).
**Guard**: `tsc --noEmit` (the branded type itself); no additional regression-guard test beyond that today.
**Closure path**: PR1b for the identity side; ongoing code review for the cast-escape-hatch risk.

## 6. Fact-Log Completeness

**Status: MITIGATED this sprint (was OPEN).** `backfillRawTransactions` (the one-time whole-ledger
conversion) had zero production call sites before this sprint — every pre-existing portfolio's fact log
was silently incomplete. `backfillRawTransactionsSilently` (BF-1's validated-safe variant — see
`docs/PORTFOLIO_OS_V2_SPEC.md` Part 19.6 for the full validation design and why the original,
commit-triggering variant was rejected) is now wired into `src/presentation/lib/data.ts`'s startup path.
**A new, disclosed defect found during BF-1's own validation work, NOT fixed**: the ORIGINAL
(commit-triggering) `backfillRawTransactions` produces a duplicate `SellAllocationDecision` fact per sell
order (root cause: `ensureLegacyFactsExist`'s gap-fill races ahead of the backfill loop). Functionally
harmless (the Allocation Engine only ever draws a lot's balance down once), but real. Filed as a small,
independent follow-up — not bundled into BF-1 since it's a different, already-shipped function.
**Guard**: `backfillRawTransactions.test.ts`'s own "no duplicates" test on the SILENT variant (which is
immune by construction); no guard against the reactive variant's defect (accepted, low-severity, disclosed).
**Closure path**: a small, independent fix to `backfillRawTransactions` before it's ever exposed to a
human-facing "Migrate my data" action (it currently has zero production callers of its own).

## 7. Deferred Type-Safety Work

### 7.1 `EntityId` branding (PR1b) — not started
**Status: OPEN, deliberately deferred.** Only `GroupingSignature` (item 5) shipped this migration.
Branding `RawTransaction.id`/`LedgerEvent.eventId` as a distinct `EntityId` type is a materially larger
change (`LedgerEvent.eventId` is legitimately dual-natured — sometimes a real fact id, sometimes a
`GroupingSignature`-derived value with a disambiguating suffix, per `ledgerEngine.ts`'s own canonicalization
step) requiring its own reviewed design for the promotion boundary between the two.
**Guard**: none (nothing to regress against yet).
**Closure path**: PR1b, scoped on its own.

## 8. Explicitly Out of Scope This Sprint (not debt — a deliberate boundary)

Per this sprint's own instructions, these are NOT attempted and are not counted as regressions:
- **Guardian pipeline** (single `executeMutation` write gateway) — PR4, not started.
- **Policy Engine** (single `src/application/policy/` module) — PR3, not started (though items 3.1's
  functions are already individually singular).
- **Legacy code removal** — nothing in `Trade`/`TradeAllocation`/`ledgerRebuild.ts`/etc. was deleted or
  rewritten this sprint.
- **PR2 (cash cutover)** — its data prerequisite (item 1.2 / item 6) is now met, but PR2 itself was not
  started.

---

## CI Regression Guards — index

Every guard referenced above lives in `src/architecture/regressionGuards.test.ts`, sanity-verified this
sprint (each one deliberately broken with a throwaway fake violation, confirmed to fail with a clear
message, then reverted — not just assumed to work):

| Guard | Prevents |
|---|---|
| No new direct writers of Trade/TradeAllocation | New dual writers |
| Position-computation functions stay exactly 3 | New replay/holdings implementations |
| `generateLedgerEvents`/`generateAllocations` stay singular | A second Ledger/Allocation Engine |
| `dryRunLedgerRebuild` stays singular | A third, parallel replay pipeline |
| Trust/authority/verification functions stay in their one canonical file each | New policy implementations outside the canonical location |
| No second `AUTHORITY_RANK`-shaped table | Duplicate trust-ranking tables |
| Dexie schema table list matches the reviewed, categorized allowlist | New, unreviewed direct mutable derived state |

Plus `.dependency-cruiser.cjs`'s three layering rules (domain/application/infrastructure/presentation
inward-only dependencies) and its `only-repositories-and-purge-touch-db-directly` rule (PR1a — restricts
direct Dexie access to repository adapters, `purge.ts`, test files, and one explicitly-named, reviewed
exemption: `determinismScenario.ts`).

See `docs/MIGRATION_STATUS.md` for the quantitative view (test counts, PR completion status) this file's
qualitative catalog is paired with.

# Migration Status Dashboard

Quantitative companion to `docs/ARCHITECTURAL_DEBT.md`'s qualitative catalog. Every number below was
directly measured against the repository at the time of writing (grep counts, test runs) — none are
estimates. Re-verify by running the commands in the **"How to reproduce these numbers"** section at the
bottom before trusting a stale copy of this file.

**Last verified**: commit `a49c1ba` + this sprint's changes.

---

## 1. Migration Foundation Completion

| PR | Scope | Status | Evidence |
|---|---|---|---|
| PR1a | `GroupingSignature` branded type + direct-DB-access lint rule | ✅ **DONE** | commit `874a88f`; 5 functions branded; `arch:check` clean |
| PR1b | `EntityId` branded type for `RawTransaction.id`/`LedgerEvent.eventId` | ⬜ NOT STARTED | scoped in `docs/PORTFOLIO_OS_V2_SPEC.md` Part 19.2, deliberately deferred |
| BF-1 | Wire the dormant one-time RawTransaction backfill | ✅ **DONE (safe variant)** | commit `a49c1ba`; `backfillRawTransactionsSilently` wired into `data.ts`; original commit-triggering design explicitly rejected with evidence (Part 19.6) |
| FIX-1 | Normalize `timesConflict` time-string comparison | ✅ **DONE** | commit `ed1c6dc` |
| FIX-2 | `purge.ts` table-list completeness test | ✅ **DONE** | commit `ed1c6dc` |
| **This sprint** | System Snapshot exporter + E2E Determinism Test + CI regression guards + dashboards | ✅ **DONE** (golden reference **PENDING HUMAN APPROVAL** — see §3) | this commit |
| PR2 | Cash-as-projection cutover | ⬜ NOT STARTED (data prerequisite now met) | blocked on its own shadow-mode trial, not on BF-1 |
| PR3 | Single Policy module | ⬜ NOT STARTED | canonical functions already individually singular (§2 below) |
| PR4 | Guardian pipeline | ⬜ NOT STARTED — **explicitly out of scope this sprint** | |
| PR5 | Single Holdings/Position read model | ⬜ NOT STARTED | |
| PR6 | Legacy table retirement | ⬜ NOT STARTED | |
| PR7 | Certification | ⬜ NOT STARTED | gates final program sign-off |

**Program completion**: 5 of 12 tracked items done (PR1a, BF-1, FIX-1, FIX-2, this sprint's observability
work) = **~42%** by item count. Not a proxy for risk-weighted completion — PR4 (Guardian) alone is rated
the highest-risk item in the entire backlog (`docs/PORTFOLIO_OS_V2_SPEC.md` Part 19.2) and remains
untouched.

## 2. Architectural Metrics (frozen counts, each backed by a CI regression guard)

| Metric | Count | Guarded by | Direction since baseline |
|---|---|---|---|
| Direct writers of `Trade`/`TradeAllocation` | **5 files** | `regressionGuards.test.ts` | unchanged (frozen, not reduced) |
| Position/holdings computation implementations | **3 functions** | `regressionGuards.test.ts` | unchanged (frozen, not reduced) |
| Ledger/Allocation Engine implementations | **1 each** (singular) | `regressionGuards.test.ts` | unchanged (already correct) |
| Parallel replay pipelines (`ledgerRebuild.ts`'s Upload-based reconstruction) | **1** (the one known exception) | `regressionGuards.test.ts` | unchanged |
| Canonical trust/authority/verification functions | **8 functions, 4 files, each singular** | `regressionGuards.test.ts` | unchanged (already correct) |
| Authority/trust ranking tables | **1** (`evidenceAuthority.ts`) | `regressionGuards.test.ts` | unchanged (already correct) |
| Dexie schema tables | **11**, all categorized | `regressionGuards.test.ts` + `purge.test.ts` | unchanged |
| Grouping-signature functions with compile-time identity/signature separation | **5 of 5** known instances | `tsc --noEmit` (branded type) | 0 → 5 this migration (PR1a) |
| Dormant (zero production caller) functions | `systemValidation.validatePortfolio` (still dormant); `backfillRawTransactions` reactive variant (superseded by its safe sibling, itself still has zero production callers of its own) | — | `backfillRawTransactionsSilently` newly wired this sprint |

## 3. Determinism / Observability Infrastructure (new this sprint)

| Component | Status |
|---|---|
| System Snapshot exporter (`systemSnapshot.ts`) | ✅ Built. 7 category hashes (Facts, Ledger, Holdings, Allocation, Verification, Portfolio, Policy) + 1 combined hash. 5 unit tests, including a direct determinism proof (two independently-seeded scenarios → byte-identical hashes) and a sensitivity proof (a real data difference changes only the affected categories). |
| End-to-end Determinism Test (`determinism.e2e.test.ts`) | ✅ Built. Full `Reset → Import Official Broker Excel → Confirm → Smart Allocate → Commit → Refresh → Rebuild → Restart → Snapshot` flow against real Dexie. |
| ├─ Cross-run determinism proof | ✅ **ENFORCED, passing** — two independent runs of the identical flow produce byte-identical snapshots, checked on every test run. |
| └─ Golden-reference comparison | ⏸️ **BUILT BUT NOT YET ENFORCED** — `determinism.golden.json` has `approved: false`; the comparison test is `skipIf`'d with a loud console warning, not silently green. **Requires a deliberate human step**: run `npm run determinism:regenerate-golden`, independently verify the resulting candidate's business values (holdings shares/cost basis, ledger events, verification verdicts, policy ranking) are actually correct — not just "the current code produced this" — then manually promote it per `determinism.golden.json`'s own `_readme`. This gate exists specifically so a defect in the current implementation can never get silently baked into the baseline as "expected behavior." |
| Regeneration tooling (`scripts/regenerate-determinism-golden.ts`) | ✅ Built. Writes only a reviewable candidate file (`determinism.golden.candidate.json`) plus a category-by-category diff against whatever is currently approved — never writes `determinism.golden.json` itself. |
| CI regression guards (`src/architecture/regressionGuards.test.ts`) | ✅ Built, 7 tests, all sanity-verified (each guard deliberately broken with a throwaway violation once, confirmed to fail with a clear message, reverted). |

## 4. Test Suite

| Metric | Value |
|---|---|
| Test files | 107 |
| Tests passing | 986 |
| Tests skipped | 1 (the golden-reference comparison — see §3; by design, not a gap) |
| Tests failing | 0 |
| `tsc --noEmit` | clean |
| `npm run arch:check` (dependency-cruiser) | clean, 2519 modules / 7659 dependencies cruised |

## 5. What "measurable, observable, deterministic, and protected against regression" means concretely here

- **Measurable**: every count in §2 has a specific test that computes it — not a prose estimate.
- **Observable**: the System Snapshot exporter (§3) gives a single, inspectable fingerprint of the entire
  replayable state, split into named categories so a divergence names exactly what changed.
- **Deterministic**: proven directly (not assumed) — the cross-run determinism test replays the identical
  scenario twice, independently, and asserts byte-identical output, on every CI run.
- **Protected against regression**: the 7 CI guards in §3/`ARCHITECTURAL_DEBT.md` fail the build the
  moment any of the frozen counts in §2 grows, and the golden-reference mechanism (once approved) fails
  the build the moment replay/holdings/verification/policy behavior changes even in a way that stays
  internally self-consistent (which the cross-run test alone couldn't catch, since two drifted-together
  runs would still agree with each other).

## How to reproduce these numbers

```bash
npm test -- --run                                    # §4 test counts
npx tsc --noEmit                                      # §4 tsc status
npm run arch:check                                    # §4 arch:check status
npx vitest run src/architecture/regressionGuards.test.ts   # §2 metrics (read the allowlists in the test file itself for exact current values)
npx vitest run src/presentation/pages/determinism.e2e.test.ts  # §3 determinism status
```

Update this file's numbers whenever any of the above changes — see `docs/ARCHITECTURAL_DEBT.md`'s own
"keep this in sync" note, which applies equally here.

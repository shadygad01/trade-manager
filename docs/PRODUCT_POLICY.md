# Product Policy: Trust, Verification, Evidence, Allocation

This is the single canonical reference for "which source wins, and when is a
transaction trusted enough to commit." It didn't exist as one document before
this audit — the rules were correct and internally cross-referenced (every
file below quotes "the broker-record trust policy" identically) but scattered
across eight files' doc comments. This file collects them, states the
decision matrix explicitly, and records the one real inconsistency the audit
found between two of those files (see "Certification" at the bottom).

Everything here describes **existing, already-implemented behavior**. Where
this document and the code ever disagree in the future, the code's own doc
comments (cited throughout) are the source of truth — update this file to
match, the same way ROADMAP.md's sprint log is a record, not a spec.

## 1. Two different questions, two different rankings

This codebase asks two structurally different trust questions, answered by
two different mechanisms. Conflating them is the exact shape of every real
bug this audit found (see §6):

| Question | Mechanism | Scope |
|---|---|---|
| "Two documents disagree about one execution's price/fees/shares/date — whose number do I print?" | `evidenceAuthority.ts`'s `AUTHORITY_RANK` / `authorityRank()` / `higherAuthority()` | Field-value arbitration only, **after** corroboration already established both sides describe the same transaction. Never decides whether an execution exists or is trustworthy. |
| "Does this ticker's batch of Buy/Sell rows need a broker 'My Position' screenshot before it can commit, or is it already trustworthy enough without one?" | `checkTickerMatch()` in `importVerification.ts` | Existence/trustworthiness gate for a whole ticker's pending batch (or, via `reconciliation.ts`, its whole committed history). |

## 2. The authority rank (field-value disputes)

From `evidenceAuthority.ts`, highest to lowest:

| Rank | Source | Why |
|---|---|---|
| 6 | `invoice` | The only source with an itemized fee schedule. |
| 5 | `official-broker-excel` | Broker's native "Your Orders" export — every field printed verbatim, no OCR. |
| 4 | `statement` | Broker-authored, dated, but net-value-only (fees not itemized). |
| 3 | `orders-screen` | Dated, priced, quantity-exact, no fees. |
| 2 | `orders-timeline` | Undated Orders timeline, dated Transactions list, and in-app Order Details — collapsed to one tier because `RawTransactionSource` can't distinguish them today (documented limitation). |
| 1 | `csv`, `notification`, `email`, `screenshot`, `other-document` | Generic/terse/unstructured broker-originated evidence. Ties favor neither. |
| 0 | `manual`, `backfill` | No document behind it (or a pre-migration conversion already vetted once). |
| n/a | `position-verification` | Not ranked at all — see §3. |

Ties favor neither side (`higherAuthority` returns `undefined` when ranks are
equal — two statements disagreeing is not this ranking's problem to solve).

**`position-verification` (a "My Position" screenshot) is deliberately
excluded from this ranking.** It never describes an execution's
price/fees/shares/date — a broker Holdings screen only ever shows the current
unit count. It remains authoritative for a different question (§4), just not
this one.

## 3. The broker-record trust policy (existence/trustworthiness gate)

`checkTickerMatch()`'s decision order, first match wins:

1. **No shares to verify** (nothing pending, no shares open) → trivially matched.
2. **Every pending row is `official-broker-excel`-sourced** → matched,
   `broker-excel-verified`, **regardless of whether a "My Position" screenshot
   exists, agrees, or disagrees.** A disagreeing screenshot is surfaced only
   as a non-blocking `secondaryMismatch` flag — it never blocks, downgrades,
   or invalidates the batch. This is the one carve-out in the whole policy
   that survives a *present, disagreeing* secondary source.
3. **No screenshot on file at all** (`verifiedUnits === undefined`), then in order:
   a. Every pending row is `invoice`-sourced → matched, `invoice-verified`.
   b. Every pending row is cross-verified (two independent document types
      corroborate the same execution — statement+invoice, statement+orders
      screenshot, invoice+orders screenshot, CSV+anything) → matched, `cross-verified`.
   c. Every pending row is confirmed against the broker's own account-wide
      Orders timeline → matched, `orders-verified`.
   d. Net shares reconcile to exactly zero with **none** of the above → **not**
      matched, `closed-position` (arithmetic-only net-zero is never trusted
      alone — see §5).
   e. Otherwise → not matched, `no-verification`, with `discrepancySide`
      naming which side (buy/sell) to investigate.
4. **A screenshot exists and its unit count matches** the calculated net
   shares → matched, `matched`.
5. **A screenshot exists and disagrees** → not matched, `mismatch`, with
   `discrepancySide` and `alreadyFullyRecorded` (true when the disagreement is
   fully explained by shares already committed before this batch, i.e. every
   pending row is redundant).

**The critical asymmetry**: step 2 (Excel) survives a *present* disagreement.
Steps 3a–3c (Invoice, cross-verification, Orders-timeline confirmation) only
ever substitute for a *missing* screenshot — a real, present disagreement
still reaches step 5 and blocks. This is deliberate, not an oversight: a
single Invoice is a per-transaction document with real duplicate-import risk;
the broker's own account-wide Excel export is not.

## 4. "My Position" screenshot scope

A `PositionVerification` (My Position capture) only ever proves the
**current** unit count — never a historical execution, never applicable to a
closed ticker (a broker Holdings screen never lists a zero-unit position).
Consequences, all enforced consistently:

- `completenessEngine.ts`'s recovery-plan never recommends "My Position" for
  a closed ticker (`isOpenPosition` gate).
- `constraintValidation.ts`'s Global Inventory Check exempts closed positions
  from the comparison entirely (nothing to compare against).
- `constraintValidation.ts` also exempts `brokerExcelVerified` tickers from
  the comparison — not because they're closed, but because the Excel export
  already **is** the Single Source of Truth for that ticker's position (§3
  step 2), so a disagreeing screenshot is never grounds for a contradiction.

## 5. Completeness is stricter than verification

`completenessEngine.ts` answers a different question than §3:
"could a real buy or sell have happened that no document ever captured at
all." Its one deliberate divergence from `checkTickerMatch`: a `closed-position`
verdict (net-zero, uncorroborated) maps to **Incomplete**, never Complete —
net-zero arithmetic alone is indistinguishable from a batch missing an equal,
canceling buy+sell pair just outside the imported window (real historical
cases: JUFO, SKPC). `Complete` is reserved for a verdict backed by genuine
independent corroboration (`invoice-verified` / `broker-excel-verified` /
`cross-verified` / `orders-verified`) — self-consistent numbers alone are
never enough.

## 6. Decision matrix

Two axes, per §1 — evaluated separately, never conflated:

### 6a. Same-execution field-value dispute (authority rank, §2)

| Pair (higher wins) | Result |
|---|---|
| Invoice vs. any other source | Invoice wins (rank 6) |
| Official Broker Excel vs. Statement/Orders/Timeline/CSV/manual | Excel wins (rank 5) |
| Official Broker Excel vs. Invoice | Invoice wins (rank 6 > 5) |
| Statement vs. Orders-screen | Statement wins (4 > 3) |
| Notification vs. OCR screenshot vs. CSV vs. email | Tie — neither wins |
| Anything vs. Manual/Backfill | The document wins (rank 0 is lowest) |
| Anything vs. "My Position" screenshot | N/A — My Position is never in this ranking (§2); it answers a different question (§4) |

### 6b. Existence/trustworthiness gate (checkTickerMatch, §3) — whole batch or whole ticker history

| Batch sourcing | Open position | Closed position (net = 0) | Partial sell mid-position |
|---|---|---|---|
| **100% Official Broker Excel** | `broker-excel-verified` — matched regardless of a disagreeing screenshot | Same — matched regardless | Same — sourcing, not position state, drives this branch |
| **100% Invoice** | `invoice-verified` if no screenshot exists; `mismatch` if one exists and disagrees | `closed-position`, unmatched, unless a screenshot happens to confirm zero (never will — see §4) — recovery plan asks for the smallest missing document, never a screenshot | `invoice-verified` / `mismatch`, same rule as open |
| **Notification-only / OCR-screenshot-only / other-document-only** (rank 1) | `no-verification` unless a screenshot matches, or cross-/orders-verified | `closed-position`, unmatched, unless independently corroborated | `no-verification` unless corroborated |
| **Manual-only** (rank 0) | Same as above — no special exemption; needs a screenshot or corroboration | `closed-position`, unmatched | Same as open |
| **Mixed Excel + Notification/OCR/Manual** | Fails the "100% Excel" test — falls through to ordinary verification (screenshot or corroboration required) for the whole batch | Same — no partial credit for the Excel-sourced rows alone | Same |
| **Mixed Excel + Invoice (both ≥ rank 5)** | Fails "100% literally Excel" (§6, "Certification" below) — routes to Invoice's weaker `invoice-verified`/`mismatch` treatment, not Excel's disagreement-proof one | Same | Same |

## 7. Evaluating the hypothetical "Excel authoritative vs. every open position needs a screenshot" conflict

This exact hypothetical was raised as an illustrative example of a possible
policy contradiction during this audit. It does **not** hold in this
codebase: `completenessEngine.ts`'s "request My Position" recommendation is
explicitly gated to `open && status.reason === "no-verification"` — it never
fires for a `broker-excel-verified` ticker, because `classify()` maps that
reason straight to `Complete`, which short-circuits `recoveryPlan()` before
the My Position branch is ever reached. There is no code path in this
repository that both grants Excel disagreement-proof authority and separately
demands a screenshot for the same ticker.

## 8. Certification — one real inconsistency found and fixed by this audit

**Finding**: `reconciliation.ts`'s `isTickerFullyOfficialBrokerExcelSourced`
is rank-based (`authorityRank(source) >= officialBrokerExcelRank`), which
correctly includes Invoice (rank 6) alongside literal Excel (rank 5) — a
deliberate generalization added to fix a real, reported bug (a closed,
Invoice-only ticker stuck at the `closed-position` dead-end). But this same
function was reused, unchanged, by three callers that needed the **narrower**
§3-step-2 semantic ("exempt even from a disagreeing screenshot"):
`reconcilePositions`'s full skip, `PortfolioDetailPage.tsx`'s
`brokerExcelVerifiedTickers` badge set, and `ImportPage.tsx`'s zero-pending
branch feeding `allPendingFromOfficialBrokerExcel`. All three silently
granted an Invoice-only ticker the same "even a disagreeing screenshot is
fine" treatment §3 step 2 reserves for literal Excel sourcing — contradicting
§3's own documented distinction, and `evidenceAuthority.ts`'s own explicit
disclaimer that its rank "never decides whether an execution... is
trustworthy... only whose numbers to prefer" once corroboration is already
established.

**Live impact**: an Invoice-only, open ticker with a genuinely disagreeing
"My Position" screenshot showed a false-positive "Verified — official broker
Excel" badge (`ImportPage.tsx`, `PortfolioDetailPage.tsx`) or was silently
omitted from the reconciliation report entirely (`reconciliation.ts`) —
hiding a real discrepancy from the user, never even surfaced as the
non-blocking `secondaryMismatch` Excel-sourced tickers get.

**Fix**: added `isTickerFullyExcelSourced` (literal `source ===
"official-broker-excel"` match, `reconciliation.ts`) for the three callers
that need the disagreement-proof exemption. `ImportPage.tsx`'s zero-pending
branch now routes a non-literal-Excel, rank-qualifying ticker (i.e.
Invoice-only, or a Buy/Sell mix of Invoice+Excel) to `allPendingFromInvoice`
instead, which correctly still blocks/mismatches on a real disagreement. The
original rank-based function and its behavior are otherwise unchanged — the
closed-position dead-end fix it was built for still works, since the
zero-pending branch now sets one of the two flags correctly rather than
neither.

**Evidence**:
- `src/application/services/reconciliation.test.ts` — `isTickerFullyExcelSourced`
  describe block (4 new tests) plus a new `reconcilePositions` test proving
  an Invoice-only ticker still reconciles/mismatches instead of being
  skipped.
- `src/presentation/pages/ImportPage.invoiceOnlyDisagreeingScreenshot.test.tsx` —
  end-to-end regression: renders `ImportPage`, confirmed to FAIL against the
  pre-fix code (showed "Fully matched (1)" / "Verified — official broker
  Excel") and PASS against the fix (shows "Mismatch"), verified by stashing
  the fix and re-running.
- Full suite 970/970 green (964 baseline + 6 new), `tsc --noEmit` clean,
  `arch:check` clean (zero dependency violations, 2512 modules).

## 9. Follow-up consolidation pass — two more instances of an established bug class, found and fixed

A second pass, requested specifically to search the repository for
duplicated/drifted policy logic (not to re-audit already-settled ground),
grepped every `authorityRank(`/`=== "official-broker-excel"`/`=== "invoice"`
call site outside the files already covered above. Two real findings, both
the exact "reads the raw, immutable ticker field instead of folding through
`resolveCurrentTicker`" bug class this codebase has already found and fixed
repeatedly (`reconciliation.ts`'s `isTickerFullyOfficialBrokerExcelSourced`,
`rawTransactionFolds.ts`'s `findLiveExecutionFact`, `TradeService.ts`'s
`ensureBuyFact`, `ledgerProjection.ts`'s `resolveExistingTradeForLot`) — but
missed in two modules that group Buy/Sell facts by ticker independently of
those established helpers.

**Finding A — `verificationEngine.ts`'s `toTradeCandidateEntries`** grouped
by the raw `payload.ticker` instead of `resolveCurrentTicker(transactions,
txn)`. This is `computeVerification`'s only internal per-ticker grouping
step, and `computeVerification` (via `verifyAll`) is `commitEngine.ts`'s only
verification call — i.e. this feeds the live commit-decision path, not a
display view. A ticker renamed via a Correction fact that later accumulates
a new fact recorded natively under the corrected name would have its
pre-rename and post-rename facts silently split into two separate
`checkTickerMatch` buckets, each seeing only part of the real position.
Fixed by resolving each fact's current ticker before grouping.

**Finding B — `canonicalTransaction.ts`'s `buildCanonicalTransactions`**
filtered `params.transactions` by the raw `t.ticker` field for the same
reason. This feeds `evidenceIntelligence.ts`'s `getEvidenceIntelligence` —
the "Evidence Intelligence" panel's confirmed/needs-review/rejected view for
a ticker. A renamed ticker's pre-rename execution would silently disappear
from that view, even though `verifyTicker` (called by the same function,
one line above, and now fixed via Finding A) already correctly includes it.
Fixed the same way.

**Evidence**:
- `src/application/services/verificationEngine.test.ts` — new test: a Buy
  fact renamed COMI→HRHO via Correction, plus a second Buy fact recorded
  natively under HRHO, must fold into one 150-share HRHO verdict, not a
  50-share HRHO verdict plus an orphaned 100-share COMI one. Confirmed
  fail-before (`netShares` was 50, not 150) / pass-after by stashing the fix.
- `src/application/services/canonicalTransaction.test.ts` — analogous test:
  both the pre- and post-rename executions must appear under the ticker's
  current name (2 canonical transactions, not 1) and none under the old
  name. Confirmed fail-before (1, not 2) / pass-after the same way.
- Full suite 972/972 green (970 + 2 new), `tsc --noEmit` clean, `arch:check`
  clean (2512 modules, zero violations).

**Reviewed and confirmed NOT drift** (same repo-wide sweep, no code changed):
- `lotManager.ts`'s `authorityRank(adoptable.source) > authorityRank("manual")`
  and `evidenceIntelligence.ts`'s `strongestEvidenceSource` reduce — both use
  the rank for exactly its documented purpose (field-value/provenance
  authority, §2), not the existence/trust gate (§3). Not the same question,
  not drift.
- `duplicateDetection.ts`'s `isInvoiceSourced` (a narrower "prefer Invoice
  when discarding one of two exact-duplicate candidates" heuristic) and
  `evidenceCoverage.ts`'s per-upload `source === "invoice"/"official-broker-excel"`
  branches (classifying what a whole uploaded *document* proves, for the
  Minimal Document recommendation only) — both answer different, narrower
  questions than §2 or §3 and don't share their failure mode.
- `toCandidateSource` is duplicated verbatim between `ledgerEngine.ts` and
  `verificationEngine.ts` — a pure type-narrowing adapter (`RawTransactionSource`
  → `ParsedTradeCandidate["source"]`), not a policy decision. Flagged for
  awareness, not fixed here: it decides nothing about trust or evidence, so
  it's out of this task's scope (business-policy duplication), and touching
  two already-tested modules for a cosmetic, non-behavioral reason wasn't
  worth the risk.

## 10. Final inventory — one canonical implementation per policy decision

| Policy decision | Canonical implementation | Duplicated/drifted callers found | Status |
|---|---|---|---|
| Field-value authority (which source's price/fees/shares/date wins) | `evidenceAuthority.ts`: `authorityRank`, `higherAuthority` | None — every caller (`lotManager.ts`, `evidenceIntelligence.ts`, `canonicalTransaction.ts`'s fee/tax fold) calls these directly | Canonical, single implementation |
| Existence/trustworthiness gate (does this ticker need a screenshot) | `importVerification.ts`: `checkTickerMatch` | None — every caller (`ImportPage.tsx`, `verificationEngine.ts`, `ledgerRebuild.ts`, `reconciliation.ts`) delegates the decision itself to this one function | Canonical, single implementation |
| "Exempt even from a disagreeing screenshot" (Excel-only carve-out) | `reconciliation.ts`: `isTickerFullyExcelSourced` (new) | `reconcilePositions`, `PortfolioDetailPage.tsx`, `ImportPage.tsx` previously used the broader rank-based `isTickerFullyOfficialBrokerExcelSourced` for this | **Fixed** (§8) |
| "Rank ≥ Excel, for closed-position/coverage purposes" | `reconciliation.ts`: `isTickerFullyOfficialBrokerExcelSourced` (unchanged) | None once §8's fix landed | Canonical, single implementation |
| Historical completeness classification | `completenessEngine.ts`: `classify`/`assessTickerCompleteness` | None | Canonical, single implementation |
| Arithmetic contradiction vs. diagnosis | `constraintValidation.ts`: `evaluateInventoryConstraint`/`diagnoseInventoryContradiction` | None | Canonical, single implementation |
| Per-ticker grouping of Buy/Sell facts (correction-aware) | `rawTransactionFolds.ts`: `resolveCurrentTicker` | `verificationEngine.ts`, `canonicalTransaction.ts` previously grouped by the raw ticker field instead | **Fixed** (§9) |
| Cross-source/order/aggregate corroboration | `duplicateDetection.ts` (`findCrossSourceVerifiedKeys`, `findAggregateStatementMatches`), `orderEvidence.ts` (`findOrderConfirmedKeys`) | None | Canonical, single implementation |
| What a document (upload) proves coverage for | `evidenceCoverage.ts`: `buildCoverageClaims` | None | Canonical, single implementation |

Every row above has exactly one canonical implementation as of this audit.
The two "Fixed" rows are the only duplication proven to exist; every other
policy decision in the repository already had a single, correctly-scoped
implementation and was left untouched, per this task's own instruction not
to refactor working code without proof.

## 11. Final certification pass — ticker-identity drift, six more instances found and fixed

A dedicated pass, requested specifically to certify (or disprove) that the
whole architectural BUG CLASS — not one function — was eliminated: any case
where policy is implemented differently across modules, trust/verification
decisions differ between call sites, ticker history can split, or identity
can silently drift. Method: grep every raw ticker-field read
(`payload.ticker`, `t.ticker`, `txn.ticker`) across `src/application` and
`src/presentation`, classify each as canonical/adapter/derived/drift, fix
every drift found, add a fail-before/pass-after regression test proving it,
then repeat the search. Four search passes were run; the fourth found
nothing new.

**Root cause, one bug class, six sites.** `resolveCurrentTicker`
(`rawTransactionFolds.ts`) is the canonical, correction-aware ticker
resolver — already used correctly by `reconciliation.ts`, `commitEngine.ts`,
`TradeService.ts`, and `provenanceRepair.ts`. Six other modules independently
grouped or filtered `RawTransaction[]` by the raw, immutable `ticker` field
instead, each written before (or without cross-referencing) the established
pattern:

| # | Module / function | Consumer | Symptom without the fix | Regression test |
|---|---|---|---|---|
| 1 | `verificationEngine.ts`: `toTradeCandidateEntries` | `commitEngine.ts`'s `commitTicker`/`shouldCommit` — the live commit-decision path | A renamed ticker with a new native-name fact split into two `checkTickerMatch` buckets, each seeing only part of the real position | `verificationEngine.test.ts` |
| 2 | `canonicalTransaction.ts`: `buildCanonicalTransactions` | `evidenceIntelligence.ts`'s Evidence Intelligence panel | A renamed ticker's pre-rename execution silently disappeared from the panel | `canonicalTransaction.test.ts` |
| 3 | `ledgerEngine.ts`: `toCanonicalizationEntries`/`toDirectEvent` | `commitEngine.ts`'s `commitTicker`, `lotManager.ts`'s `computeLedger` — the canonical LEDGER itself | A committed `LedgerEvent`'s own `.ticker` field stayed the stale pre-rename name, read by `holdingsEngine.ts`'s `byTicker` grouping and `systemValidation.ts`'s `.find(h => h.ticker === ticker)` | `commitEngine.test.ts` (2 tests: manual + canonicalized paths) |
| 4 | `canonicalHoldings.ts`: `tryComputeCanonicalByTicker` | The production Holdings/Dashboard/PortfolioDetail read path | A wholly-renamed ticker (no natively-recorded fact under the new name) was never enumerated under its current name at all — protected from data loss only by the legacy-fallback safety net, but permanently mislabeled "not yet verified" | `canonicalHoldings.test.ts` |
| 5 | `evidenceGraph.ts`: `buildEvidenceGraph` | `evidenceIntelligence.ts`'s corroborates/contradicts edges | Same as #2, one layer down — the graph node itself, and every edge touching it | `evidenceGraph.test.ts` |
| 6 | `ledgerProjection.ts`: `ensureLegacyFactsExist` | `commitTicker`'s gap-backfill step | A renamed ticker's real, already-linked fact was never found under its new name, so this function re-appended one under the trade's own id sourced `"backfill"` — against the real Dexie repository (`.add`, throws on duplicate primary key) this is a caught, logged error that skips legacy projection for that commit; confirmed via a fake repository that upserts by id instead, reproducing a silent provenance downgrade to `"backfill"` under the same id | `ledgerProjection.test.ts` |

Finding #4 is the only one where the system's own defense-in-depth (the
legacy-fallback safety net `canonicalHoldings.ts`'s own doc comment
describes) prevented outright data loss; finding #6 is the only one where
production's actual repository implementation (`.add`'s duplicate-key throw)
converts what would otherwise be silent corruption into a caught, logged,
self-healing failure. Both are still real, fixed, and tested — the point of
defense-in-depth is redundancy, not an excuse to leave a layer broken.

**Every fix follows the same shape**: resolve `resolveCurrentTicker(all, txn)`
before grouping/filtering/labeling by ticker, falling back to the raw field
only when no Correction exists. All six of the new regression tests
constructed the identical scenario — a fact renamed via a `Correction`
fact, with a second fact recorded natively under the new name — and were
each independently confirmed fail-before/pass-after by stashing its own fix
and re-running.

**Reviewed and confirmed NOT this bug class** (raw `.ticker` reads that are
safe): `PortfolioService.ts` (normalizing fresh user input at record time,
not grouping existing facts); `systemValidation.ts`, `backfillRawTransactions.ts`,
`duplicateDetection.ts` (`Trade`/`TradeAllocation`/`TimelineEvent.ticker` —
legacy tables `TradeService.renameTickerEverywhere` mutates directly, always
current); `evidenceCoverage.ts` (per-upload document classification, a
narrower question); `ledgerProjection.ts`'s own sell-side backfill loop
(consumes the same `liveSellFactsByKey` map fixed in #6, no separate fix
needed); `toCandidateSource`, duplicated between `ledgerEngine.ts` and
`verificationEngine.ts` (a type-narrowing adapter, not a policy or identity
decision).

**Evidence**: 6 new regression tests (one per finding above), each
confirmed fail-before/pass-after independently. Full suite 977/977 green
(970 baseline for this pass + 6 new + 1 from the §9 pass counted once),
`tsc --noEmit` clean, `arch:check` clean (2512 modules, zero dependency
violations).

### Final certification: five questions, answered with evidence

**1. Can two modules still make different trust decisions from identical inputs? NO.**
`evidenceAuthority.ts`'s `authorityRank`/`higherAuthority` is the sole field-value-authority implementation (§2); every caller (`lotManager.ts`'s
provenance-adoption check, `evidenceIntelligence.ts`'s strongest-evidence
reduce, `canonicalTransaction.ts`'s fee/tax fold) calls it directly, never
reimplements it — confirmed by grep, all call sites read in full this
session.

**2. Can two modules still make different verification decisions from identical inputs? NO**, with one documented, deliberate exception that is a *scope*
difference, not drift: `checkTickerMatch` is the sole existence/trust-gate
implementation (§3); every real caller (`ImportPage.tsx`, `verificationEngine.ts`,
`ledgerRebuild.ts`, `reconciliation.ts`) delegates the DECISION to it. What
legitimately differs between callers is which DATA they feed it — a
still-pending import batch vs. an already-committed ticker's full history —
which is the correct, intentional design (§1), not two implementations of
the same question.

**3. Can one ticker still be interpreted differently by different subsystems? NO, as of this session's six fixes.**
Before this pass, six modules independently derived "which facts belong to
this ticker" from the raw, immutable ticker field instead of
`resolveCurrentTicker` — a real, demonstrated way for a renamed ticker to be
interpreted differently by `commitEngine.ts` vs. `evidenceIntelligence.ts`
vs. `canonicalHoldings.ts` vs. `ledgerProjection.ts` simultaneously. All six
are fixed and regression-tested with the identical rename scenario.

**4. Can Official Broker Excel still receive different treatment in different modules? NO.**
`isTickerFullyExcelSourced` (§8) is now the sole "exempt even from a
disagreeing screenshot" predicate; its three real callers
(`reconcilePositions`, `PortfolioDetailPage.tsx`, `ImportPage.tsx`'s
zero-pending branch) all use it, each with a passing regression test proving
an Invoice-only ticker (which does NOT get this exemption) is treated
differently from a literal-Excel ticker (which does).

**5. Can Policy Drift of this architectural class still exist? Answered honestly, not just "no":**
this session ran four full repository search passes (raw ticker-field
reads, `authorityRank`/source-literal comparisons, independent verdict
recomputation, and a final adversarial sweep for copy/paste/wrapper
patterns) and fixed every instance found, each with an independently
verified fail-before/pass-after regression test. That is real, concrete
evidence for every module actually inspected — all of `src/application`'s
service layer and the `src/presentation` pages that consume it. It is not a
mathematical proof that zero instances exist in code never touched by any
of these greps (a codebase of 2512 modules cannot be manually re-read line
by line in one session) — claiming that would be overclaiming, not
certifying. The honest, evidence-backed answer: no remaining instance was
found despite genuinely trying to find one, across every call site this
session could enumerate and test.

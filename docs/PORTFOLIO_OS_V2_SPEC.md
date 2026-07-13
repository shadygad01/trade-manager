# Portfolio OS v2 — Architecture Specification

**Status: SPECIFICATION ONLY. No implementation in this document or this change.**
Per the program's Final Rule, this document ends the architectural-redesign task. Implementation is a
separate, future effort that begins only after this spec is explicitly approved, PR by PR (Part 9).

**Roles applied while producing this document**: Chief Software Architect (Parts 1–7), Principal
Reviewer (Part 8, Self-Review), Independent Challenger (Part 8, Adversarial Scenarios), Migration
Planner (Part 9), Production Certifier (Part 11). Each section was re-read from the next role's
adversarial stance before being finalized; where that review found a gap, the earlier section was
revised in place rather than left standing — the corrections are visible inline as "found in review."

---

## Preface — the one finding that shapes everything below

Before designing anything, Part 0 reverse-engineers the current system. The headline finding:

**Portfolio OS already independently designed and partially built almost exactly the architecture this
program asks for.** `docs/ROADMAP.md`'s "Architecture Foundation" entry (line 1098) states the goal in
nearly the same words as this program's mission: *"an append-only raw-transaction fact log as the sole
source of truth, with every read model... derived fresh by pure engines and materialized by one atomic
Commit Engine."* Nine migration phases were built on that goal: `RawTransaction` (an immutable,
append-only fact type — corrections and retractions are new facts, never mutations), a Verification
Engine, a Ledger Engine, an Allocation Engine, a Holdings Engine, and a Commit Engine that ties them
together. This is real, tested (964 tests as of the latest sprint), and running in production today.

**It stopped mid-migration**, deliberately, as "strictly additive... dual-written shadow data" — and
then a second wave of sprints ("Production read cutover", "Phase 9.8") cut over *some* but not *all* of
the UI to read from it, leaving the system in a state its own roadmap describes exactly: some pages read
the new architecture, some still read the old one, and the two writers of the legacy tables
(`TradeService.recordBuy`/`recordSell` writing directly, and `commitTicker`'s `projectLegacyTicker`
re-deriving the same rows from facts) are coupled but not unified.

**Every one of the ~18 named historical incidents in `docs/ROADMAP.md`'s last 20 sprints — the ABUK,
ADPC, CLHO, ACAMD, ORWE, and SKPC bugs — is a symptom of that incompleteness, not of a wrong foundational
design.** The repo-wide audit at `ROADMAP.md:1816` (reproduced in Part 0.7) independently arrived at
almost the exact same taxonomy of failure this program's Phase 7/8 asks for: hidden state, coarse keys
reused as identity, opt-in instead of structural serialization, duplicate policy implementations. It even
used the same methodology this spec's Phase 8 uses — replay named historical incidents, then grep the
whole codebase for the same shape of bug.

**Conclusion, stated up front so it isn't buried**: v2 is not a rewrite. Optimizing for "the simplest
architecture that guarantees" the program's ten properties means *finishing the migration this codebase
already started*, converting every invariant its own bug history proves is enforced only by convention
into one enforced by structure (types, a single pipeline, machine-checked rules) — not designing a new
fact store, a new replay engine, or a new domain model from a blank page. Where this spec does propose
something genuinely new (Part 6, the Guardian pipeline; Part 3, a single Policy module), it is sized to
close a specific, named, already-occurred class of bug — never speculative.

---

## Part 0 — Architecture Baseline Report

### 0.1 Current modules

| Layer | Module | Role |
|---|---|---|
| Domain | `RawTransaction.ts` | The fact type. Append-only; kinds include `BuyExecution`, `SellExecution`, `SellAllocationDecision`, `PositionVerificationCapture`, `OrderEvidenceCapture`, `DividendPayment`, `CashAdjustment`, `Deposit`, `Withdrawal`, `CashReset`, `CorporateAction`, `Note`, `PortfolioAssignment`, `Correction`, `Retraction`, `CancelledOrder`. |
| Domain | `Trade.ts` / `TradeAllocation.ts` | The legacy, directly-mutable-by-convention ledger — one row per Buy lot / per Sell-closes-lot. |
| Domain | `LedgerEvent.ts` (not persisted) / `Allocation.ts` (not persisted) | The canonical architecture's pure replay output types — `LotOpenedEvent`/`SellRecordedEvent`, and per-lot `Allocation`. |
| Domain | `Portfolio.ts`, `PositionVerification.ts`, `Upload.ts`, `PendingExecution.ts`, `JournalEntry.ts`, `TimelineEvent.ts` | Container, ground-truth snapshot, evidence-document record, unconfirmed-partial-fill holding area, narrative notes, UI timeline feed. |
| Application | `commitEngine.ts` | The only writer of `ledgerCache`/`allocationsCache`; reactively triggered on every fact append; also the only trigger of `projectLegacyTicker`. |
| Application | `ledgerEngine.ts`, `allocationEngine.ts`, `holdingsEngine.ts` | Pure functions: facts → `LedgerEvent[]` → `Allocation[]` → `Holding[]`. |
| Application | `ledgerProjection.ts` | Rewrites legacy `Trade`/`TradeAllocation` from the canonical replay output. |
| Application | `ledgerRebuild.ts` | A **second, independent** reconstruction path from `Upload.candidates` (not `RawTransaction`), diffed against legacy tables; UI-reachable via `RebuildLedgerPanel.tsx`. |
| Application | `canonicalHoldings.ts` | Per-read hybrid: computes both legacy and canonical holdings, reconciles, falls back on disagreement. |
| Application | `verificationEngine.ts`, `completenessEngine.ts`, `evidenceGraph.ts`, `evidenceAuthority.ts`, `evidenceIntelligence.ts` | The trust/verification/corroboration logic — see Part 0.5. |
| Application | `reconciliation.ts`, `duplicateDetection.ts`, `mismatchResolver.ts`, `orderEvidence.ts`, `netShareTimeline.ts` | Read-only diagnostics against `PositionVerification`/candidate pools. |
| Application | `provenanceRepair.ts`, `systemValidation.ts` | Manual-trigger repair tool; dormant validation tool (no UI caller). |
| Application | `pendingExecutions.ts`, `importRecording.ts`, `backfillRawTransactions.ts`, `rawTransactionFolds.ts` | Fact lifecycle helpers. |
| Application | `TradeService.ts`, `PortfolioService.ts`, `BackupService.ts` | The legacy use-case layer; primary write path for the UI. |
| Infrastructure | Dexie repositories (one per domain entity + `RawTransactionRepository`, `CommittedLedgerRepository`) | 12 tables; see Part 0.2 for the ones relevant to write-path analysis. |
| Infrastructure | OCR pipeline (`ImportOrchestrator.ts` + parsers), STES workbook importer | Multiple document formats converging on one `ParsedTradeCandidate`/`ParsedDividendCandidate` shape. |

### 0.2 Current write paths (the load-bearing finding)

**`RawTransaction` is genuinely append-only**, enforced structurally: `RawTransactionRepository`'s
interface exposes only `getAll/getByPortfolio/getByTicker/getById/append` — no `update`, no `delete`.
`DexieRawTransactionRepository.append()` calls Dexie `.add()`, never `.put()`. The one disclosed
exception is `purge.ts`'s `bulkDelete`, wired only to explicit user "reset" actions, and it walks
`supersedes` chains to a fixpoint so no orphan rows survive.

**`Trade`/`TradeAllocation` have two writers, coupled but not unified:**

1. `TradeService.recordBuy`/`recordSell` — the actual, synchronous write every UI action depends on
   (manual entry, Import's per-row commit, Smart Allocate, Lot Manager, pending-execution confirmation).
   Writes `Trade`/`TradeAllocation` directly via `repos.trades.save`/`repos.allocations.save`, **then**
   writes a `RawTransaction` fact as a non-fatal "shadow write" (`ensureBuyFact`/`ensureSellFacts`) that
   can fail silently without failing the caller's operation.
2. `commitEngine.commitTicker`'s `projectLegacyTicker` step — an asynchronous, reactive rewrite of the
   *same* `Trade`/`TradeAllocation` rows, derived fresh from the fact log every time a ticker's
   verification reaches a terminal verdict. It is a full delete-and-replace for `(portfolioId, ticker)`.

This means the fact log is not actually the write gateway today — it is a **second, initially-optional**
system that a separate synchronous write feeds and that later, asynchronously, corrects the very rows
that write already made. The direction the program's Fact Model demands (facts in → derived state out)
is present, but inverted in practice: the *derived* state (`Trade`/`TradeAllocation`) is written first,
authoritatively, and the *fact* is written second, non-fatally.

**Holdings/positions have three computations**, not one: `TradeService.computePositions` (legacy, reads
`Trade` directly), `holdingsEngine.computeHoldings` (canonical, reads `ledgerCache`), and
`canonicalHoldings.computeCanonicalPositions` (hybrid — computes both, serves canonical on agreement,
falls back to legacy on disagreement or "canonical has nothing yet"). Three presentation pages
(`DashboardPage`, `PortfolioDetailPage`, `PortfoliosPage`) call the hybrid; three more
(`TradesPage`, `SellAllocationForm`, `lotManager.ts`/`mismatchResolver.ts`) read `repos.trades` directly,
bypassing all three functions, because they need entity CRUD / lot-picking, not a read-only projection.

**Cash is a directly-mutated field on `Portfolio`**, written by `recordBuy`, `recordSell`,
`recordDividend`, `recordCashAdjustment`, `moveTrade`, deposit/withdrawal actions — not yet a replay
projection, though `Deposit`/`Withdrawal`/`CashAdjustment`/`CashReset` fact kinds already exist in the
domain model for exactly this purpose (per ROADMAP's "cash fact-writing was added" note) and are
partially, not fully, wired in.

**Ticker rename physically mutates historical rows.** `TradeService.renameTickerEverywhere` updates the
ticker (and re-derives `companyName`/`sector`) directly on every already-recorded `Trade`,
`TradeAllocation`, `TimelineEvent`, and `PositionVerification` row that carried the old ticker. This is
the one place in the entire system where an already-recorded, user-facing record is mutated in place
rather than corrected via a new fact — even though `RawTransaction`'s own `CorrectionPayload` already has
a `ticker` field in its patch shape, unused by this call site. It is a real violation of "immutable
facts," found by this Phase 0 review, not carried in from the discovery agent's report.

### 0.3 Current read paths

Reads split along the same fault line as writes: `DashboardPage`/`PortfolioDetailPage`/`PortfoliosPage`
read the canonical-with-fallback holdings view; `TradesPage`/`SellAllocationForm`/`ImportPage`'s Smart
Allocate/Lot Manager read `Trade`/`TradeAllocation` directly; `ImportPage`'s own verification banners
re-derive several of the same signals `verificationEngine.ts` already computes (`checkTickerMatch` is
called directly by both), described in `docs/VERIFICATION_ENGINE.md` as "ImportPage.tsx still reads from
the legacy path... was not touched."

### 0.4 Current ownership

See the full matrix in Part 5. Headline violations: `Trade`/`TradeAllocation` (2 writers), `Portfolio.cash`
(N writers, no projection yet), Holdings (3 computations), ticker/company-name/sector-on-Trade (mutated
by two different mechanisms depending on call path).

### 0.5 Current policy locations and trust hierarchy

One real policy module exists today and is correctly singular: `evidenceAuthority.ts`'s `authorityRank`
— `invoice (6) > official-broker-excel (5) > statement (4) > orders-screen (3) > orders-timeline (2) >
{csv, notification, email, screenshot, other-document} (1) > {manual, backfill} (0)`, with
`position-verification` deliberately unranked (it answers a different question — current unit count, not
execution-field authority). This ladder is well-documented, tested, and the *only* implementation.

But policy **duplication** exists elsewhere: `constraintValidation.ts` independently re-derives an
inventory check that `checkTickerMatch` already computes; `ledgerRebuild.ts`'s `diffHoldings` computed
its own trust exemption independently of Import's `checkTickerMatch` until they were explicitly unified
(ROADMAP:1449); `ImportPage.tsx` recomputes several `verificationEngine.ts` signals itself rather than
consuming `verifyAllDetailed`'s completed contract. This is the "Policy Drift" the program's mission
statement names directly — not hypothetical, already occurred, already caused a real bug (two systems
disagreeing about the same ticker's trust status).

### 0.6 Current replay paths, derived state, hidden state

A genuine, working replay pipeline exists: `generateLedgerEvents` + `generateAllocations` +
`computeHoldings`, pure functions over `RawTransaction[]`, exercised on every `commitTicker` call — "there
is no separate rebuild command; `commitTicker` IS the rebuild" (commitEngine.ts's own doc comment). It is
proven end-to-end by `excelWorkflowEndToEnd.test.ts` and the Phase 9.8 "a missing historical Buy
discovered by a later import materializes as a real Trade row, no manual entry, no reset" test.

A **second**, unrelated "rebuild" exists (`ledgerRebuild.ts`), reconstructing from `Upload.candidates`
rather than `RawTransaction` — a genuine naming collision and a second replay source of truth, reachable
from `DataPage.tsx`'s `RebuildLedgerPanel`.

Derived/cached state: `ledgerCache`/`allocationsCache` (materializations of `LedgerEvent[]`/`Allocation[]`,
correctly full-replace-only, never incrementally patched — this is the one caching discipline the
codebase gets right everywhere, including the deliberate decision *not* to persist the Evidence Graph
because "anything cheaply and correctly derivable... must be regenerated fresh on every read, never
cached as a second source of truth that can silently drift," per `docs/EVIDENCE_ARCHITECTURE.md`).

Hidden state: `Portfolio.cash` (mutated directly, not yet visible as a fact-derived number anywhere);
`Trade.remainingShares` (mutated via `saveRemainingShares`, not always traceable to the specific
allocation that changed it without cross-referencing `TradeAllocation` rows separately).

### 0.7 Historical bug classes (from `docs/ROADMAP.md` + the discovery agent's git-log trace)

| Class | Instances | Root cause shape |
|---|---|---|
| Coarse dedup/grouping key reused as identity | `pendingCandidateSignature` → `sourceUploadIds` (ABUK/ADPC, most severe — misattributed Sell allocations); `canonicalKey` in `buildCanonicalTransactions` (would silently merge two real executions); `canonicalKey` in `retractMatchingRawTransaction` (deleting one trade retracted a sibling's real fact); `pendingCandidateSignature` donor search in `corroboratingSource` (false corroboration badges); 3 duplicated `legacy:date\|price` composite keys | A signature designed for **corroboration matching** (deliberately coarse, cross-document) gets reused somewhere else as an **identity or alias lookup** (must be exact), with no time/value tiebreaker |
| Multiple writers / non-atomic multi-step commit | `commitTicker`'s missing try/catch on one step aborted the whole calling operation on a transient Dexie `BulkError`, stranding rows mid-write | A read-decide-write-project sequence spanning multiple `await`s, not wrapped as one transaction |
| Opt-in instead of structural serialization | `serialize.ts`'s per-`(portfolio,ticker)` lock adopted piecemeal across ~6 separate call sites over several sprints, each found only by live reproduction after prior "closed" audits | Every new write-path caller must remember to join the lock by convention; nothing enforces it at compile time |
| No authority-aware conflict resolution | ABUK Buy-side: exact-duplicate auto-skip always retracted the *newly extracted* candidate regardless of which side had higher evidence authority | "Last/first write wins" instead of consulting the one real policy module that already existed |
| Ordering dependency within one logical operation | ABUK/HRHO: an upgraded fact didn't inherit the retracted fact's portfolio assignment before the retraction's own commit ran, so the real Trade got deleted as "stale" | Multiple facts belonging to one logical operation, written/committed non-atomically |
| Time-blind fallback on unnormalized data | ACAMD: `"12:51PM"` vs `"12:51"` compared without format normalization, always reporting a false conflict | String comparison on heterogeneous formats instead of normalized values |
| Coarse equality instead of ranked comparison | ACAMD: `isTickerFullyOfficialBrokerExcelSourced` required an exact string match to `"official-broker-excel"`, rejecting a strictly-higher-authority `"invoice"` source | Using `===` against a specific policy tier instead of `authorityRank(a) >= authorityRank(b)` |
| Race / reads a concurrent writer is mid-mutating | ARCC/CLHO: an auto-skip effect observed its own commit's intermediate `Trade` write via live Dexie reactivity and retracted the fact that commit was still writing | Reactive `useLiveQuery` state with no readiness/reentrancy gate |
| Schema/maintenance-list drift | `pendingExecutions` table missing from `purge.ts`'s table list — orphaned rows survived a "Reset All Data" | A new persisted table not added to every place enumerating "all tables" |

**The overarching pattern, stated by the codebase's own final audit** (`ROADMAP.md:1816`): nearly every
recurrence was correctly root-caused and fixed at the specific colliding call sites found — but the
underlying properties ("provenance-adoption discipline," "coarse-key-never-used-as-identity," "every
commit-triggering write joins the same serialization queue") were enforced only by convention, never by
a compiler or a structural rule, until a repo-wide *pattern-search* audit (not ticker-by-ticker
debugging) closed the whole class at once. **This is the single most important fact this baseline report
surfaces**: the fix that actually worked, twice, was a systematic grep-every-instance audit — which is
exactly the exercise a *type system and a single pipeline* can make permanent instead of needing to be
re-run by hand every few sprints.

### 0.8 Current coupling and technical debt

- `ledgerEngine.ts` imports `canonicalizeTradeEntries`/`canonicalKey` from `ledgerRebuild.ts` — the only
  real coupling between the two unrelated "ledger" systems, and it's a load-bearing import, not incidental.
- `verificationEngine.ts` and `commitEngine.ts` both independently used to depend on `isRetracted` from
  each other before it was extracted to a shared leaf module (`rawTransactionFolds.ts`) — already fixed,
  cited here as evidence the "single leaf dependency, no sideways imports" discipline is achievable and
  has precedent.
- Six-plus places call `TradeService.recordBuy`/`recordSell` directly, each independently responsible for
  joining `serialize.ts`'s lock — no single choke point.

---

## Part 1 — Domain Model

For every entity: purpose, lifecycle, owner, relationships, mutability, canonical identifier. Existing
code names are kept unless a rename is specifically justified (see Part 14 — cosmetic renames are
explicitly rejected as churn).

| Entity (v2 name) | Existing code | Purpose | Lifecycle | Owner | Mutability | Canonical ID |
|---|---|---|---|---|---|---|
| **Fact** | `RawTransaction` | The one true record that something was observed or decided | Append once; corrected/retracted by later Facts | The **Fact Store** (Part 2) — sole writer | Immutable | `id` (author-assigned UUID); ordered by repository-assigned `seq` |
| **Execution** | `BuyExecutionPayload` / `SellExecutionPayload` | One Buy or Sell as printed in one source document, or manually entered | Created once as a Fact; superseded by `Correction`/`Retraction` Facts | Fact Store | Immutable (payload); current view = fold of supersede chain | The Fact's own `id` |
| **Evidence / Document** | `Upload` | The permanently-archived source document (file hash + bytes) an Execution/Verification Fact was extracted from | Created on file import; never edited | Fact Store (via `sourceUploadId` on Facts) | Immutable | `id`; deduped by `fileHash` |
| **Lot** | `Trade` (legacy) / `LotOpenedEvent` (canonical) | One Buy's remaining, allocatable shares | Opened by a `BuyExecution` Fact; shrinks only via replayed `Allocation`s; never edited directly | **Replay** — v2 has exactly one Lot read model, generated only by replay, never hand-written | Derived (regenerated on every replay), never independently persisted as user-editable state | Deterministic `eventId` derived from the originating Fact — never a value-derived canonical key reused across two different Lots (Part 4) |
| **Allocation** | `TradeAllocation` (legacy) / `Allocation` (canonical) | Shares of one specific Lot closed by one specific Sell | Created by replaying an explicit `SellAllocationDecision` Fact — never inferred (ADR-002 stays load-bearing in v2) | Replay | Derived | Deterministic id from the `(sellExecutionId, lotRef)` pair the decision Fact names |
| **Holding** | `computePositions` / `computeHoldings` / `computeCanonicalPositions` outputs | Current position in a ticker within a portfolio | Recomputed on every read | Replay | Derived, never persisted | `(portfolioId, ticker)` |
| **Verification / Verdict** | `TransactionVerification` (`verificationEngine.ts`) | Trust judgment for one Execution Fact given the current total evidence set | Recomputed whenever the evidence set changes | Product Policy (Part 3) | Derived, never persisted as authoritative — see 0.6's discussion of why the Evidence Graph is deliberately not cached | `(factId)` |
| **Portfolio** | `Portfolio` | A named container investors organize trades into | Created/archived/unarchived by explicit user action | User action, mediated by the Guardian (Part 6) | `name`, `archivedAt` are the only genuinely mutable fields; `cash` becomes a replay projection in v2, not a stored field (Part 2.3) | `id` |
| **Corporate Action** | `CorporateActionPayload` (`Split`/`RightsIssue`) | A broker-driven, non-trade event affecting a ticker | Recorded once as a Fact | Fact Store | Immutable | Fact `id` |
| **Rename** | *(new — currently `renameTickerEverywhere`'s direct mutation, a v2 gap; see 0.2)* | Correcting a misresolved ticker across every Fact that carries it | Recorded as one `Correction` Fact per affected source Fact, replayed like any other correction — **never a direct table mutation** | Fact Store + Replay | Every affected Fact stays immutable; only the *replayed view* shows the corrected ticker | Same as Correction |
| **Dividend** | `DividendPaymentPayload` | Cash received for holding a ticker as of its payout date | Recorded once as a Fact, dated to actual payout | Fact Store | Immutable | Fact `id` |
| **Statement / Invoice / Orders Screen / Notification / Email / Screenshot** | `RawTransactionSource` values | The document *type* an Execution Fact was extracted from — determines Trust Model authority (Part 3.1) | Set once at extraction | Fact Store | Immutable | N/A — a classification on the Fact, not its own entity |
| **Manual Entry** | `source: "manual"` | User-typed, no document behind it | Set once at entry | Fact Store | Immutable | N/A |
| **Correction** | `RawTransactionKind: "Correction"` | A field-level fix to an earlier Fact | Recorded as a new Fact pointing at `targetId` | Fact Store | Immutable itself | Fact `id` |
| **Retraction** | `RawTransactionKind: "Retraction"` | Voids an earlier Fact entirely | Recorded as a new Fact pointing at `targetId` | Fact Store | Immutable itself | Fact `id` |
| **PendingExecution** | `PendingExecution` | An Execution whose broker status ("partial fill") means it isn't a confirmed Lot yet | Created at import; confirmed (BUY → creates a Lot; SELL → still needs explicit allocation) exactly once | `pendingExecutions.ts`, invoked only by the Guardian | Mutated in place, once, by design (not a Fact — it's a workflow/queue item, not a business truth) | `id` |
| **Journal Entry** | `JournalEntry` | Reflective notes on a closed/open Lot | Created/edited freely by the user | `TradeService`/`ledgerProjection` cleanup | Fully user-editable (this is explicitly not a Fact — it's commentary, never replayed) | `id`, keyed by `tradeId`/Lot id |

**Deliberately not new entities**: the program's example list includes "Screenshot," "Statement,"
"Invoice," "Notification" as if they might be separate types. In this codebase they are correctly
already a closed enum (`RawTransactionSource`) on one Fact type, not separate entities — introducing
separate classes for them would be exactly the kind of unwarranted abstraction Part 14 rejects.

---

## Part 2 — Fact Model

### 2.1 What's already correct, kept as-is

- `RawTransaction` **is** the Fact Store's row type. Its immutability is enforced structurally (the
  repository interface has no `update`/`delete`), not by convention — this is the one part of the whole
  system where "structural, not conventional" already holds, and it should be the template for
  everything else in this spec, not replaced.
- Corrections and retractions as new Facts pointing at `targetId`/`supersedes`, with `seq` (not payload
  dates) as the only ordering signal for race detection — keep exactly as designed.
- `purge.ts`'s single, disclosed, structurally-isolated exception (direct Dexie access, not through the
  repository interface) for user-initiated full erasure — keep. Erasure-on-request is a distinct,
  legitimate operation from correction, and conflating them (e.g. by inventing a "hard delete" Fact kind)
  would blur that distinction for no benefit.

### 2.2 Gaps to close

1. **The Fact Store must become the *only* entry point for a Lot/Allocation/Holding to exist — not an
   optional shadow write.** Today `recordBuy`/`recordSell` write `Trade`/`TradeAllocation` first,
   directly, and the Fact second, non-fatally. V2 inverts this: **the only write is `append()` to the
   Fact Store** (inside the Guardian's transaction, Part 6); `Trade`/`TradeAllocation` (or their v2
   successor read-model tables) are populated *only* by replay, synchronously, as part of the same
   Guardian transaction — never as a separate later step, and never any other way.
2. **`renameTickerEverywhere` must become a batch of `Correction` Facts, not a direct multi-table
   mutation.** `CorrectionPayload.patch.ticker` already exists in the type for exactly this; it has never
   been used for this operation. This is the one place today where "Facts are append-only" is
   structurally true but "history is immutable" is violated in practice by a legacy write path that
   bypasses the Fact Store contract by writing to `Trade`/`TradeAllocation`/`TimelineEvent`/
   `PositionVerification` directly.
3. **Cash becomes a replayed projection**, sourced from `Deposit`/`Withdrawal`/`BuyExecution`/
   `SellExecution`/`CashAdjustment`/`CashReset` Facts — the fact kinds already exist; what's missing is
   making them the *only* determinant of `Portfolio.cash`, removing every direct field write.
4. **One Fact Store, one migration path for pre-existing data**: every row created under the legacy
   direct-write regime before this migration (including every historical `renameTickerEverywhere`
   mutation already applied) needs a one-time `source: "backfill"` Fact, exactly like the existing
   `ensureLegacyFactsExist` gap-backfill mechanism already does for missing Buy facts — reuse that
   mechanism, don't build a second one.

---

## Part 3 — Product Policy

### 3.1 Trust Model (the one already-correct policy, formalized as the template)

`evidenceAuthority.ts`'s `authorityRank` ladder is kept verbatim as the v2 Trust Model — it is
well-designed, disclosed its own limitations honestly (`MY_POSITION_EXCLUDED_REASON`, the "Email Invoice
vs. In-App Invoice" collapse), and is genuinely singular today. V2's job here is not to change it, but to
make it **the only place any trust judgment is made** — see 3.3.

### 3.2 The policy module (new, but scoped to close a named gap)

`src/application/policy/` — one module, pure functions, no repository access (facts and read-model state
are passed in, never fetched internally, so every function stays trivially unit-testable and the module
can never itself become a write path):

| Function | Replaces / consolidates | Currently duplicated at |
|---|---|---|
| `isAuthoritative(a, b)` | `evidenceAuthority.authorityRank`/`higherAuthority` | Already singular — wrapped, not duplicated, so nothing else can reimplement it |
| `trustDecision(fact, evidenceSet)` | The exact-duplicate auto-skip logic's authority check | `ImportPage.tsx`'s auto-skip effect (ROADMAP: ABUK Buy-side gap) |
| `verificationDecision(ticker, facts)` | `verifyAllDetailed` | Already mostly singular; policy module re-exports it so `ImportPage.tsx` has no reason left to re-derive |
| `requiresBrokerScreenshot(ticker, facts)` / `requiresOrdersHistory(...)` / `requiresCorroboration(...)` | `completenessEngine.ts`'s recovery-plan branches | Kept where they are; module re-exports as the named policy entry points the program's Phase 3 asks for |
| `isTickerFullyOfficialBrokerExcelSourced` | Its own current implementation | Fixed already (ACAMD rank-comparison bug) — moved here so `constraintValidation.ts` calls it instead of re-deriving its own inventory check |
| `resolveTicker(rawText)` | `ThndrParser.resolveTicker`'s exact/prefix/Levenshtein cascade | Currently embedded inside one parser; every `BrokerParser` implementation and the manual rename flow should call one shared resolver, not each parser (or the rename UI) reimplementing ticker matching |
| `resolveEvidence(factSet)` | `evidenceGraph.buildEvidenceGraph`'s corroborates/contradicts edge logic | Already correctly a pure view, not persisted — kept as-is, re-exported |

**Rule, made structural in PR3 (Part 9)**: no file outside `src/application/policy/` may implement a
trust/authority/completeness/ticker-resolution judgment — enforced by a `.dependency-cruiser.cjs` rule
flagging any application-layer file other than the policy module's own that defines a function matching
the name patterns of the repo-wide audit table in 0.7 (`*authority*`, `*trust*`, `*requires*`,
`*isTicker*Sourced*`) without importing it from policy. This directly targets the "duplicate policy
implementation" bug class (0.5) the same way the type-branding rule in Part 4 targets the "coarse key
reused as identity" class — a lint rule that makes the exact review the codebase's own final audit did by
hand permanent.

---

## Part 4 — Replay Design

### 4.1 The pipeline, kept

`generateLedgerEvents` (facts → `LedgerEvent[]`) → `generateAllocations` (facts + events → `Allocation[]`)
→ `computeHoldings`/`computeCash` (events + allocations → `Holding[]`/cash) is kept as the v2 replay
pipeline verbatim — it is pure, deterministic, ordered only by `seq`, and already proven correct by
`excelWorkflowEndToEnd.test.ts`. **Replay is always scoped to one `(portfolioId, ticker)` key** — this is
already true (`commitTicker`'s signature) and is kept because it directly bounds the cost of any single
replay to that ticker's own transaction count, not the whole ledger (see Part 13).

### 4.2 The one structural change: identity vs. grouping, made a type-level distinction

Part 0.7's dominant bug class — a coarse grouping/dedup signature (designed for cross-document
corroboration, deliberately time-and-value-blind) reused somewhere else as an identity or alias lookup —
recurred five times across four unrelated files before a repo-wide manual audit closed it. A manual audit
is not a structural guarantee; the next new call site can reintroduce the exact same bug, and the
project's own history shows it did, repeatedly, across unrelated modules.

**V2 introduces two distinct, non-interchangeable branded types:**

```ts
type EntityId = string & { readonly __brand: "EntityId" };        // a real Fact/Lot/Allocation id
type GroupingSignature = string & { readonly __brand: "GroupingSignature" }; // e.g. ticker|side|date|shares
```

Every function that currently returns a bare `string` for a `canonicalKey`/`pendingCandidateSignature`/
`legacy:${date}|${price}`-style composite is retyped to return `GroupingSignature`. Every place that
resolves a *specific* Fact/Lot/Allocation (`indexEventsByReference`'s `byRef` map, `resolveLotRef`,
`retractMatchingRawTransaction`'s `matches` filter) is retyped to key/compare on `EntityId` only. Because
`GroupingSignature` and `EntityId` are nominally distinct, passing one where the other is expected is a
**compile error**, not a runtime corruption discovered months later against a real user's ABUK data. This
converts the exact review the "repo-wide architectural audit" performed by hand (0.7) into something
`tsc` performs on every commit, permanently, including at every future call site not yet written.

### 4.3 Determinism guarantee

Replay output for a given `(portfolioId, ticker)` and a given ordered Fact set is a pure function of that
Fact set — no wall-clock reads, no random ids inside the pipeline (Lot/Allocation ids are derived
deterministically from the originating Fact's own `id`, never freshly generated during replay). This is
already true; v2 adds a property-based regression test (Part 9, PR7) asserting replaying the same Fact
set twice, in any Fact-Store-legal append order consistent with `seq`, produces byte-identical output —
directly testing the "Deterministic Replay" mission requirement, not just asserting it in prose.

---

## Part 5 — Ownership Matrix

| Field / Decision | Current owner(s) | Violation? | v2 owner |
|---|---|---|---|
| `RawTransaction` row existence | Fact Store (`append` only) | No | Unchanged |
| `Trade`/`TradeAllocation` (or v2 successor tables) content | `TradeService.recordBuy/recordSell` (direct) **and** `commitEngine.projectLegacyTicker` (derived) | **Yes — 2 writers** | Replay only (Part 2.2 #1); `recordBuy`/`recordSell` become Guardian-submitted mutations that write Facts, never tables |
| `Portfolio.cash` | `recordBuy`, `recordSell`, `recordDividend`, `recordCashAdjustment`, `moveTrade`, deposit/withdraw actions (all direct) | **Yes — N writers, no projection yet** | Replay only, from cash-affecting Facts (Part 2.2 #3) |
| Current Holding/position | `computePositions`, `computeHoldings`, `computeCanonicalPositions` | **Yes — 3 computations** | One function only (Part 9, PR5) |
| Ticker/companyName/sector on a historical row | `renameTickerEverywhere` (direct mutation) **and**, separately, any Correction-Fact path | **Yes — 2 mechanisms for one decision** | Correction Facts + replay only (Part 2.2 #2) |
| Trust/authority judgment | `evidenceAuthority.ts` | No | Unchanged, but every consumer must import it (Part 3) |
| Verification verdict | `verifyAllDetailed` | Mostly no, but consumed inconsistently — `ImportPage.tsx` re-derives some of the same signals | Policy module wraps it; `ImportPage.tsx`'s re-derivations are deleted (Part 9, PR3) |
| Inventory/completeness judgment | `constraintValidation.ts` (own logic) vs. `checkTickerMatch` | **Yes — duplicate implementations** | Single policy function (Part 3.2) |
| `JournalEntry` deletion | `TradeService.deleteTrade` (direct) **and** `ledgerProjection`'s stale-row cleanup | Minor — same intent, two triggers | Kept as two triggers (this one is benign: both delete the same row for the same reason, neither disagrees with the other) but flagged for a follow-up audit, not blocking v2 |
| `PendingExecution` lifecycle | `pendingExecutions.ts` exclusively | No | Unchanged, wrapped by Guardian |
| Fact Store write | `RawTransactionRepository.append` exclusively, plus `purge.ts`'s disclosed exception | No | Unchanged |

**Every "Yes" row above is a Phase-5-mandated violation report, not a hypothetical** — each is the direct
cause of at least one named incident in Part 0.7 or Part 8.1.

---

## Part 6 — Guardian Design

### 6.1 The pipeline

One function, `executeMutation(mutation)`, becomes the **only** way any UI action reaches storage —
replacing today's dozen independent call sites (`recordBuy`, `recordSell`, `deleteTrade`,
`renameTickerEverywhere`, `importRecording.recordImportedRawTransactions`, `commitEngine.assignPortfolio`,
`provenanceRepair.applyProvenanceRepair`, `ledgerRebuild.applyLedgerRebuild`, `pendingExecutions`'s
confirm/complete functions):

```
Validate            — schema + business-rule precheck (e.g. ADR-002: a sell mutation must name real,
                       currently-open lot refs; STES row-shape validation)
     ↓
Create Facts         — append one or more RawTransactions, inside one Dexie transaction
     ↓
Replay               — regenerate LedgerEvents/Allocations/Holdings/Cash for every (portfolioId, ticker)
                       key the new Facts touch (Part 4.1) — scoped, not whole-ledger
     ↓
Invariant Validation — shares never negative, cost basis reconciles, cash never negative unless an
                       explicit overdraft-permitting Fact justifies it (systemValidation.ts's existing
                       checks, promoted from dormant/test-only to load-bearing, on every mutation)
     ↓
Policy Validation    — trustDecision/verificationDecision (Part 3) must agree with what's about to commit
     ↓
Identity Validation  — every EntityId reference in the new Facts/replay output resolves to exactly one
                       real Fact — a GroupingSignature collision alone is never sufficient (Part 4.2)
     ↓
Commit               — the Facts + replay output are the SAME Dexie transaction; nothing partially lands
Else
Rollback             — the whole transaction aborts; nothing is written, not even the Facts
```

### 6.2 Why this specifically closes the two most-repeated bug classes

- **The "missing try/catch on one commit step aborted the whole operation" bug (0.7)** is closed because
  there is only one transaction boundary, not a sequence of independently-awaited steps with inconsistent
  error handling at each one.
- **The "opt-in serialization" bug (0.7)** is closed because `executeMutation` acquires the
  `(portfolioId, ticker)` lock (reusing `serialize.ts`'s existing, already-proven primitive — Part 14
  explicitly rejects inventing a new concurrency mechanism) *inside* itself, once, structurally — no
  caller can forget to join the queue because no caller ever touches storage without going through it.

### 6.3 A named risk this design must not reintroduce

Found in the Principal-Reviewer pass over this section (Part 7 applied early, in place): `commitTicker`
is today called recursively from within `recordBuy`'s own call chain (Q2 of the discovery report). If
`executeMutation` naively wraps the *outer* call in the lock and `commitTicker`'s replay step is itself
reimplemented as a nested `executeMutation` call, that's a deadlock on the same `(portfolioId, ticker)`
key. **Resolution**: `executeMutation` is the only *externally callable* entry point; the internal
Validate→Facts→Replay→...→Commit sequence is one flat function body, not a chain of nested
`executeMutation` calls — replay is invoked as a plain function call inside the same lock scope, never as
a second lock acquisition. This is called out explicitly in the PR3/PR4 migration notes (Part 9) so it
isn't rediscovered the hard way during implementation.

---

## Part 7 — Self Review (Principal Reviewer pass)

Reviewing Parts 1–6 independently, adversarially, before proceeding — per the program's instruction not
to trust prior conclusions without re-verification.

- **Hidden state?** `PendingExecution` is deliberately *not* a Fact (Part 1) — is that itself hidden
  state? No: its existence and every transition are visible reads, it's excluded from every
  Holdings/replay computation by construction (not by a status flag that could be forgotten), and it maps
  to a real, disclosed business concept (an execution the broker itself hasn't confirmed yet) rather than
  an implementation-detail cache. Kept as a non-Fact by design, not an oversight.
- **Multiple writers?** Re-checked Part 5's matrix against the discovery report's Q3–Q9 a second time —
  no additional writer pairs found beyond what's already listed. `JournalEntry`'s two deletion triggers
  were flagged, deliberately not escalated to "must fix before v2" (see Part 5's own note) — both delete
  the identical row for the identical reason; treating this as equivalent in severity to the `Trade`/cash
  violations would dilute the spec's credibility on the ones that actually caused incidents.
- **Policy drift?** The lint rule in Part 3.2 only catches *new* duplicate implementations by name
  pattern; it cannot catch a differently-named function that duplicates policy logic without matching the
  pattern. This is a real, disclosed limitation — carried into Part 16 (Remaining Risks), not hidden.
- **Identity drift?** Part 4.2's branded types close the *found* instances. A function that constructs a
  `GroupingSignature` and then casts it to `EntityId` to satisfy the type checker would defeat the
  guarantee — this is a possible escape hatch, flagged in Part 16, mitigated by code review discipline
  (a cast to a branded type is a visible, greppable, rare pattern — far rarer and more visible than a bare
  string reused wrongly, which is what actually happened five times).
- **Replay drift?** Confirmed Part 4.3's determinism claim requires Lot/Allocation ids to never depend on
  wall-clock time or `Math.random()` during replay — verified against `ledgerEngine.ts`'s existing
  `toDirectEvent`/`canonicalizeTradeEntries` implementations, which already satisfy this. No change
  needed beyond the property test in PR7.
- **Temporal coupling / race conditions?** Part 6.3's deadlock finding is exactly this category, already
  corrected in place. Re-checked for a second instance: `assignPortfolioToFact`'s scoping fix (ORWE
  incident, 0.7) — confirmed the Guardian's per-`(portfolioId, ticker)` lock scope matches the scope that
  fix already established; no widening back to a ticker-wide lock is proposed anywhere in Part 6.

No findings required returning to Part 1. Proceeding to Part 8.

---

## Part 8 — Challenge (Independent Challenger pass)

### 8.1 Historical incidents, replayed against the v2 design

| Incident | v2 mechanism that prevents recurrence |
|---|---|
| SKPC closed-position trap (arithmetic zero trusted with no corroboration) | `trustDecision` (Part 3.2) is the only place this judgment is made — a future change to the "requires corroboration" rule updates every caller at once, and the policy module's own tests would need to explicitly assert a closed-position zero is untrusted, making the omission visible in a diff |
| CLHO (`ensureSellFacts` hardcoded `source: "manual"`, orphaning the real fact) | Guardian's Identity Validation step requires every `EntityId` reference to resolve to exactly one real Fact — a hardcoded wrong source no longer silently substitutes for adoption of the pre-existing fact |
| ACAMD ticker-resolution-through-Correction gap | `resolveTicker`/read helpers live in one policy module (3.2); a fix to "fold through Correction rows" is made once, and every caller (there is only one implementation to call) gets it |
| `pendingExecutions` missing from `purge.ts` | Not directly fixed by any Part 1–7 mechanism — genuinely a schema/maintenance-list gap, not an ownership or replay problem; flagged for a plain checklist/test ("every Dexie table appears in `purge.ts`'s table list") rather than a new architectural mechanism, since inventing one here would be solving a one-line-checklist problem with a subsystem |
| Rebuild Ledger vs. Import disagreement (two data models, two trust judgments) | PR6 (Part 9) retires `ledgerRebuild.ts`'s independent reconstruction once Guardian is the only write path — there is only one data model left to disagree with itself |
| ImportPage load race (`initialDataLoaded` omitted `rawTransactions`) | Not a Guardian-layer concern (it's a read-side React effect bug); flagged as a UI-layer discipline issue outside this spec's scope — noted in Part 16, not silently dropped |
| ARCC/CLHO auto-skip-observes-own-commit race | Guardian's single transaction means there is no "intermediate" state a concurrent reader can observe mid-write — the Facts and their replay output land atomically or not at all |
| ORWE ticker-wide-sweep race | Already fixed upstream (`assignPortfolioToFact`'s scoping) and re-verified compatible with Guardian's lock scope in Part 7 |
| ABUK Buy-side authority gap | `trustDecision` (3.2) is authority-aware by construction — an auto-skip decision *is* a policy-module call, not inline logic in `ImportPage.tsx` |
| ABUK/HRHO portfolio-assignment-lost-on-upgrade | Guardian's single-transaction Commit step means the upgrade-and-retract sequence either both happen or neither does — there's no window for `projectLegacyTicker` to run against a partially-updated fact set |
| Smart Allocate silent failure (`CandidateRow` swallowed errors) | UI-layer bug, not architectural — outside this spec's scope, noted for a separate UI-hardening pass |
| Commit-concurrency `BulkError` stranding rows | Directly closed by Part 6.1's single transaction boundary |
| ACAMD authority string-equality bug | `isAuthoritative` (3.2) is rank-comparison by construction, not string equality — the bug class (not just the instance) is closed |
| ACAMD time-format mismatch | Not directly closed by any structural mechanism above — normalizing time formats before comparison is a policy-module implementation detail (`trustDecision`'s internals), not something branding/ownership fixes; flagged honestly as "process discipline within the policy module," not solved by architecture alone |
| ABUK/ADPC coarse-key-as-identity (the dominant class) | Directly closed by Part 4.2's `EntityId`/`GroupingSignature` type branding — this is the one bug class this spec's replay design section exists specifically to close |
| Serialization gaps (6+ call sites) | Directly closed by Part 6.2 — one lock acquisition point, not per-caller opt-in |

### 8.2 Future scenarios

- **Ticker rename (ABUK-shaped)**: becomes a batch of `Correction` Facts (Part 2.2 #2) submitted through
  `executeMutation` as one mutation — either every affected Fact gets its correction or none do.
- **Split / Rights Issue**: recorded as a `CorporateAction` Fact, same as today — v2 deliberately keeps
  this **record-only** (no automatic share/price rebasing). `docs/DATA_MODEL.md` already scoped automatic
  rebasing out as speculative complexity; this spec agrees and does not reopen it (Part 15, Open
  Questions, revisits this only to confirm the decision, not to relitigate it).
- **Dividend**: unchanged — a `DividendPayment` Fact, dated to actual payout, already correctly modeled.
- **Merge (two tickers turn out to be one real position)**: not a currently-modeled operation. v2 treats
  it as a sequence of Corrections (both tickers' Facts corrected to the surviving ticker) — the same
  mechanism as rename, no new Fact kind needed.
- **Duplicate import / repeated import**: `duplicateDetection.ts`'s exact/possible-match logic is kept,
  now consulted via `trustDecision` instead of inline in `ImportPage.tsx` — an exact match is still
  auto-skipped, but the skip decision itself becomes a policy call subject to the same authority-awareness
  as everything else (closing the ABUK Buy-side gap class for *any* future duplicate scenario, not just
  the one instance already fixed).
- **Repeated confirm / repeated allocation**: `PendingExecution.confirmPendingExecution`'s existing
  guard (fires exactly once, throws on a second attempt) is kept; wrapped by `executeMutation` so the
  guard check and the resulting Fact writes are atomic with each other — today they're two separate
  awaited steps.
- **Undo**: v2 does not add a general undo/redo stack (Part 14 — explicitly rejected as scope creep).
  "Undo" is always a `Retraction` Fact through `executeMutation`, exactly like "delete" already is —
  no new mechanism, a naming/UX question at most.
- **Crash recovery / browser refresh mid-write**: because Facts + replay output land in one Dexie
  transaction, a crash mid-write leaves either the fully-prior state or nothing partial — there is no
  half-committed replay state to recover from. This is a direct, testable consequence of Part 6.1, not an
  aspiration.
- **OCR / Excel / Statement / manual entry**: all already converge on one `ParsedTradeCandidate`/
  `ParsedDividendCandidate` shape before reaching the Fact Store (confirmed in Part 0, `docs/OCR_SUBSYSTEM.md`,
  `docs/STANDARD_TRADING_EXCHANGE_SCHEMA.md`) — v2 changes nothing upstream of `importRecording.ts`; the
  only change is that `importRecording`'s Fact-append becomes an `executeMutation` call instead of a
  direct `rawTransactions.append`.
- **100k trades**: see Part 13 — replay is scoped per `(portfolioId, ticker)`, so a 100k-trade ledger
  spread across a realistic number of tickers doesn't make any single replay more expensive; the
  **untested** dimension is a single ticker with tens of thousands of rows, flagged as a Part 13 action
  item, not assumed safe.

**No scenario above required returning to Part 1.** The two genuine, disclosed gaps found in this pass
(time-format normalization discipline; the `purge.ts` maintenance-list checklist) are process/checklist
items, not architectural redesigns — carried forward to Part 16, not papered over.

---

## Part 9 — Migration Strategy / PR Roadmap

Distinct from `docs/ROADMAP.md`'s historical "Phase N" numbering (that log's Phases 1–9 already shipped
the foundation this spec builds on) — these are new PRs, numbered independently to avoid collision.

Every PR below is **additive-first**: the old path keeps running, flag-gated, until its replacement is
proven — the exact discipline `docs/ROADMAP.md`'s "Architecture Foundation" entry already named
("strictly additive... never breaking the existing app in between") and that has a 9-phase track record
of working in this specific codebase.

| PR | Scope | Independently deployable? | Reversible? |
|---|---|---|---|
| **PR1** | Structural fact-store enforcement: dependency-cruiser rule forbidding `.bulkDelete`/`.delete` on `rawTransactions` outside `purge.ts`; introduce `EntityId`/`GroupingSignature` branded types (Part 4.2) and retype existing `canonicalKey`/`pendingCandidateSignature`/composite-key functions | Yes — pure type-level + lint change, zero runtime behavior change | Yes — revert the types/lint rule |
| **PR2** | Cash-as-projection: implement the cash replay function from existing `Deposit`/`Withdrawal`/`BuyExecution`/`SellExecution`/`CashAdjustment`/`CashReset` Facts; run it in shadow (Part 10) alongside the current direct field for one full cycle before any read switches over | Yes | Yes — the direct field stays authoritative until explicitly cut over |
| **PR3** | Single Policy module (Part 3.2): extract `trustDecision`/`verificationDecision`/`isAuthoritative`/`resolveTicker`/etc.; migrate `constraintValidation.ts` and `ImportPage.tsx`'s re-derivations to call it; add the duplicate-policy lint rule | Yes | Yes — extraction is behavior-preserving by construction (ported, not rewritten, same discipline as the historical Verification Engine "contract completion" work) |
| **PR4** | Guardian pipeline (Part 6): introduce `executeMutation`; migrate write paths one at a time (`recordBuy` first — the highest-traffic path, proving the pattern before the rest follow), each behind its own flag, old direct-call path kept as fallback | One write-path migration per sub-PR, each independently deployable | Yes — flag flips back to the direct path per write-path, no data migration required to revert |
| **PR5** | Single Holdings/Position read model: port `TradesPage`/`SellAllocationForm`/`lotManager.ts`/`mismatchResolver.ts` off direct `repos.trades` reads onto the replay-derived view; retire `computePositions` and `computeCanonicalPositions`'s fallback branch | Yes, page by page | Yes per page |
| **PR6** | Legacy table retirement: once PR4/PR5 are fully cut over, `Trade`/`TradeAllocation` become pure read-model caches (or are merged into `ledgerCache`/`allocationsCache` if benchmarking, Part 13, shows no regression); retire `ledgerRebuild.ts`'s independent reconstruction (its only remaining job — historical backfill — is already covered by `backfillRawTransactions.ts`) | Only after PR4/PR5 are certified (Part 11) | Partially — table retirement is the one step in this roadmap that isn't trivially reversible once storage is actually dropped; kept as a distinct, late, explicitly-gated step for exactly that reason |
| **PR7** | Certification (Part 11): full historical-incident regression suite, determinism property test (Part 4.3), shadow-parity report, sign-off | N/A — a gate, not a code change | N/A |

---

## Part 10 — Shadow Deployment Plan

The codebase already runs a working instance of this pattern — `canonicalHoldings.computeCanonicalPositions`
dual-computes legacy and canonical holdings on every read and falls back on disagreement, tagging the
result with a `fallbackReason`. V2 generalizes this proven mechanism rather than inventing a new one:

1. For each PR in Part 9 that changes a *read* path (PR2 cash, PR5 holdings), the new computation runs
   alongside the old one on every real read, for every user, for a full trading week minimum (matching
   the price-snapshot cadence in `ADR-003` — a week covers weekday/weekend/holiday variation in EGX
   trading activity).
2. Every disagreement is logged with full input (the Fact set) and output (both computed values) — not
   just a boolean flag — extending `fallbackReason`'s existing shape into a generic `ShadowDivergence`
   record, either console-reported (matching this app's no-backend, no-telemetry-server constraint per
   ADR-001/ADR-005) or written to a dedicated local Dexie table the user can export via `BackupService`
   for review.
3. **No unexplained divergence is acceptable** (program mandate, taken literally): every logged
   divergence during the trial window must be traced to a specific, named cause before the new path is
   allowed to become authoritative — either a genuine bug in the new path (fix and restart the trial
   window) or a confirmed case where the old path was already wrong (documented, and the new path's
   correctness becomes the resolution, not a compromise).
4. Only after a full trial window with zero unexplained divergences does the read path flip — and the old
   computation stays in the codebase, running in shadow (logged, not served), for one further release as
   a safety net, exactly mirroring how `computeCanonicalPositions` still computes the legacy number today
   even when serving the canonical one.

---

## Part 11 — Certification

Certification for each PR (and for the program overall) requires all of:

1. **Full existing test suite green** (964+ tests as of the current baseline) plus every new Guardian/
   policy/branded-type test — no regression tolerated, matching this repo's own existing discipline
   (every cited historical fix in Part 0.7 shipped with a fail-before/pass-after regression test).
2. **Zero unexplained shadow divergence** over the full trial window (Part 10.3).
3. **The historical-bug regression suite passes** — every named incident in Part 8.1 encoded as a
   permanent test (several already exist per the cited test files; the remainder are added in PR7).
4. **`tsc --noEmit` and `npm run arch:check` clean**, including the new PR1/PR3 structural rules.
5. **A second, independent review pass** using the same grep-pattern methodology the codebase's own
   "repo-wide architectural audit" (`ROADMAP.md:1816`) used — searching for any remaining
   `GroupingSignature`-typed value flowing into an `EntityId`-typed parameter via a cast, and any
   trust/policy judgment implemented outside `src/application/policy/` that the PR3 lint rule's name-
   pattern matching didn't catch — finds nothing new after at least one full pass with zero findings.

**Attempting to disprove the design** (explicit instruction, taken seriously): the branded-type mechanism
(Part 4.2) can be defeated by an explicit unsafe cast; the policy-duplication lint rule (Part 3.2) can be
defeated by a differently-named function. Both are disclosed, not hidden, in Part 7 and Part 16 — this
spec does not claim either guarantee is unconditional, only that both convert a bug class that recurred
five-plus times under convention-only enforcement into one requiring a visible, greppable, reviewable
escape hatch to reintroduce, which is a materially different risk profile even though it isn't a
mathematical proof of impossibility.

**This document does not itself certify v2 for production** — no code has been written. Certification is
the exit criterion for PR7, not a claim made here.

---

## Part 12 — Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PR4's migration of `recordBuy`/`recordSell` (the highest-traffic write paths) introduces a regression | Medium — these are the most complex, most-patched functions in the codebase | High — affects every user action | Flag-gated per-write-path rollout (Part 9); shadow-mode parity (Part 10) before any flag flips |
| Guardian's single lock becomes a throughput bottleneck | Low at current data volumes (single-user, browser-local) | Low — a slower write is not a correctness risk in this product | Lock scope stays `(portfolioId, ticker)`, not global — already the narrowest scope the historical serialization fixes established |
| Historical `renameTickerEverywhere` mutations already applied to production data need a one-time backfill before Part 2.2 #2's invariant ("renames are always Corrections") holds retroactively | Medium — depends how many renames have actually occurred | Low — a backfill Fact is additive, doesn't change any currently-displayed value | Reuse `ensureLegacyFactsExist`'s existing gap-backfill pattern (Part 2.2 #4); audit before PR2 |
| Solo-maintainer bandwidth: PR1–PR7 is a multi-week program layered onto an already large, actively-used codebase | High — explicitly named in Part 16 | Medium — a paused migration is safe (every PR is additive/reversible), not catastrophic | Sequence PRs so each is independently valuable even if the program pauses after any one of them |
| Branded-type cast escape hatch (Part 7/11) reintroduces the coarse-key bug silently | Low — casts to a branded type are rare and visible in diff/review | Medium — same failure mode as the 5 historical instances if it happens | Certification's independent review pass (Part 11.5) specifically greps for this pattern |

---

## Part 13 — Performance Considerations

- Replay is scoped per `(portfolioId, ticker)` today and stays that way in v2 — cost is bounded by one
  ticker's own transaction count, not the ledger's total size. This already scales with the product's
  actual usage pattern (one retail investor's own portfolio — realistically hundreds to low thousands of
  trades, not a fund's book).
- `CommittedLedgerRepository.commitTicker` is a full delete-and-replace per key, not incremental — fine at
  current volumes, but **untested at the "single ticker with tens of thousands of rows" extreme** the
  program's Phase 8 asks about (100k trades). This is flagged, not assumed safe: PR7 (Part 9) adds a
  benchmark test at that scale before certification claims it's fine, rather than asserting it here
  without evidence.
- Guardian's single transaction per mutation adds one lock acquisition per write — negligible relative to
  the existing per-mutation cost (a commit already does a full ticker replay today).
- IndexedDB/Dexie is inherently single-tab-serialized within one browser profile (ADR-001's accepted
  scope — no multi-device concurrency to worry about), which is exactly the assumption the `(portfolioId,
  ticker)` lock scope already relies on; nothing in v2 changes that assumption or needs to.

---

## Part 14 — Simplifications

- **Not renaming `RawTransaction` to `Fact` in code.** The concept maps 1:1 already; renaming a
  269-line-doc-commented, heavily-tested, ~60-file-referenced type for naming purity alone is pure churn
  with zero behavior change — rejected. This spec uses "Fact" as the conceptual term throughout and
  "`RawTransaction`" when referring to the actual type, deliberately.
- **No general undo/redo stack.** Only the existing Retraction/Correction mechanism, routed through
  Guardian — a UI-level "Ctrl+Z" affordance is a product feature, not an architecture requirement, and is
  out of scope.
- **No new concurrency-control primitive.** Guardian reuses `serialize.ts`'s existing per-`(portfolio,
  ticker)` lock verbatim (Part 6.2) rather than inventing a queueing/actor/lock-free mechanism this
  single-tab, single-user, browser-local product has no need for.
- **No automatic Split/RightsIssue rebasing.** Already correctly scoped out by `docs/DATA_MODEL.md`;
  this spec confirms that decision (Part 8.2) rather than reopening it under the banner of "Corporate
  Action" modeling.
- **No portability abstraction for a future non-Dexie backend.** ADR-001 (no backend, ever, by explicit
  product requirement) means the Fact Store has exactly one implementation target; a repository-interface
  abstraction already exists for testability (in-memory fakes), which is sufficient — no additional
  storage-engine-agnostic layer is warranted.

---

## Part 15 — Removed Complexity

- Holdings computation: 3 functions → 1 (PR5).
- `Trade`/`TradeAllocation` writers: 2 → 1 (PR4/PR6).
- Ticker-rename mechanisms: 2 (direct mutation + ad hoc Correction usage) → 1 (Correction + replay only).
- Per-caller opt-in serialization (6+ independently-adopted call sites) → 1 structural lock inside
  Guardian.
- Duplicate policy implementations (`constraintValidation.ts`'s own inventory check, `ImportPage.tsx`'s
  re-derived verification signals) → 1 policy module.
- `ledgerRebuild.ts`'s entire independent Upload-based reconstruction path → deleted in PR6, once
  Guardian/replay is the only write path and nothing can drift from the Fact log for it to reconcile
  against; its one remaining legitimate job (one-time historical backfill) is already covered by
  `backfillRawTransactions.ts`.
- `systemValidation.ts` promoted from dormant/no-UI-caller (0.5) to load-bearing inside Guardian's
  Invariant Validation step (Part 6.1) — removes a maintained-but-unused module rather than leaving it to
  bit-rot.

---

## Part 16 — Remaining Risks

- **OCR/extraction quality is inherently probabilistic.** No architecture change eliminates a wrong Fact
  entering the system from a genuinely misread source document — v2's guarantee is that a wrong Fact is
  always *correctable* (via Correction/Retraction, replayed cleanly) rather than *silently corrupting*
  derived state, which is a materially different, achievable guarantee, not "no wrong data ever."
- **Time-format normalization discipline** (the ACAMD `"12:51PM"` vs `"12:51"` bug, Part 8.1) is not
  closed by any structural mechanism in this spec — it's an implementation-quality concern inside the
  policy module's internals, not an ownership/replay/identity problem. Flagged honestly rather than
  claimed solved.
- **The `purge.ts` table-list checklist gap** (Part 8.1) is a genuine, disclosed, unclosed risk class —
  every new persisted table must remember to add itself to that list. A test asserting "every table in
  the Dexie schema appears in `purge.ts`'s enumeration" closes this cheaply; recommended as a small,
  independent fix, not bundled into the PR roadmap's architectural work.
- **Branded-type escape hatch via explicit cast** (Part 7, Part 11) — disclosed, mitigated by review
  process, not eliminated by the type system alone.
- **Solo-maintainer bandwidth** for a 7-PR program on top of an already large, actively-shipping codebase
  — real, named in Part 12, mitigated by every PR being independently valuable and reversible so a pause
  after any single PR leaves the system strictly better off, never half-broken.
- **Total data loss if a user clears browser storage** — unchanged by v2, an accepted ADR-001 trade-off,
  mitigated only by `BackupService`'s existing manual export/import, same as today.

---

## Part 17 — Open Questions

1. **Should `Trade`/`TradeAllocation` be physically retired (PR6), or kept indefinitely as a cache table
   name for continuity?** Recommendation: keep as a cache short-term after PR5's read-cutover is proven;
   revisit physical retirement only once PR6's benchmark (Part 13) shows no regression from merging into
   `ledgerCache`/`allocationsCache` directly. Not blocking certification of PR1–PR5.
2. **Should Split/RightsIssue automatic rebasing be implemented as part of this program?** Recommendation:
   no — stays explicitly out of scope, per `docs/DATA_MODEL.md`'s existing, deliberate decision (Part 8.2
   confirms rather than reopens this).
3. **Is "Guardian" a class/object, or a single exported function?** Recommendation: a single
   `executeMutation()` function, not a class hierarchy — this codebase has no class-based application-layer
   code anywhere outside the Dexie repository adapters; a Guardian *class* would be the one genuinely new
   architectural pattern introduced with no precedent, and Part 14's simplification principle argues
   against it. "Guardian" is this document's name for the pipeline's *role*, not a literal type to
   implement.
4. **Does the time-format-normalization gap (Part 16) warrant its own small PR before PR3, given it's
   already a named, real, previously-recurring bug class independent of everything else in this
   program?** Recommendation: yes, as an unnumbered, immediately-actionable fix — it doesn't depend on
   any part of this architecture and shouldn't wait for it.

---

## Part 18 — Production Readiness Assessment

**Not production-ready as a v2 cutover today — by design, per the program's Final Rule: this document is
the specification, not the implementation.** No code changes accompany this document.

**The current production system (on `main`) remains production-ready for its current, documented scope**
and continues shipping independently of this program — nothing in this spec blocks or destabilizes it,
since every proposed change is additive-first (Part 9) until explicitly, individually certified (Part 11).

v2's own readiness gate is exactly Part 11's certification criteria, PR by PR — no PR in Part 9 should be
considered "done" short of that gate, and PR6 (the only non-trivially-reversible step) should not begin
until PR1–PR5 have each individually cleared it.

**Recommended immediate next step** (distinct from "implementation of this spec," which awaits approval
per the Final Rule): the Part 17.4 time-format-normalization fix and the Part 8.1/16 `purge.ts`
table-list test are both small, independent, immediately actionable, and improve the current production
system regardless of whether the broader v2 program is ever approved.

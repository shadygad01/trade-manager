# Developer Diagnostics Center — Architecture Specification

**Status: APPROVED. Source-of-truth field certification complete (Part 2.3). Phase 1 underway.** Before
Phase 1 began, every field in the data model was certified against a strict four-category provenance
test (Part 2.3) — two real design defects were found and fixed during that certification, not merely
categorized around: a mutable `status` field on `DiagnosticCase` that contradicted the "never edited
field-by-field" rule (removed), and a duplication risk in `oldValue`/`newValue`/`input`/`output` capture
that would have silently copied canonical/derived business data into the diagnostics store (replaced with
a three-mode `valueSource` design — reference / replayCursor / narrowly-scoped snapshot — detailed in
Part 2.3). No production code exists against a Part 2 shape that predates this certification.

**Mission**: Portfolio OS runs entirely in the browser with no backend and no server-side database.
Every user's IndexedDB is private to their machine — a developer or an AI assistant investigating a
production bug report has no way to see what actually happened. The Diagnostics Center is the permanent
fix: a read-only observation layer that records what the app already does (writes, decisions, workflow
steps) so any user can generate a self-contained, human-readable report and hand it to a developer or an
AI assistant without ever opening DevTools or exporting a database.

---

## Part 0 — Ground rules (non-negotiable, apply to every phase)

1. **Read-only.** The Diagnostics Center never writes to a business table (`rawTransactions`,
   `ledgerCache`, `allocationsCache`, `trades`, `tradeAllocations`, `portfolios`, `timelineEvents`,
   `journalEntries`, `verifications`, `uploads`, `pendingExecutions`) and never calls a business
   write method (`commitEngine.appendAndMaybeCommit`, `TradeService.recordBuy/recordSell`,
   `ledgerProjection.projectLegacyTicker`, etc.). It only calls its own diagnostics repositories.
2. **Developer Mode only, hidden, off by default.** A normal user must never see a diagnostics
   affordance in the UI, and diagnostics recording must impose zero IndexedDB writes and near-zero CPU
   cost when Developer Mode is off.
3. **Additive instrumentation, not interception.** Business write/read sites gain one extra,
   fire-and-forget call to a diagnostics recorder — never a wrapper, decorator, or monkey-patch around
   the business function itself. The business function's behavior, return value, and error semantics are
   provably unchanged (Part 5.4 states exactly how this is enforced).
4. **Replay, don't intercept, for anything derived.** Diagnostic Cases, First Mutation, State Diff, and
   Invariant results are all *pure functions over recorded events*, computed the same way the domain
   layer already computes `Holding[]` from `LedgerEvent[]` — never mutated in place. This directly
   reuses a pattern this codebase has already built and proven twice (`rawTransactions` → `ledgerCache`
   via `commitEngine`, and `Upload[]` → `LedgerRebuildReport` via `dryRunLedgerRebuild`).
5. **Every phase compiles, passes tests, and is independently revertible.** No phase depends on a later
   phase existing. Deleting a later phase's files must never break an earlier phase.

---

## Part 1 — What already exists (reuse before building)

Research into the current codebase (see commit history / `docs/PORTFOLIO_OS_V2_SPEC.md`) found real,
tested infrastructure that overlaps heavily with this spec's asks. Building the Diagnostics Center means
*wiring these together and filling the gaps*, not starting from zero:

| Diagnostics Center ask | Already built as | File |
|---|---|---|
| Part 8 Query Inspector / Part 9 Live Object Inspector's "current calculated values" | `computeSystemSnapshot` (7 hashed categories: facts/ledger/holdings/allocation/verification/portfolio/policy) | `src/application/services/systemSnapshot.ts` |
| Part 12 Invariant Checker | `regressionGuards.test.ts` (7 frozen structural invariants) + `sourceScan.ts` (regex-over-source scanning) | `src/architecture/` |
| Part 20 Replay Inspector ("re-run only calculations, never modify data") | The exact same non-mutating replay chain: `generateLedgerEvents` → `generateAllocations` → `computeHoldings`, and separately `dryRunLedgerRebuild` | `ledgerEngine.ts`, `allocationEngine.ts`, `holdingsEngine.ts`, `ledgerRebuild.ts` |
| Part 6/17 rule/decision explanations | `buildTickerConstraintReport` (`InventoryContradiction` + `DiagnosisHypothesis`), `TickerCompletenessReport`, `EvidenceIntelligenceReport`, `ReconcileSuggestion` | `constraintValidation.ts`, `completenessEngine.ts`, `evidenceIntelligence.ts`, `mismatchResolver.ts` |
| A pluggable-registry pattern for "one file per unit, one registry entry" | The analytics calculator pattern | `src/application/analytics/calculators/*.ts` + `AnalyticsEngine.ts` |
| An append-only fact log with derived, replaceable cache | `rawTransactions` (append-only, `supersedes`-chained) → `ledgerCache`/`allocationsCache` (full delete-and-regenerate per key) | `commitEngine.ts` |

Gaps that genuinely need new code: there is **no Policy module yet** (`docs/PORTFOLIO_OS_V2_SPEC.md`
Part 3.2 specifies one as PR3, `⬜ NOT STARTED` per `docs/MIGRATION_STATUS.md`) — Part 7's "Policy
Decision" trace and Part 11's "Policy" facts must therefore observe today's *scattered* policy functions
(`evidenceAuthority.ts`, `importVerification.ts`, `reconciliation.ts`), not a unified engine that doesn't
exist. There is also **no feature-flag mechanism at all** in this app (confirmed: no `dev mode`, no
`import.meta.env` flag usage beyond `BASE_URL`, no localStorage debug toggle) — Part 4 below defines one
from scratch, since nothing to extend exists.

---

## Part 2 — Data model

All types are new, under `src/domain/entities/diagnostics/`. They deliberately mirror the shape of
`RawTransaction` (append-only, `kind`-discriminated union) because that pattern is already proven in this
codebase for exactly this problem — an immutable, growing log that downstream code folds into read
models.

### 2.1 `DiagnosticEvent` — the append-only log (one row per recordable occurrence)

```ts
type DiagnosticEvent =
  | SessionEventRecord      // Part 3: workflow step markers
  | WriteTraceRecord        // Part 5: every business write
  | ReadTraceRecord         // Part 6: every "important" business read
  | DecisionTraceRecord     // Part 7: why an engine decided what it decided
  | RuleExecutionRecord     // Part 10 / 17: rule/assertion runs
  | PerfSampleRecord        // Part 21: timing samples

interface DiagnosticEventBase {
  id: string;               // uuid
  seq: number;               // repository-assigned, monotonic — same discipline as RawTransaction.seq
  recordedAt: string;        // ISO timestamp
  sessionId: string;         // one per app-load (Part 2/3 "Session Recorder")
  portfolioId?: string;
  ticker?: string;
  workflowStep?: WorkflowStep; // AppStart | Reset | Import | Confirm | Allocate | Commit | Refresh
                                // | Restart | Rebuild | Delete | ManualEdit | ReImport | Verification | Error
}
```

- `SessionEventRecord { kind: "SessionEvent"; label: string; metadata?: Record<string, unknown> }`
  (`workflowStep` on the base record already names the step — the first draft's separate `step` field was
  a straight redundancy, removed).
- `WriteTraceRecord { kind: "WriteTrace"; writer: string; function: string; file: string; table: string;
  objectId: string; valueSource: "reference"|"replayCursor"|"snapshot"; factSeqCursor?: number;
  oldValue?: unknown; newValue?: unknown; reason: string }`
- `ReadTraceRecord { kind: "ReadTrace"; reader: string; function: string; file: string; factSeqCursor: number; decision?: string }`
- `DecisionTraceRecord { kind: "DecisionTrace"; decisionType: "Replay"|"Verification"|"Allocation"|"Warning"|"Constraint"|"Policy"; factSeqCursor: number; reasonCode: string; reasonText: string }`
- `RuleExecutionRecord { kind: "RuleExecution"; ruleName: string; passed: boolean; factSeqCursor: number; reason: string; durationMs: number }`
- `PerfSampleRecord { kind: "PerfSample"; operation: "Import"|"Replay"|"Verification"|"Allocation"|"Commit"|"Render"; durationMs: number; meta?: Record<string, unknown> }`

**Revision from the first draft, produced by the Part 2.3 certification**: `ReadTraceRecord`/
`DecisionTraceRecord`/`RuleExecutionRecord` no longer store raw `input`/`output` value blobs, and
`WriteTraceRecord`'s `oldValue`/`newValue` are now conditional on a `valueSource` discriminant rather than
always captured. See Part 2.3 for the full reasoning — the short version: most of what the original draft
proposed to store as a value copy is deterministically re-derivable from `rawTransactions` at a recorded
`factSeqCursor` by re-running the existing, unmodified engines (exactly what Part 20's Replay Inspector
already needs to do), so storing the copy would have been avoidable duplication of derived data. Where
values are still stored as-is (`snapshot` mode, oldValue/newValue), they're normalized via
`systemSnapshot.ts`'s `stableStringify`/`buildContentKeyMap` so a diff never flags a random `id`/`seq` as
a false change (Part 13 State Difference).

### 2.2 `DiagnosticCase` — the derived, replaceable index (one row per detected anomaly)

```ts
interface DiagnosticCase {
  id: string;                 // Unique Error ID
  groupKey: string;           // content hash of (triggerType, ticker, portfolioId, reasonCode) — Part 19 grouping
  severity: "INFO"|"WARNING"|"ERROR"|"CRITICAL";
  triggerType: DiagnosticTriggerType;   // Mismatch | NeedsBrokerScreenshot | NeedsCorroboratingEvidence
                                          // | VerificationConflict | ReplayConflict | AllocationConflict
                                          // | HoldingsConflict | ConstraintFailure | DuplicateDetection
                                          // | UnexpectedWarning | Exception | AssertionFailure | Unknown
  firstOccurrenceEventSeq: number;      // pointer into DiagnosticEvent log
  latestOccurrenceEventSeq: number;
  occurrenceCount: number;
  ticker?: string;
  portfolioId?: string;
  workflowStep?: WorkflowStep;
  context: {
    browser: string; browserVersion: string; appVersion: string; schemaVersion: number;
    featureFlags: string[]; importSessionId?: string; commitId?: string;
  };
}
```

`DiagnosticCase` rows are never edited field-by-field, with no exception. They are produced by a pure
reducer, `detectDiagnosticCases(events: DiagnosticEvent[]): DiagnosticCase[]` (Part 6), and the
diagnostics repository's "commit" step is a full delete-and-regenerate for the affected `groupKey`s only —
the same "full delete-and-regenerate, never partial mutation" discipline `commitEngine.commitTicker`
already uses for `ledgerCache`.

**Revision from the first draft, produced by the Part 2.3 certification**: the original draft included a
mutable `status: "OPEN"|"ACKNOWLEDGED"` field. That field directly contradicted the paragraph above (and
Part 2.2's own original prose, "no resolved status — this is an observer, not a bug tracker") the moment
anything tried to acknowledge a case, since acknowledging it would have to mutate a `DiagnosticCase` row
in place — the one operation this whole model is built to never need. The master spec never asked for
acknowledgment workflow (only Severity, Part 18), so the honest fix was deletion, not inventing a new
event kind just to make the field derivable. If a future sprint genuinely needs acknowledgment tracking,
it must be modeled as its own append-only `DiagnosticEvent` kind, with `status` recomputed by folding that
event stream — never as a field mutated in place on the case row.

---

## Part 2.3 — Source-of-truth field certification

**Purpose**: prove that every field in the data model above is one of exactly four things — canonical
stored data, deterministically derived data, runtime/UI state, or diagnostic metadata — and that none of
them can ever compete with, contradict, or silently replace a canonical business value. Two fields failed
this test in the first draft and were redesigned above (Part 2.1's `valueSource` split, Part 2.2's removed
`status`), not merely reclassified.

### §A — Why `valueSource` exists (the central finding)

The first draft captured `oldValue`/`newValue`/`input`/`output` as raw copies of business-shaped data on
every write and every "important" read. Auditing where that data actually comes from split it cleanly
into three cases, which became the three `valueSource` modes:

1. **`reference`** — the write is to `rawTransactions`. This table is *already* the canonical, permanent,
   append-only fact store (`supersedes`-chained, never overwritten). Storing a copy of a row that will
   forever exist, unchanged, at `rawTransactions` by `id` would be pure duplication with zero benefit — so
   `WriteTraceRecord` stores only `objectId` and re-fetches from the canonical table on demand.
2. **`replayCursor`** — the write is to `trades`, `tradeAllocations`, `ledgerCache`, or `allocationsCache`
   by one of the writers whose value is fully determined by fact-replay (`TradeService`, `ledgerProjection`,
   `lotManager`, `commitEngine`'s cache regeneration). Per `docs/PORTFOLIO_OS_V2_SPEC.md` Part 0.2/5,
   these tables are themselves "legacy-projection"/"replay-cache" — materialized views of
   `rawTransactions`, not a second canonical source. Their value at any past instant is recoverable by
   fetching `rawTransactions` where `seq <= factSeqCursor` and calling the existing, unmodified
   `ledgerEngine`/`allocationEngine`/`holdingsEngine`/`ledgerProjection` functions — exactly the mechanism
   Part 20's Replay Inspector already needs. Storing only a `factSeqCursor` (one integer, a cheap indexed
   `Math.max` query at capture time) instead of a full value copy costs nothing at write time and nothing
   at read time worse than an on-demand replay — the same cost Part 20 already accepted.
3. **`snapshot`** — exactly two writers do **not** derive their write from fact replay:
   `BackupService.ts` (bulk restore from an exported blob) and `ledgerRebuild.ts`'s
   `applyLedgerRebuild` (metadata corrections derived from `Upload[]`, a separate reconstruction source —
   Part 1's table). For these two, and only these two, the prior/new value is genuinely unrecoverable any
   other way once the row is overwritten, so a direct, normalized snapshot is captured. This is the one
   deliberate exception, and it is frozen: a new regression guard (Part 5.4) source-scans every
   `valueSource: "snapshot"` call site and fails CI if a third writer ever uses it without the allowlist
   being explicitly, reviewedly widened — the same discipline `regressionGuards.test.ts` already applies
   to every other allowlist in this codebase.

The same reasoning applies to `ReadTraceRecord`/`DecisionTraceRecord`/`RuleExecutionRecord`'s `input`/
`output`: `verifyAll`, `generateAllocations`, `computeHoldings`, and `buildTickerConstraintReport` are all
pure functions of `rawTransactions` (Part 1's table), so their input and output are always
`replayCursor`-mode derivable — never stored as value copies at all, only the small scalar decision
fields (`reasonCode`, `reasonText`, `passed`) are kept inline, purely as a rendering convenience.

### §B — Field-by-field classification

Legend: **1** = Canonical stored data, **2** = Deterministically derived data, **3** = Runtime/UI state
(non-reconstructible by nature), **4** = Diagnostic metadata. "Participates in business logic" is **No**
for every single field below, with no exceptions — structurally enforced by the Part 5.4 regression guard
(diagnostics code may never call a business write method, and separately, no `src/application/**` file
outside `diagnostics/` may import a diagnostics repository at all).

**`DiagnosticEventBase`** (shared by every event kind):

| Field | Cat. | Source | Persisted | Replayable | Survives restart |
|---|---|---|---|---|---|
| `id` | 4 | uuid generated by the diagnostics repo at capture | Yes | No — arbitrary identifier | Yes |
| `seq` | 4 | diagnostics repo, atomic monotonic counter (same discipline as `RawTransaction.seq`) | Yes | No — an ordering counter, not derived from content | Yes |
| `recordedAt` | 4 | wall-clock timestamp at capture | Yes | No — unique to that moment | Yes |
| `sessionId` | 4 | generated once per app load (Part 4.2), copied into every event of that session | Yes | No | Yes (the recorded copy persists; a new id is generated next load) |
| `portfolioId` | 4 | copied by reference from the live `portfolios` id in scope — pointer only, never the portfolio's fields | Yes | n/a (opaque pointer) | Yes |
| `ticker` | 4 | same shape as `portfolioId` | Yes | n/a | Yes |
| `workflowStep` | 4 | known at the instrumented call site | Yes | No | Yes |

**`SessionEventRecord`**: `label`, `metadata?` — both **4**, free text/small object chosen at the call
site, not derived from or duplicating anything else. Persisted / not replayable / survives restart, same
as the base fields.

**`WriteTraceRecord`**:

| Field | Cat. | Source | Persisted | Replayable | Survives restart |
|---|---|---|---|---|---|
| `writer`/`function`/`file` | 4 | static string literals at the instrumented call site | Yes | No — describes code, not data | Yes |
| `table`/`objectId` | 4 | the table name and row id the write call itself targeted — pointer only | Yes | n/a (pointer) | Yes |
| `valueSource` | 4 | statically determined by which of §A's three modes applies to this call site | Yes | n/a | Yes |
| `factSeqCursor` (replayCursor mode) | 4 | `Math.max` over `rawTransactions.seq` at capture time — a plain indexed read | Yes | n/a (it *is* the pointer that makes other fields replayable) | Yes |
| `oldValue`/`newValue` (reference mode) | — | **not stored** — reconstructed by fetching `rawTransactions` by `objectId` | No | Yes — the row is immutable and permanent | n/a |
| `oldValue`/`newValue` (replayCursor mode) | — | **not stored** — reconstructed by replaying `rawTransactions ≤ factSeqCursor` through the unmodified engines | No | Yes | n/a |
| `oldValue`/`newValue` (snapshot mode, `BackupService`/`applyLedgerRebuild` only) | 4 | read directly off the business row immediately before/after the write, normalized via `systemSnapshot.ts`'s `stableStringify` | Yes | **No** — this is precisely the value that becomes unrecoverable once the row is overwritten again; that irreproducibility is the entire reason it's captured | Yes |
| `reason` | 4 | string supplied by the calling code | Yes | No | Yes |

**`ReadTraceRecord`**: `reader`/`function`/`file` — **4**, same shape as `writer`/`function`/`file` above.
`factSeqCursor` — **4**, same as above. `decision?` — **2**, the short label the read function's own
deterministic return value already carries; recomputable by replaying at `factSeqCursor`; persisted as a
rendering convenience only.

**`DecisionTraceRecord`**: `decisionType` — **4** (identifies which engine/decision kind). `factSeqCursor`
— **4**. `reasonCode`/`reasonText` — **2**, the deterministic engine's own output, kept inline for fast
Case List/report rendering without a replay round-trip on every list render; always re-derivable and thus
never a competing source — if a stored value and a fresh replay ever disagree, that disagreement is
itself surfaced as a `ReplayConflict` Diagnostic Case (Part 6), not silently trusted.

**`RuleExecutionRecord`**: `ruleName` — **4**. `passed` — **2**, the rule function's own boolean, rerunnable
at `factSeqCursor`. `factSeqCursor` — **4**. `reason` — **2**, same shape as `reasonText`. `durationMs` —
**3**: a `performance.now()` delta measured around that specific execution. This is the one field in the
entire model that is irreproducible *by nature*, not merely inconvenient to reproduce — re-running the
rule later measures a new duration reflecting the current machine/JIT state, never a reproduction of the
original. Safe precisely because nothing else in the app claims to be the source of truth for "how long
did that specific past execution take" — there is no second value it could contradict.

**`PerfSampleRecord`**: `operation` — **4**. `durationMs` — **3**, identical reasoning to
`RuleExecutionRecord.durationMs`. `meta?` — **4**.

**`DiagnosticCase`**:

| Field | Cat. | Source | Replayable |
|---|---|---|---|
| `id` | 4 | generated | No |
| `groupKey` | 2 | `hash(triggerType, ticker, portfolioId, reasonCode)`, a pure function | Yes — recomputable from the same fields |
| `severity` | 2 | pure classification function of `triggerType`, defined once per trigger in the registry (Part 6) | Yes |
| `triggerType` | 2 | identity of whichever trigger function matched | Yes — rerunning `detectDiagnosticCases` over the same events reproduces it |
| `firstOccurrenceEventSeq`/`latestOccurrenceEventSeq` | 2 | min/max `seq` among matching events, computed by the reducer | Yes |
| `occurrenceCount` | 2 | count of matching events | Yes |
| `ticker`/`portfolioId`/`workflowStep` | 4 | copied from the triggering event(s) — correlation only | n/a |
| `context.browser`/`browserVersion` | 3 | `navigator.userAgent` parsed at capture time | No — describes a specific past session, not recomputable |
| `context.appVersion` | 4 | a build-time constant baked into the bundle | n/a |
| `context.schemaVersion` | 4 | read live from `db.verno` (the running Dexie instance itself), never copied into a second mutable field | n/a |
| `context.featureFlags` | 4 | read live from the Developer Mode flag mechanism (Part 4.1) at capture time — a snapshot list of names, not the flags' authoritative storage | n/a |
| `context.importSessionId`/`commitId` | 4 | correlation references to existing, non-diagnostic runtime state (the import-session pool, a specific `commitTicker` invocation) — pointer only | n/a |

All rows above: **Persisted = Yes**, **Survives restart = Yes**, **Participates in business logic = No**
(Part 5.4 guard), unless a cell says otherwise.

### §C — Certification result

Every field in the (revised) data model is one of the four permitted categories. No field is a live
mirror of mutable canonical state that could disagree with the canonical value while both claim to be
current — Category 1/2 fields are pointers or on-demand recomputations of the same canonical fact log
business logic itself reads; Category 3 fields are one-shot measurements with no canonical counterpart to
conflict with; Category 4 fields are identifiers, static context, or (in the two named `snapshot`-mode
exceptions) immutable historical captures that are never read back into business logic and never claim to
describe the *current* state of anything — the live business table remains, in every case, the sole
answer to "what is X now."

### §D — New regression guard from this certification

`diagnosticsSnapshotModeIsNarrowlyScoped` (added to `src/architecture/regressionGuards.test.ts`'s plan for
Part 5.4): source-scans every `valueSource: "snapshot"` call site and asserts the writer file is exactly
`BackupService.ts` or `ledgerRebuild.ts` — nothing else. A third file constructing a `snapshot`-mode
`WriteTraceRecord` fails CI immediately, the same allowlist-freezing discipline every other guard in that
file already applies.

---

## Part 3 — Storage

### 3.1 Two new Dexie tables, one new schema version

`src/infrastructure/db/db.ts` is currently at version 4 (11 tables, additive-only version history — see
`docs/MIGRATION_STATUS.md`). This spec adds version 5 with exactly two new tables:

```ts
this.version(5).stores({
  // ...all 11 existing tables, verbatim, unchanged...
  diagnosticEvents: 'id, seq, sessionId, recordedAt, kind, ticker, portfolioId',
  diagnosticCases: 'id, groupKey, severity, triggerType, ticker, portfolioId, latestOccurrenceEventSeq',
});
```

Two tables, not six, deliberately — mirrors §2's two-type model (log + derived index) instead of one
table per `DiagnosticEvent` subtype. This also minimizes the blast radius on
`src/architecture/regressionGuards.test.ts`'s frozen Dexie table-list guard: that guard's allowlist gains
exactly two new entries, both under an explicit new category (`diagnostic-store`), in the same commit
that adds the schema version — never silently.

### 3.2 Repository interfaces live in `@domain`, implementations in `@infrastructure`

Same shape as every other repository in this app:

- `src/domain/repositories/DiagnosticEventRepository.ts` — `append(event)`, `getBySession(sessionId)`, `getRecent(limit)`, `pruneOlderThan(cutoff)`.
- `src/domain/repositories/DiagnosticCaseRepository.ts` — `replaceForGroupKeys(cases)`, `getAll()`, `search(filter)`.
- `src/infrastructure/db/DexieDiagnosticEventRepository.ts` / `DexieDiagnosticCaseRepository.ts` — Dexie-backed.

### 3.3 The recorder is a port, and the default implementation is a no-op

```ts
// src/domain/repositories/DiagnosticsRecorder.ts
interface DiagnosticsRecorder {
  recordSessionEvent(e: Omit<SessionEventRecord, ...base>): void;
  recordWrite(e: Omit<WriteTraceRecord, ...base>): void;
  recordRead(e: Omit<ReadTraceRecord, ...base>): void;
  recordDecision(e: Omit<DecisionTraceRecord, ...base>): void;
  recordRuleExecution(e: Omit<RuleExecutionRecord, ...base>): void;
  recordPerfSample(e: Omit<PerfSampleRecord, ...base>): void;
}
```

`NoopDiagnosticsRecorder` (all methods empty) is the module-level default. `RecordingDiagnosticsRecorder`
(writes to the Dexie repositories, async, fire-and-forget, wrapped exactly like every other shadow-write
path in this codebase: `promise.catch(err => console.warn(...))`, never `await`ed by the caller, never
throws into the caller) is only constructed and swapped in when Developer Mode is on (Part 4). This is
the same interface-plus-swappable-implementation shape `AppRepositories` already uses throughout the app
— nothing new architecturally, just one more port.

---

## Part 4 — Lifecycle & Developer Mode gating

### 4.1 Turning it on

No feature-flag mechanism exists in this app today (Part 1). This spec adds the minimum one:

- `localStorage['portfolio-os:developer-mode'] = 'true'` is the persisted flag.
- It is set only via a **hidden** affordance: a 7-tap sequence on the app's version/build number in
  Settings (a common, well-understood "hidden dev menu" pattern — no normal user finds it by accident,
  no URL parameter is needed so it can't leak via a shared link/screenshot).
- Reading the flag happens once at app boot (`presentation/lib/developerMode.ts`), which decides whether
  `NoopDiagnosticsRecorder` or `RecordingDiagnosticsRecorder` gets wired into the app's dependency
  composition root, and whether the `/diagnostics` route is registered at all (Part 7.1) — not just
  hidden by CSS, genuinely absent from the router when off.
- Turning Developer Mode off does **not** delete previously recorded diagnostics — it stops recording new
  events and hides the UI. A separate, explicit "Clear all diagnostics" button (Part 10.3) is the only
  way to delete diagnostics data.

### 4.2 Session identity

One `sessionId` (uuid) is generated per app load and held in memory (not persisted) — this is the "one
continuous Session Recorder" Part 2 of the master spec asks for. An `AppStart` `SessionEventRecord` is
always the first event of a session when Developer Mode is on.

### 4.3 Startup pruning (ties into Part 9 Retention)

On every app boot, if Developer Mode is on, `pruneOlderThan(cutoff)` runs once, non-blocking, using the
exact same "non-fatal try/catch discipline" as `backfillRawTransactionsSilently`'s startup hook in
`src/presentation/lib/data.ts` — a failure to prune must never block app startup.

---

## Part 5 — Instrumentation: Session Recorder, Writer Trace, Reader Trace

### 5.1 Session Recorder (master spec Part 2/3)

Every top-level workflow action already has one call site per action (Import button handler, Confirm
button handler, Commit trigger, etc. — these are UI event handlers in `src/presentation/pages/`, not
scattered). Each gains one `diagnostics.recordSessionEvent({ step, label })` call at its start. This is
additive, not a wrapper: the existing handler code is unchanged except for one new line.

### 5.2 Writer Trace (master spec Part 5) — the frozen writer allowlists are the exact instrumentation map

`src/architecture/regressionGuards.test.ts` already enumerates, by construction, every file that writes a
business table. This spec instruments exactly those, and no others:

- **Execution-fact writers** (5, frozen), all `table: "rawTransactions"`, `valueSource: "reference"`:
  `TradeService.ts` (`ensureBuyFact`/`ensureSellFacts`), `backfillRawTransactions.ts` (`runBackfill`),
  `importRecording.ts` (`recordImportedRawTransactions`), `ledgerProjection.ts`
  (`ensureLegacyFactsExist`), `lotManager.ts` (`recordSellTransactionLocked`).
- **`Trade`/`TradeAllocation` writers** (5, frozen): `TradeService.ts`, `ledgerProjection.ts`,
  `lotManager.ts` use `valueSource: "replayCursor"` (their writes are fully determined by
  `rawTransactions` replay — Part 2.3 §A). `ledgerRebuild.ts` (`applyLedgerRebuild`) and
  `BackupService.ts` use `valueSource: "snapshot"` — the two named, frozen exceptions (Part 2.3 §A/§D)
  whose writes derive from `Upload[]`/an export blob rather than fact replay.

Each write call site gains one `diagnostics.recordWrite({ writer, function, file, table, objectId,
valueSource, factSeqCursor?, oldValue?, newValue?, reason })` immediately after the real write succeeds
(not before — a diagnostics call must never run for a write that didn't happen, and must never be able to
prevent one that did). `factSeqCursor`/`oldValue`/`newValue` are populated per §A's rule for the call
site's mode — `reference`-mode writers pass neither (just the four required fields plus `reason`).

**This spec adding diagnostics calls to these 10 files is a deliberate, one-time, disclosed exception to
"read-only."** The ground rule in Part 0.1 is about *tables and repositories* — diagnostics never gets a
handle to a business repository's write methods. Adding an observation call inside an already-approved
writer is categorically different from the Diagnostics Center creating a new, eleventh, undisclosed
writer, and Part 5.4 defines the structural check that keeps that distinction real over time.

### 5.3 Reader Trace (master spec Part 6) — instrument entry points, not every DB read

"Important" reads are exactly the six named in the master spec: Replay, Verification, Allocation,
Holdings, Warning, Policy. These map to five existing function entry points, each gaining one
`diagnostics.recordRead({ reader, function, file, factSeqCursor, decision })` call around its existing
return statement — `factSeqCursor` is the same "highest `rawTransactions.seq` seen" pointer as Part 2.3
§A, `decision` is a short label copied from the function's own deterministic output, and no full
input/output value is captured (Part 2.3 §A):

`verifyAll`/`verifyTicker` (`verificationEngine.ts`), `generateAllocations` (`allocationEngine.ts`),
`computeHoldings` (`holdingsEngine.ts`), `buildTickerConstraintReport` (`constraintValidation.ts`, stands
in for "Warning" until a Warning type exists), and the scattered policy functions (`authorityRank`,
`checkTickerMatch`, `isTickerFullyOfficialBrokerExcelSourced`) for "Policy." Instrumenting every Dexie
`.get()` call in the app would be both a performance problem and noise — explicitly out of scope.

### 5.4 The structural guarantee that instrumentation stays "observe-only"

A new regression guard, `diagnosticsInstrumentationIsObserveOnly` in
`src/architecture/regressionGuards.test.ts`, source-scans (reusing `sourceScan.ts`, the same technique
guarding everything else in this file) every `src/application/services/diagnostics/*.ts` file and asserts
it contains **zero** calls into any business repository's write methods (`.save(`, `.delete(`,
`.append(`, `.saveRemainingShares(`) and zero imports of `commitEngine`, `TradeService`, or
`ledgerProjection`'s writing functions. This is the automated proof that Part 0.1 ("read-only") holds,
not just a comment asserting it.

A second guard, `diagnosticsSnapshotModeIsNarrowlyScoped` (Part 2.3 §D), source-scans every
`valueSource: "snapshot"` call site across the whole codebase and asserts the writer file is exactly
`BackupService.ts` or `ledgerRebuild.ts` — freezing the one deliberate exception to "no raw value copies"
the same way every other allowlist in this file is frozen.

---

## Part 6 — Diagnostic Case Detection Engine (master spec Part 1, 19)

`detectDiagnosticCases(newEvents: DiagnosticEvent[], existingCases: DiagnosticCase[]):
DiagnosticCase[]` — a pure function, `src/application/services/diagnostics/caseDetector.ts`, following
the exact plugin-registry shape `AnalyticsEngine.ts` already uses (Part 1 table): one file per trigger
type under `src/application/services/diagnostics/triggers/`, one registry entry each. A trigger is a
small pure function `(events, existingCases) => DiagnosticCase[]`, e.g.:

- `mismatchTrigger` — watches `DecisionTraceRecord`s where `decisionType === "Verification"` and
  `reasonCode` matches a contradiction from `constraintValidation.ts`'s `InventoryContradiction`.
- `exceptionTrigger` — watches for a new `RuleExecutionRecord`/`WriteTraceRecord` whose `reason` field
  was populated from a caught exception (writers already wrap in try/catch per repo convention; that
  catch block is the one new call site each writer gains to also call `recordException`).
- `duplicateDetectionTrigger`, `replayConflictTrigger`, `allocationConflictTrigger`,
  `holdingsConflictTrigger`, `assertionFailureTrigger` — one file each, same shape.

Grouping (master spec Part 19) is `groupKey`-based: a new event matching an existing open case's
`groupKey` increments `occurrenceCount` and updates `latestOccurrenceEventSeq` rather than creating a new
case — implemented as the same "replace-for-key" commit discipline as `commitEngine.commitTicker`, scoped
to the affected `groupKey`s only.

---

## Part 7 — UI

### 7.1 Route registration

`/diagnostics` is registered in `App.tsx`'s router **only** when `developerMode.isEnabled()` is true,
checked once at composition-root time (Part 4.1) — absent from the route table entirely when off, not
just guarded by a redirect (a redirect still ships the code and leaks its existence via network tab /
bundle inspection; full route omission is the stronger hide, consistent with "hidden from normal users").

### 7.2 Screens (master spec Parts 3–15, 20 mapped to concrete views)

| Master spec Part | Screen |
|---|---|
| Part 16 Search | Case List — filter by ticker/portfolio/severity/workflow step/date/browser/status |
| Part 18 Severity, Part 19 Grouping | Case List row: severity badge, occurrence count, first/latest seen |
| Part 3 Workflow Timeline | Case Detail → Timeline tab (current step / first failed step / first mutation highlighted) |
| Part 4 First Mutation Detector | Case Detail → First Mutation tab (or explicit "not determinable: <reason>" state) |
| Part 5 Writer Trace | Case Detail → Writer Trace tab |
| Part 6 Reader Trace | Case Detail → Reader Trace tab |
| Part 7 Decision Trace | Case Detail → Decision Trace tab |
| Part 8 Query Inspector | Case Detail → Query Inspector tab (built on `systemSnapshot.ts`'s content-key resolution, rendered as Function → Projection → Repository → Facts chain) |
| Part 9 Live Object Inspector | Global "Inspect ticker" search, independent of any case |
| Part 10 Rule Inspector | Case Detail → Rules tab |
| Part 11 Current State Summary | Case Detail → Summary tab — prose, not JSON (reuses `TickerCompletenessReport`/`TickerConstraintReport`'s existing human-readable fields) |
| Part 12 Invariant Checker | Global "Invariants" panel — PASS/FAIL/UNKNOWN per `regressionGuards.test.ts`-shaped check, runnable on demand |
| Part 13 State Difference | Case Detail → Diff tab |
| Part 14 Root Cause Assistant | Case Detail → Root Cause tab, always shows a confidence percentage, never "certain" |
| Part 15 AI Report | Case Detail → "Copy Diagnostic Report" button |
| Part 20 Replay Inspector | Case Detail → Replay tab: previous decision vs. re-run decision, side by side |
| Part 21 Performance | Global "Performance" panel + per-case timing if the case occurred mid-operation |

### 7.3 The report generator (master spec Part 15)

`generateDiagnosticReport(caseId): string` — plain markdown, sections exactly as specified (Summary,
Timeline, Current State, First Mutation, Decision Trace, Writer Trace, Reader Trace, Invariant Results,
Assertions, Likely Root Cause, Open Questions). No JSON blob, no raw table dump — every section is
composed from the same human-readable summarizers the UI tabs already use, so the button is a
serialization of what's on screen, not a second code path.

---

## Part 8 — Performance impact

- **Off (default): zero.** `NoopDiagnosticsRecorder`'s methods are empty function bodies; V8 inlines and
  eliminates them. No IndexedDB table is opened, no route is registered, no bundle-split chunk for
  `/diagnostics` is even fetched (dynamic `import()` on route match).
- **On: async and non-blocking.** Every recorder call is fire-and-forget (`void recorder.recordX(...)`,
  internally `this.repo.append(...).catch(...)`), never `await`ed on a business code path, so a slow
  diagnostics write can never slow down a business write.
- **Rule Inspector / Invariant Checker are on-demand, not continuous.** They run when a Diagnostic Case is
  opened or the user presses "Run Invariants Now" — never on a timer, never on every write, to keep
  Developer Mode itself from becoming the performance problem it exists to diagnose.
- **A perf regression test** (`diagnosticsNoopOverhead.test.ts`) benchmarks the existing
  `excelWorkflowEndToEnd.test.ts` scenario with Developer Mode off and asserts wall-clock time is within
  noise of the pre-instrumentation baseline — the actual proof, not just a design claim.

---

## Part 9 — Retention policy

Diagnostics data is debugging exhaust, not business data — it must not grow unbounded on a machine that
never restarts the browser for weeks.

- `diagnosticEvents`: capped at **the most recent 5,000 events OR 30 days**, whichever is smaller,
  pruned oldest-first on startup (Part 4.3). Events belonging to an still-open `DiagnosticCase`'s
  `firstOccurrenceEventSeq` are exempt from pruning until the case itself is pruned, so a case's evidence
  trail never gets silently truncated out from under it.
- `diagnosticCases`: capped at **200 most-recently-active cases**, pruned oldest-`latestOccurrenceEventSeq`-first.
  Cases are small (one row each) — this cap exists to bound the Case List UI, not storage size.
- Both caps and the 30-day window are named constants in one file (`diagnosticsRetentionPolicy.ts`), not
  scattered magic numbers — deliberately easy to tune after real-world usage without touching the pruning
  logic itself.
- Retention pruning is itself invariant-checked (Part 12/17): a `Retention Bounds Respected` assertion
  runs alongside the others, so silent unbounded growth would itself become a visible Diagnostic Case.

---

## Part 10 — Security & privacy

- **No new data leaves the browser.** This app has no backend (`CLAUDE.md`); the Diagnostics Center adds
  no network calls. "Copy Diagnostic Report" is a clipboard write, initiated by an explicit user click —
  nothing is auto-uploaded, auto-emailed, or auto-synced anywhere.
- **No new categories of sensitive data.** Everything recorded (ticker, portfolio name, share counts,
  cost basis) is already present in the app's own domain data that the user already sees on screen — the
  Diagnostics Center does not capture browser history, other tabs, credentials, or anything outside this
  app's own state.
- **Default-off is the primary control**, enforced by a regression test asserting
  `localStorage.getItem('portfolio-os:developer-mode')` is `null`/falsy on a fresh app load and that the
  `/diagnostics` route is absent from the router in that state (Part 7.1) — a structural check, not just
  a code review convention.
- **No write surface for business data**, enforced by Part 5.4's source-scan guard.
- **"Clear all diagnostics" is the only delete path**, lives in the Diagnostics Center UI itself (not
  mixed into `DataPage.tsx`'s existing Reset/Rebuild actions, which are business-data operations), and
  deletes only `diagnosticEvents`/`diagnosticCases` — never touches a business table, checked by the same
  source-scan guard pattern.

---

## Part 11 — Self-review (adversarial pass)

**"Why not just use browser DevTools?"** DevTools requires physical/remote access to the *user's own
machine* — for a retail-investor product, the developer will never have that. The entire premise of this
program is that production bugs today require guessing because of exactly this gap.

**"Two new Dexie tables — why not one?"** A single table mixing append-only log rows and derived,
replaceable index rows would need a `rowType` discriminant and different write disciplines within one
table (append vs. delete-and-replace), which is precisely the "coarse keys reused as identity" anti-
pattern `docs/ROADMAP.md`'s own repo-wide audit (referenced in `PORTFOLIO_OS_V2_SPEC.md` Part 0.7) already
flagged as a recurring bug source in this codebase. Two tables, matching two write disciplines, is the
proven-safe shape.

**"Instrumenting 10 frozen writer files — doesn't that fight `regressionGuards.test.ts`'s entire point?"**
No: those guards freeze the *set of files that write business tables*, not "these files may never be
touched again." Adding a diagnostics call is not adding a new writer of `Trade`/`RawTransaction` — it's
adding an observer inside an already-approved one. Part 5.4's new guard is what keeps that distinction
enforced automatically rather than by discipline alone, which is the same philosophy every other guard in
that file already applies to a different risk.

**"What if `Policy` doesn't exist as a real module yet — is Part 7's Decision Trace's `Policy` case
premature?"** It observes today's scattered policy functions now, and swaps to observing the unified
`src/application/policy/` module transparently once PR3 (`PORTFOLIO_OS_V2_SPEC.md` Part 3.2) ships — the
`DecisionTraceRecord.decisionType: "Policy"` shape doesn't change either way, only which functions emit
it. No rework required, just an addition when PR3 lands.

**"Biggest remaining risk?"** Instrumentation drift — a new writer added later (an 11th) that nobody
remembers to also instrument. Mitigated exactly like every other drift risk in this codebase already is:
`regressionGuards.test.ts`'s existing writer-allowlist guards fail CI the moment an unreviewed 11th writer
appears at all, which is the natural trigger for a human to also add its diagnostics call — the two
guards (existing writer-count guard, new observe-only guard) work together rather than needing a third,
diagnostics-specific "coverage" guard.

---

## Part 12 — Phased implementation roadmap

Each phase below is independently mergeable, independently revertible (deleting its files/table entries
does not break an earlier phase), and ships with its own tests. No phase implements UI ahead of the data
it displays.

- **Phase 1 — Foundation.** `DiagnosticEvent`/`DiagnosticCase` domain types (Part 2), Dexie v5 schema +
  repositories (Part 3), `NoopDiagnosticsRecorder`/`RecordingDiagnosticsRecorder` (Part 3.3), Developer
  Mode flag + hidden toggle + composition-root wiring (Part 4), empty `/diagnostics` route showing "no
  cases recorded yet." **No business file is touched.** Fully reversible: delete the route, the two
  tables, and the flag.
- **Phase 2 — Session Recorder + Writer Trace.** One-line instrumentation in the 10 frozen writer call
  sites (Part 5.1, 5.2) + Part 5.4's observe-only guard. UI: raw Timeline + Writer Trace list (no case
  detection yet — every event is visible, nothing is triaged).
- **Phase 3 — Reader Trace + Decision Trace.** Instrument the five read entry points (Part 5.3). UI:
  Decision Trace tab, Query Inspector chain view.
- **Phase 4 — Case Detection Engine.** `detectDiagnosticCases` + first three triggers (mismatch,
  exception, assertion failure) (Part 6). UI: Case List with search/filter (Part 7.2, master spec Parts
  16, 18, 19).
- **Phase 5 — First Mutation Detector + State Diff.** Part 7.2 rows for master spec Parts 4, 13.
- **Phase 6 — Live Object Inspector + Current State Summary.** Reuses `systemSnapshot.ts` and the
  existing report types (Part 1 table) — mostly UI composition, minimal new logic.
- **Phase 7 — Invariant Checker + Rule Inspector + Assertions.** Wraps `regressionGuards.test.ts`-shaped
  checks into an on-demand, live-runnable panel (Part 7.2, 8).
- **Phase 8 — Replay Inspector.** Re-runs `verificationEngine`/`allocationEngine`/`ledgerEngine`/
  `constraintValidation` against current facts, diffs previous vs. current decision (master spec Part 20).
- **Phase 9 — Root Cause Assistant + AI Report.** The "Copy Diagnostic Report" button (master spec Parts
  14, 15) — composes everything from Phases 2–8.
- **Phase 10 — Performance Instrumentation.** Part 8/21 timing wrappers + the perf regression test.

**This document is Phase 0.** It should be reviewed and explicitly approved before Phase 1 begins.

---

## Part 13 — Open questions (for the approver, not decided unilaterally here)

1. **Hidden-toggle mechanism** (Part 4.1) proposes a 7-tap version-number sequence in Settings. If there's
   no existing Settings screen with a version number displayed, an alternative (e.g. a keyboard shortcut)
   needs picking — this spec's choice is a reasonable default, not a hard requirement.
2. **Retention numbers** (Part 9: 5,000 events / 30 days / 200 cases) are starting guesses, not measured —
   worth revisiting after Phase 2 ships with real usage data.
3. **Should "Clear all diagnostics" require confirmation-typing** (like destructive actions elsewhere in
   this app) or a single confirm dialog — no existing convention in this codebase to anchor to since this
   would be the first purely-developer-facing destructive action.

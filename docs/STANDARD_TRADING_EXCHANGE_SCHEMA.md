# Standard Trading Exchange Schema (STES) — v1.0

The **official exchange format between external AI systems and Trade Manager**.

Any AI (ChatGPT, Claude, Gemini, or any future system) that extracts trading
information from a broker statement, invoice, PDF, notification, screenshot,
email, orders history, or any future source, converts it into **one Excel file
in this format**. That Excel file is the only official exchange format Trade
Manager accepts from external systems. It is *not* Trade Manager's storage
format: once imported, every accepted row becomes an append-only fact in the
**Internal Trade Ledger** (`RawTransaction`, see
[EVIDENCE_ARCHITECTURE.md](EVIDENCE_ARCHITECTURE.md) and
[VERIFICATION_ENGINE.md](VERIFICATION_ENGINE.md)), which is the permanent,
authoritative record. The Excel file is a courier; the ledger is the truth.

Design priorities, in order: **reliability, determinism, completeness,
long-term maintainability** — never minimizing column count.

---

## 1. System philosophy

```
 Broker Statement ─┐
 Invoice / PDF ────┤
 Notification ─────┤     ┌──────────────┐      ┌───────────────┐      ┌──────────────────────┐
 Orders screen ────┼───► │ External AI  │ ───► │  STES Excel   │ ───► │ Trade Manager Import │
 Screenshot ───────┤     │ (any vendor) │      │   (v1.0)      │      │  → Internal Trade    │
 Email ────────────┤     └──────────────┘      └───────────────┘      │    Ledger (append-   │
 Future sources ───┘                                                  │    only facts)       │
                                                                      └──────────────────────┘
```

1. An external AI extracts trading information from any supported source.
2. The AI generates a Standard Trading Exchange Excel file.
3. Trade Manager imports the file. Every row is validated deterministically,
   matched against the Internal Trade Ledger, and classified as **new**,
   **duplicate**, **modified**, or **conflicting**.
4. Every accepted transaction becomes a permanent fact in the Internal Trade
   Ledger, identified forever by a **Ledger Transaction ID** that Trade Manager
   generates once and never changes.

### Scope

Supported transaction types — exactly three:

| Type | Meaning |
|---|---|
| `BUY` | One executed buy. **One row per execution — never aggregated.** Creates one immutable Trade (lot). |
| `SELL` | One executed sell. Never creates a trade; allocates against existing BUY lots. |
| `DIVIDEND` | One cash dividend payment for one ticker on one date. |

**Explicitly out of scope** (rows with any other type are rejected, never
silently coerced): deposits, withdrawals, cash transfers, mutual funds, and
every other non-trading cash operation. Those remain in-app concepts recorded
directly by the user.

### The trade model the schema must preserve

This schema exists in service of the product's core rule
([ARCHITECTURE.md ADR-002](ARCHITECTURE.md)):

- Every `BUY` row becomes **one separate, independent, immutable Trade** —
  independently identifiable, editable (via correction facts), tracked,
  analyzable, allocatable, and reconstructable. Multiple buys of the same
  ticker are **never** merged into a position, holding, average-cost record,
  or aggregated row — not in the Excel file, not in the ledger. An AI that
  finds three buy executions of the same ticker on the same day at the same
  price **must emit three rows**.
- A `SELL` row **does not create a trade**. It is an execution fact that must
  eventually be allocated — explicitly, lot by lot — against one or more BUY
  trades. The schema carries allocations on a dedicated sheet
  (`Sell_Allocations`, §4) when the source evidence or a prior export makes
  them known; otherwise the sell imports unallocated and the user allocates it
  in-app. **Average cost, FIFO, and LIFO are never assumed** — an allocation
  either names its lots explicitly or does not exist yet. (This maps directly
  onto the ledger's own separation of `SellExecution` from
  `SellAllocationDecision`.)
- The complete lifecycle of every BUY trade — open, partially closed, closed,
  every allocation against it — must always be reconstructable from the ledger
  alone.

---

## 2. Workbook structure

One `.xlsx` workbook, exactly these sheets, exact names, in this order:

| Sheet | Purpose | Required |
|---|---|---|
| `Metadata` | File-level declaration: schema version, generator, defaults. | Yes |
| `Transactions` | One row per BUY / SELL / DIVIDEND. The heart of the file. | Yes |
| `Sell_Allocations` | Explicit lot allocations for SELL rows, when known. | Optional (sheet may be absent or empty) |

Formatting rules (apply everywhere):

- Row 1 of `Transactions` and `Sell_Allocations` is the header row, using the
  exact column names below (case-insensitive match, but emit them as written).
- Dates: ISO 8601 `YYYY-MM-DD`. Times: 24-hour `HH:MM` or `HH:MM:SS`.
- Numbers: plain decimals, `.` as decimal separator, **no** thousands
  separators, **no** currency symbols, **no** parentheses for negatives
  (no field in this schema is ever negative).
- Text cells: plain text, trimmed. Empty cell = "unknown", never `0`, `N/A`,
  `-`, or `null` as filler text.
- Enum values (Transaction Type, Source Type, …): uppercase, exact.
- Unknown ≠ zero. **If a value is not visible in the source, leave the cell
  blank.** The only fields an AI may compute rather than read are the two
  cross-check amounts (Gross Amount, Net Amount), and computing them is
  optional.
- Extra columns not in this spec are ignored with a warning (forward
  compatibility); missing *optional* columns are fine; a missing *required*
  column fails the whole file with a schema error before any row is processed.

---

## 3. Sheet `Metadata`

Two columns (`Key`, `Value`), one entry per row:

| Key | Data type | Required | Validation | Description |
|---|---|---|---|---|
| `Schema Name` | Text | Required | Must be exactly `Trade Manager Standard Trading Exchange` | Self-identifies the file so a random spreadsheet is never mistaken for an exchange file. |
| `Schema Version` | Text | Required | Must be a version this importer supports; currently `1.0` | Drives parsing. Unknown major version → reject file with a clear message; unknown minor version → import with a warning. |
| `Generated By` | Text | Required | Non-empty | Which AI/tool produced the file (e.g. `ChatGPT`, `Claude`, `Gemini`, a broker integration name). Audit trail only — never affects import behavior. |
| `Generated At` | Text (ISO 8601 datetime) | Required | Valid ISO 8601 | When the file was generated. |
| `Default Currency` | Text | Optional | ISO 4217 code | Applies to every row whose `Currency` cell is blank. Defaults to `EGP` when absent. |
| `Timezone` | Text | Optional | IANA zone name | Timezone of every `Trade Time` in the file. Defaults to `Africa/Cairo`. |
| `Source Description` | Text | Optional | — | Free-text description of what was extracted (e.g. "Thndr statement PDF Jan–Mar 2026 + 2 order screenshots"). |

---

## 4. Sheet `Transactions`

One row per executed BUY, per executed SELL, per DIVIDEND payment.
**Populated entirely by the external AI.** No Trade Manager internal field
appears here except the round-trip `Ledger Transaction ID` (see its row).

“Required” below means: the cell must be non-blank *for the transaction types
listed*; for other types it must be blank (a value where the spec says blank
is a row-level validation error — it signals the AI misclassified the row).

### 4.1 Identity

| Column name | Data type | Required | Validation rules | Description |
|---|---|---|---|---|
| `Row ID` | Text | **Required (all types)** | Unique within the file. Recommended pattern `TXN-0001`, `TXN-0002`, … Non-empty, ≤ 40 chars. | The AI-assigned identifier of this row *within this file only*. Used by `Sell_Allocations` to point at rows, and by the import report to name rows. Has no meaning outside the file and is **not** stored as identity. |
| `Ledger Transaction ID` | Text | Optional (all types) | If present, must be an ID that exists in the Internal Trade Ledger; an unknown value fails the row. | **Round-trip only.** Populated exclusively when the file was produced from a prior Trade Manager export (or edited from one). An AI extracting from broker documents **must never invent, guess, or fabricate this value — leave it blank.** When present it is the absolute identity match (§8 tier 1). |
| `Transaction Type` | Enum | **Required (all types)** | Exactly one of `BUY`, `SELL`, `DIVIDEND`. | What the row is. Anything else (`DEPOSIT`, `TRANSFER`, `FUND`, …) rejects the row — out-of-scope operations are never coerced into a supported type. |

### 4.2 Instrument

| Column name | Data type | Required | Validation rules | Description |
|---|---|---|---|---|
| `Ticker` | Text | **Required (BUY, SELL)**; Optional (DIVIDEND) | Uppercase letters/digits, 2–6 chars (EGX tickers are typically exactly 4 letters). Normalized (trimmed, uppercased) before matching. | Exchange ticker symbol as printed by the broker. If genuinely unreadable in the source, leave blank and fill `Company Name` — the row is then routed to the import report as *needs ticker* for the user to resolve (never guessed by the AI, never silently dropped by the importer). |
| `Company Name` | Text | Optional | ≤ 200 chars | Company name as printed. Enriches the ledger and corroborates ticker resolution; especially important whenever `Ticker` confidence is low or blank. |
| `ISIN` | Text | Optional | 12 chars: 2 letters + 9 alphanumerics + 1 check digit | The instrument's ISIN / symbol code when the source prints one (e.g. Thndr invoices print an ISIN-like "Symbol Code"). A second, independent corroborating signal for instrument identity. |
| `Exchange` | Text | Optional | ≤ 20 chars | Listing exchange as printed. Defaults to `EGX` when blank. |

### 4.3 Execution

| Column name | Data type | Required | Validation rules | Description |
|---|---|---|---|---|
| `Trade Date` | Date | **Required (all types)** | ISO `YYYY-MM-DD`; a real calendar date; not in the future (relative to import day, +1 day tolerance for timezone skew). | Execution date for BUY/SELL; payment date for DIVIDEND. |
| `Trade Time` | Time | Optional (BUY, SELL); blank (DIVIDEND) | 24h `HH:MM` or `HH:MM:SS`. | Execution time **only when the source prints one**. Never fabricate; in particular **never emit `00:00` as a filler** — Trade Manager treats a real, differing time on two otherwise-identical rows as proof they are two different executions, so a fabricated time corrupts duplicate detection. Blank means "unknown". |
| `Quantity` | Number | **Required (BUY, SELL)**; blank (DIVIDEND) | Integer > 0 (EGX equities trade in whole shares). | Number of shares in this single execution. |
| `Price` | Number | **Required (BUY, SELL)**; blank (DIVIDEND) | > 0; ≤ 6 decimal places; plain number. | Per-share execution price, in `Currency`. |
| `Gross Amount` | Number | Optional (BUY, SELL); blank (DIVIDEND) | > 0. Cross-check: must equal `Quantity × Price` within 0.05 or 0.1% (whichever is larger), else the row is flagged *inconsistent* for user review. | The source's own printed gross value when available. A deliberate redundancy: it catches OCR/extraction digit errors in `Quantity` or `Price` that no single field could reveal. |
| `Fees` | Number | Optional (BUY, SELL); blank (DIVIDEND) | ≥ 0. Blank = unknown → imported as 0 with a per-row "fees unknown" note. | Total commissions/fees the broker charged on this execution, as printed. Never estimated from a fee schedule. |
| `Taxes` | Number | Optional (BUY, SELL); blank (DIVIDEND) | ≥ 0. Blank = unknown → imported as 0 with a per-row "taxes unknown" note. | Total taxes/stamp duties withheld on this execution, as printed. Kept separate from `Fees` for reporting; economically both flow into cost basis / net proceeds identically. |
| `Net Amount` | Number | Optional (BUY, SELL); blank (DIVIDEND) | > 0. Cross-check: BUY → `Gross + Fees + Taxes`; SELL → `Gross − Fees − Taxes`; same tolerance as `Gross Amount`, else flagged *inconsistent*. | The source's printed total debit (BUY) / credit (SELL). Second arithmetic tripwire. |
| `Dividend Amount` | Number | **Required (DIVIDEND)**; blank (BUY, SELL) | > 0 | Total cash received for this dividend payment, in `Currency`. |
| `Dividend Per Share` | Number | Optional (DIVIDEND); blank (BUY, SELL) | > 0 | Per-share dividend rate when the source prints it. Corroboration/enrichment only. |
| `Currency` | Text | Optional (all types) | ISO 4217 code | Currency of every money field in the row. Blank → `Metadata.Default Currency` → `EGP`. v1.0 importers accept `EGP` only and reject other currencies with a clear per-row error (the app is EGP-denominated); the column exists so v1.x can widen without a schema break. |
| `Order Type` | Enum | Optional (BUY, SELL); blank (DIVIDEND) | `LIMIT` or `MARKET` | As printed on order screens/notifications. Corroboration metadata only. |

### 4.4 Traceability (reconciliation, validation, auditing)

Every field below is optional, but **an AI must fill every one the source
makes visible** — these are what let Trade Manager corroborate a transaction
across independent sources and audit any row back to its document years later.

| Column name | Data type | Required | Validation rules | Description |
|---|---|---|---|---|
| `Broker Name` | Text | Optional — strongly recommended | ≤ 100 chars | Broker/platform the source came from (e.g. `Thndr`, `EFG Hermes`). |
| `Broker Account` | Text | Optional | ≤ 60 chars | Account number/reference printed on the source, when present. Distinguishes multi-account users' documents. |
| `Source Type` | Enum | **Required (all types)** | One of `STATEMENT`, `INVOICE`, `ORDERS_SCREEN`, `NOTIFICATION`, `EMAIL`, `SCREENSHOT`, `CSV_EXPORT`, `PDF`, `EXPORT`, `OTHER` | What kind of evidence this row was extracted from. `EXPORT` is reserved for files round-tripped from Trade Manager's own export. Feeds the evidence graph's source-authority reasoning. |
| `Source File` | Text | Optional | ≤ 255 chars | Filename of the source document (e.g. `statement-2026-03.pdf`, `IMG_2214.png`). |
| `Source Page` | Integer | Optional | ≥ 1 | Page number within the source document where this row appears. |
| `Statement Date` | Date | Optional | ISO `YYYY-MM-DD` | The statement's own issue/period-end date, when the source is a statement. Distinguishes two statements covering overlapping periods. |
| `Transaction Reference` | Text | Optional — **the single most valuable traceability field** | ≤ 60 chars; broker-issued, copied exactly as printed. | The broker's unique per-execution identifier (e.g. Thndr's invoice "Transaction No."). Maps to the ledger's `transactionNumber` and is the strongest duplicate/identity signal after `Ledger Transaction ID` (§8 tier 2). Never constructed or derived — only copied. |
| `Order Number` | Text | Optional | ≤ 60 chars | The broker's order identifier, when distinct from the execution reference (one order can fill in several executions). |
| `Execution Number` | Text | Optional | ≤ 60 chars | A per-fill execution/trade number when the broker prints it separately from both order number and transaction reference. |
| `Extraction Confidence` | Enum | Optional | `HIGH`, `MEDIUM`, or `LOW`. Blank → `MEDIUM`. | The AI's own honest confidence in this row's extraction (glare, blur, ambiguous glyphs, inferred ticker…). Maps to the ledger's per-fact `confidence` and drives review emphasis in the import UI — a `LOW` row is never hidden, only visibly flagged. |
| `Extraction Notes` | Text | Optional | ≤ 500 chars | Free text from the AI about anything ambiguous ("date partially obscured, could be 03 or 08", "ticker inferred from company name"). Shown to the user during review; stored as an audit note. |

### 4.5 Row-level (cross-field) validation

Applied after per-cell validation, before any matching:

1. **Type/field matrix** — required-for-type cells non-blank, must-be-blank
   cells blank (see each column above). Violations reject the row with a
   named reason; the rest of the file continues.
2. **Arithmetic cross-checks** — `Gross Amount` / `Net Amount` tolerances as
   specified. Failing a cross-check never silently "fixes" any number; the
   row is imported only after the user reviews the flagged inconsistency.
3. **`Row ID` uniqueness** across the sheet; duplicates fail the file (they
   make `Sell_Allocations` ambiguous).
4. **Tracking window** — rows dated before the user's configured tracking
   start date are skipped with a per-row note (mirrors the existing OCR
   import cutoff behavior), never errored.
5. A file with zero valid `Transactions` rows fails with a summary of every
   rejection — an empty import is never reported as success.

---

## 5. Sheet `Sell_Allocations`

Explicit lot allocation for SELL rows — **only when the allocation is
actually known** (from a prior Trade Manager export being edited, or a source
that itself names lots). An AI extracting from ordinary broker documents will
usually leave this sheet empty: broker documents state *that* you sold, not
*which lots* you sold, and this schema never lets anyone guess.

| Column name | Data type | Required | Validation rules | Description |
|---|---|---|---|---|
| `Sell Row ID` | Text | **Required** | Must equal the `Row ID` of a `Transactions` row whose type is `SELL`. | Which sell in this file is being allocated. |
| `Buy Row ID` | Text | Conditional | Must equal the `Row ID` of a `Transactions` row whose type is `BUY` and whose `Ticker` matches the sell's. **Exactly one of `Buy Row ID` / `Buy Ledger Trade ID` must be present.** | Allocates against a BUY that appears *in this same file*. |
| `Buy Ledger Trade ID` | Text | Conditional | Must be the Ledger Transaction ID of an existing BUY trade in the Internal Trade Ledger, same ticker. Unknown ID fails the allocation row. **Exactly one of the two Buy references.** | Allocates against a BUY that already lives in Trade Manager (round-trip / follow-up files). Never fabricated — only ever copied from an export. |
| `Shares Allocated` | Number | **Required** | Integer > 0. Per sell: Σ `Shares Allocated` ≤ that sell's `Quantity`. Per buy lot: Σ across the file ≤ that lot's (remaining) shares. | How many of the sell's shares close against this specific BUY lot. |

Allocation semantics:

- A SELL with allocation rows summing to its full `Quantity` imports fully
  allocated.
- A SELL with partial or no allocation rows imports as an **unallocated (or
  partially allocated) sell execution**: it is a real, recorded fact, visible
  in the app as *awaiting allocation*, and the user completes the lot
  selection in-app with the existing explicit lot picker. It never
  auto-allocates by FIFO/LIFO/average cost.
- Invalid allocation rows (unknown references, ticker mismatch,
  over-allocation) reject **only the allocation**, never the sell execution
  itself — the fact that shares were sold is independent of how they close.

---

## 6. Field ownership

### Populated by the external AI (the Excel file)

Every column in §3, §4, §5 — with one exception: `Ledger Transaction ID`
and `Buy Ledger Trade ID` are only ever *copied* from a prior Trade Manager
export, never originated by an AI.

### Generated and permanently managed by Trade Manager (never in the Excel, never editable)

| Internal field | Purpose |
|---|---|
| **Ledger Transaction ID** (`RawTransaction.id`) | Generated exactly once at first import, never changes, permanently identifies the transaction across every future edit and import. Echoed back out in exports so future files can round-trip identity. |
| `seq` | Monotonic append order; the only ordering used to resolve write races. |
| `recordedAt` | Ingestion wall-clock timestamp; audit only. |
| `source` / `extractionMethod` / `parserVersion` | Provenance: this import channel is stamped as its own source (`exchange-excel`), with the STES schema version + importer version as the parser version. |
| `sourceUploadId` + stored file & file hash | The imported Excel is archived like every other evidence document, so any ledger fact can be traced to the exact file (and row) it came from, and an identical re-upload is recognized at file level. |
| Supersede chain (`Correction` / `Retraction` facts) | Edits are new facts pointing at old ones — the original is never mutated or deleted. |
| Canonical event identity, `remainingShares`, `sellGroupId`, derived positions/holdings, caches | Deterministically regenerated projections — never imported, never hand-edited. |

### Editable by the user (in-app, after import)

- **Portfolio assignment** — deliberately *not* a schema column: which
  portfolio a trade belongs to is Trade Manager organization, not a fact any
  source document contains. Assignment happens in the existing Distribute
  step and is recorded as its own `PortfolioAssignment` fact.
- Sell → lot allocations (creating/completing `SellAllocationDecision`s).
- Notes, strategy tags, sector override, journal content.
- Corrections to execution facts (price, fees, taxes, date, time, ticker,
  company name, transaction reference) — always via an explicit, user-approved
  `Correction` fact, never by mutating the original row.

### Never editable by anyone

Ledger Transaction ID, `seq`, `recordedAt`, the original imported fact's
content (corrections layer on top; the original stays forever), and every
derived projection.

---

## 7. Import: transforming a row into the Internal Trade Ledger

Import is deterministic: the same file against the same ledger state always
produces the same outcome. Pipeline per file:

1. **File gate** — sheet presence, `Metadata` validity, header validation,
   file-hash lookup (an already-imported identical file is reported as such
   up front; matching still runs, since the ledger may have changed since).
2. **Row validation** — §4.5 / §5 rules. Each row gets a verdict:
   `valid`, `rejected(reason)`, `flagged(reason)`, or `skipped(reason)`.
3. **Matching & classification** (§8, §9) — every valid row is classified
   `new`, `duplicate`, `modified`, or `conflict` against the Internal Trade
   Ledger.
4. **Review & commit** — new rows flow into the existing Import review pool
   (grouped by ticker, per-ticker portfolio picker, verification banners —
   the same two-phase Extract → Distribute workflow OCR imports use).
   Nothing writes to the ledger without passing the same review gate.
5. **Ledger append** — each committed row becomes exactly one fact:

| Excel row | Ledger fact appended | Then |
|---|---|---|
| `BUY` | One `BuyExecution` RawTransaction (`ticker`, `shares` ← Quantity, `price`, `fees`, `taxes`, `executionDate` ← Trade Date, `executionTime` ← Trade Time, `companyName`, `transactionNumber` ← Transaction Reference) | The Ledger Engine canonicalizes it into one `LotOpened` event → **one immutable, independent Trade**. Two BUY rows are two facts are two lots, always. |
| `SELL` | One `SellExecution` RawTransaction (same field mapping) | Recorded as a real execution. No lot is touched yet. |
| `Sell_Allocations` rows for a sell | One `SellAllocationDecision` RawTransaction referencing the sell execution and each named lot with its share count | The Allocation Engine closes exactly the named shares of exactly the named lots. |
| `DIVIDEND` | One `DividendPayment` RawTransaction (`ticker`, `amount` ← Dividend Amount, `date` ← Trade Date) | Timelined at its real payment date. |

Every appended fact carries: `source: "exchange-excel"`, the Upload ID of the
archived Excel file, the row's `Extraction Confidence` as `confidence`,
`parserVersion` = `stes-1.0/<importer version>`, plus the traceability fields
(broker, source type/file/page, statement date, order/execution numbers,
extraction notes) preserved on the fact for auditing. Trade Manager then mints
the row's **Ledger Transaction ID** — the fact's own permanent `id`.

### Verification philosophy at import time

External evidence first, ledger as final authority:

- When multiple **independent** sources corroborate the same execution without
  conflict — within one file (e.g. an invoice-derived row and a
  statement-derived row carrying the same `Transaction Reference`) or across
  a file and previously imported documents — the transaction validates on
  that agreement (the existing verification engine's corroboration edges).
- When evidence is incomplete, conflicting, ambiguous, or insufficient, the
  **Internal Trade Ledger is consulted and is final**: facts already in the
  ledger are fully confirmed. External evidence **never automatically
  overwrites** a confirmed transaction; it may only identify new transactions,
  match existing ones, detect inconsistencies, enrich missing metadata, and
  prevent duplicates. Every conflict is reported to the user, and only
  explicit user approval writes a `Correction` fact.

### Import report

Every import ends with a per-row report (keyed by `Row ID`): imported as new
(with its minted Ledger Transaction ID), matched duplicate (with the matched
ID and tier), proposed modification (field diff, awaiting approval), conflict
(what disagrees with what), rejected/flagged/skipped (reason). Nothing is ever
silently dropped.

---

## 8. Duplicate detection

Re-importing the same file — or the same transactions via a different source
document — any number of times must never duplicate a transaction. Matching
runs per row, most-authoritative signal first; the first decisive tier wins:

- **Tier 0 — file identity.** The workbook's hash matches an archived upload
  → the whole file is known; rows still run tiers 1–3 individually (the
  ledger may have gained or corrected rows since the last import).
- **Tier 1 — Ledger Transaction ID.** Present and found → *this exact
  transaction*, regardless of every other cell. Attributes identical →
  `duplicate` (skip). Attributes differ → `modified` (§9). ID present but
  unknown → `conflict` (likely a foreign or stale export; never guessed
  around).
- **Tier 2 — Transaction Reference.** A broker-issued execution ID matching a
  ledger fact's `transactionNumber` for the same normalized ticker → same
  execution, regardless of date/shares/price (the broker's own identity
  outranks re-extracted attributes). Attributes identical → `duplicate`;
  differing → `modified`. Conversely, a *mismatching* reference **excludes** a
  ledger row from tier-3 candidacy even when its attributes look identical —
  two different reference numbers are two different executions.
- **Tier 3 — attribute fingerprint.** Normalized ticker + type + `Trade Date`
  + `Quantity`, with two refinements the ledger already enforces:
  *(a)* two rows both carrying real, differing execution times are **proven
  distinct** (an ordinary same-day accumulation pattern, not a re-import) —
  which is exactly why fabricated `00:00` times are banned in §4.3; *(b)*
  matching is **count-aware and one-to-one**: file rows are matched to ledger
  rows 1:1, so if the ledger holds one such execution and the file holds two
  indistinguishable ones, one is a duplicate and one imports as new. Price
  equal → `duplicate`; price differing beyond tolerance → `conflict`
  ("same execution, different price — which source is right?") surfaced for
  review, never auto-resolved.
- **No tier matches** → `new`.

Dividends match on ticker + date + amount (the same content-identity rule the
in-app import pool already uses), since brokers issue no per-dividend
reference number.

Duplicates are skipped silently in the ledger but *visibly* in the report.
`conflict` and `modified` rows always stop for the user.

---

## 9. Recognizing edited transactions on re-import

The round-trip flow: Trade Manager exports ledger transactions **in this same
STES format** with `Ledger Transaction ID` (and `Buy Ledger Trade ID` on
allocation rows) filled in. A user — or an AI on their behalf — edits the
file (fix a misread price, correct a fee) and re-imports it.

1. **Identity first.** The row is matched by tier 1 (Ledger Transaction ID)
   or tier 2 (Transaction Reference). Identity fields are never what's
   "edited" — they are how the edit finds its target. A row whose identity
   matches nothing is just a new transaction.
2. **Field diff.** The matched ledger fact's current *folded* view (original
   plus every approved correction so far) is diffed against the row, over the
   correctable fields: price, fees, taxes, trade date, trade time, ticker,
   company name, transaction reference.
3. **Propose, never apply.** Each differing field becomes a proposed
   `Correction` fact (a patch targeting the Ledger Transaction ID), presented
   to the user as an explicit before/after diff. The ledger is authoritative:
   nothing changes until the user approves. On approval the correction is
   appended — the original fact survives untouched underneath, the Ledger
   Transaction ID never changes, and every projection regenerates
   deterministically.
4. **Quantity is not casually correctable.** A share-count change on a BUY
   that already has allocations against it (or on an allocated SELL) can
   invalidate allocations; the importer refuses to propose it as a simple
   patch and instead directs the user to the in-app flow (retract +
   re-record, which forces the allocation question to be re-answered
   explicitly).
5. **Removing a row from the file is not a deletion.** Absence of a
   previously exported transaction means nothing — files are partial views.
   Deletion only ever happens in-app, as an explicit `Retraction` fact.

First import (no Ledger Transaction ID anywhere) degrades gracefully: tier 2
then tier 3 do the matching, exactly as §8 — which is also how a *different
document* describing an already-imported transaction (the statement arriving
after the invoice) enriches instead of duplicates: matched rows contribute
their traceability fields and corroboration edges to the existing fact.

---

## 10. Versioning & extensibility

- `Schema Version` is `MAJOR.MINOR`. **Minor** bumps only ever add optional
  columns or enum values — every v1.x file remains importable by every v1.y
  importer (unknown optional columns ignored with a warning). **Major** bumps
  may change semantics and require explicit importer support.
- Reserved growth paths, deliberately pre-shaped in v1.0: `Currency` (multi-
  currency), `Exchange` (non-EGX listings), `Source Type` enum growth (new
  evidence channels), additional traceability identifiers (add as optional
  columns, never overload existing ones).
- Never reuse or repurpose a column name. Retired columns stay reserved.

## 11. Rules for generating AIs (the contract, in one place)

1. One row per executed BUY. **Never aggregate**, even same ticker/day/price.
2. One row per executed SELL; allocations only on `Sell_Allocations`, and only
   when the source or a prior export actually states them. Never assume
   FIFO/LIFO/average cost.
3. Only `BUY`, `SELL`, `DIVIDEND`. Skip deposits/withdrawals/transfers/funds
   entirely — do not smuggle them in as any supported type.
4. Blank means unknown. Never fill with `0`, `N/A`, or guesses; never
   fabricate times (**no `00:00` filler**), references, ISINs, tickers, or
   Ledger Transaction IDs.
5. Copy identifiers (`Transaction Reference`, `Order Number`,
   `Execution Number`, `Broker Account`, ISIN) *exactly* as printed —
   they are matching keys, not descriptions.
6. Fill every traceability field the source shows; set `Extraction
   Confidence` honestly and explain doubts in `Extraction Notes`.
7. Dates ISO `YYYY-MM-DD`; times 24h; plain decimal numbers without
   separators or symbols; enums uppercase; one `Metadata` sheet declaring
   `Schema Version` `1.0`.
8. When the same execution appears in several source documents you are
   processing at once, emit it **once**, from the most authoritative source
   (invoice/statement over screenshot/notification), and mention the
   corroborating sources in `Extraction Notes`.

---

## Appendix A — example

`Transactions` (columns abridged for readability; a real file carries all of §4):

| Row ID | Transaction Type | Ticker | Company Name | Trade Date | Trade Time | Quantity | Price | Fees | Taxes | Dividend Amount | Broker Name | Source Type | Source File | Transaction Reference | Extraction Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TXN-0001 | BUY | COMI | Commercial International Bank | 2026-03-02 | 11:42 | 100 | 82.50 | 12.38 | 4.13 | | Thndr | INVOICE | invoice-88213.pdf | 88213 | HIGH |
| TXN-0002 | BUY | COMI | Commercial International Bank | 2026-03-02 | 13:05 | 50 | 82.10 | 6.16 | 2.05 | | Thndr | INVOICE | invoice-88307.pdf | 88307 | HIGH |
| TXN-0003 | SELL | COMI | Commercial International Bank | 2026-04-10 | | 120 | 90.00 | 16.20 | 5.40 | | Thndr | STATEMENT | statement-2026-04.pdf | 91544 | MEDIUM |
| TXN-0004 | DIVIDEND | EAST | Eastern Company | 2026-03-20 | | | | | | 340.00 | Thndr | SCREENSHOT | IMG_2214.png | | MEDIUM |

`Sell_Allocations` (present only because a prior export made lot identity known):

| Sell Row ID | Buy Row ID | Buy Ledger Trade ID | Shares Allocated |
|---|---|---|---|
| TXN-0003 | TXN-0001 | | 100 |
| TXN-0003 | TXN-0002 | | 20 |

Outcome: two independent COMI lots (two buys on the same day are two trades,
permanently); one sell execution explicitly closing 100 shares of the first
lot and 20 of the second — lot one closed, lot two partial with 30 remaining;
one dividend timelined at its real payment date. Re-importing this exact file
later: four duplicates, zero writes, a report saying exactly that.

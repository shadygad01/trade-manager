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

**No other inconsistency of this class was found.** The remaining trust-policy
call sites (`constraintValidation.ts`, `completenessEngine.ts`,
`checkTickerMatch` itself) already draw the Excel/Invoice distinction
correctly and were left unchanged.

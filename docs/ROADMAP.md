# Roadmap

This is a living gap-analysis-driven backlog, not a fixed spec. Each sprint: audit the repo against the product vision, pick the highest-leverage items, implement, test, document — never the whole backlog at once.

## Product vision (north star)

Portfolio OS is a Trade & Portfolio Management platform for Egyptian retail investors, built around one principle: **investors think in trades, not holdings.** Every Buy is an immutable, permanently-attributable Trade; a Holding is just the arithmetic sum of open trades. Selling always requires explicitly naming which trade(s) close, never FIFO/average-cost. See [ARCHITECTURE.md](ARCHITECTURE.md) for the enforced architectural decisions behind this.

## Sprint log

### Sprint 1 — Bootstrap
Stood up the standalone repo, Clean Architecture (domain/application/infrastructure/presentation), the full trade/allocation/portfolio domain model, the analytics engine's extensible registry, the Dexie persistence layer, the Thndr OCR import subsystem, GitHub Pages deployment, and CI. See the root commit for full scope.

### Sprint 1.1 — Ground-truth reconciliation
Added `reconcilePositions` (mismatch/shortfall/staleness detection against broker "My Position" screenshots) and `duplicateDetection` (flagging parsed import candidates that look like trades already on the ledger) — both were part of the original product spec but missed in the initial bootstrap.

### Sprint 2 — Correctness fix + Portfolio Health + Strategy Attribution
**Gap analysis found:**
1. **Correctness bug**: `ParsedTradeCandidate.taxes` was parsed but silently dropped everywhere — `Trade`/`TradeAllocation` had no `taxes` field, so any broker-reported tax understated real cost basis and realized P/L.
2. No `companyName` retained on `Trade` (only on verification screens).
3. Trade status was binary (Open/Closed); no "Partial" state despite partial-sell being the core differentiator.
4. No Portfolio Health view (cash ratio existed in analytics but no concentration/diversification/composite score).
5. No Strategy Attribution despite `strategyTags` being captured on every trade.

**Shipped:**
- `taxes: number` added to `Trade` and `TradeAllocation`, flowing through cost basis, realized P/L, and cash math exactly like `fees` (see `docs/DATA_MODEL.md`); wired through OCR import, manual Buy/Sell forms.
- `companyName?: string` added to `Trade` and `ParsedTradeCandidate`; ThndrParser now resolves and attaches it to every parsed candidate, not just verification screens.
- `getTradeStatus()` (`open`/`partial`/`closed`) replacing the binary Open/Closed badge on `TradesPage`.
- `portfolioHealth` calculator: cash ratio, largest position, Herfindahl-index concentration score, diversification score, largest realized winner/loser, composite 0-100 health score. Surfaced on `AnalyticsPage`.
- `strategyAttribution` calculator: win rate/profit factor/total realized P/L per strategy tag (a trade with multiple tags attributes to each). Surfaced on `AnalyticsPage`.
- 17 new tests (152 total).

**Deliberately deferred** (see Next Sprint): Buy Zone visualization, Sell Map visualization, Capital Deployment flow diagram, cross-portfolio equity comparison, OCR confidence scoring. These are UI/visualization-heavy and independent of the correctness fix and analytics additions above — bundling them into the same sprint would have diluted review quality on both.

### Sprint 3 — Buy Zone, Sell Map, Capital Deployment, portfolio comparison, OCR confidence

Executed the full "Next recommended sprint" list from Sprint 2 in one pass (user directed a longer run than the usual 2-3 item cap):

- **Buy Zone visualization** (`BuyZoneChart`, on `TradesPage`): one horizontal bar per Buy lot at its entry price, with a reference line at the current price, so an investor sees exactly where capital entered relative to today's market.
- **Sell Map**: folded into the same chart — bar color/opacity encodes each lot's `getTradeStatus()` (open/partial/closed) plus a labeled count legend, since "which lots are still open" and "where did they enter" are one visual question, not two.
- **Palette finding**: running the dataviz skill's validator against this app's dark chart surface showed `STATUS.warning` fails the lightness-band check standalone (only `STATUS.good`+`STATUS.critical` pass together). `BuyZoneChart` avoids the failing color entirely — "partial" is `STATUS.good` at reduced opacity (a sanctioned secondary encoding) and "closed" reuses the existing neutral `CHART_AXIS` token, rather than introducing a new unvalidated hue.
- **Capital Deployment flow** (`CapitalDeploymentFlow`, on `PortfolioDetailPage`): a chronological, horizontally-scrollable strip of cash/trade events — not a chart (no axes/magnitude encoding), so it reuses `TimelinePage`'s existing icon/color mapping instead of going through the chart-color procedure.
- **Cross-portfolio equity comparison** (`DashboardPage`, "Portfolio Comparison"): each portfolio's equity curve indexed to 100 at its first point (so wildly different portfolio sizes share one axis as growth %, never a dual-axis chart), one line per portfolio in the app's validated categorical order, capped at 8 with a note if more exist.
- **OCR confidence scoring**: `ParsedTradeCandidate.confidence` (`"high"|"medium"|"low"`), computed from how the ticker was resolved (exact/prefix/fuzzy/unmapped match) combined with how reliable the parse path itself is (row-isolated rescan > flat orders-screen parse; pixel-color status > OCR'd status word) — surfaced as a labeled dot in `ImportPage`'s candidate table. Never hides a candidate, only cues the user to double-check it.
- 6 new tests (155 total); all previously-passing tests unchanged.

### Sprint 4 — Multi-broker OCR, Lessons Learned view, code-splitting

- **`CsvStatementParser`**: second `BrokerParser` implementation (plain CSV/TSV transaction exports — flexible header aliases, delimiter auto-detection, d/m/y or ISO dates), proving the pluggable OCR interface against a real second input shape rather than just Thndr. `ImportOrchestrator` now routes non-image/non-PDF files to their raw decoded text instead of assuming everything non-image is a PDF. Extracted `trackedDateRange.ts` out of `ThndrParser.ts` first (shared rolling-cutoff helper) so the second parser didn't have to fork that logic.
- **Lessons Learned view** (`JournalPage`): a "Lessons Learned" tab aggregating `JournalEntry.lessonsLearned` across every trade in the portfolio, most recent first, each linking back to its trade's full journal entry — answers "what mistakes am I repeating" without clicking into every trade individually.
- **Code-splitting**: `ImportOrchestrator` (and transitively Tesseract.js/pdfjs-dist) is now a dynamic `import()` in `data.ts` instead of a static one, and every page is now `React.lazy`-loaded in `App.tsx`. Main entry bundle dropped from ~1.27MB (gzip ~365KB) to ~266KB (gzip ~87KB); the OCR subsystem is now its own ~472KB chunk fetched only when a user actually opens Import. No more Vite chunk-size warning.
- 19 new tests (168 total).

### Post-sprint-4 fix — Import made portfolio-agnostic

User-reported real workflow gap: Import was scoped to one portfolio (`/portfolios/:id/import`), so a single statement screenshot containing several buys meant for *different* portfolios (e.g. some shares for "Investment", others for "Trading") couldn't be split correctly — every candidate landed in whichever portfolio the user happened to be inside.

- Import moved to a global route (`/import`), always in the sidebar, no longer gated behind selecting a portfolio first.
- Each parsed candidate and each position-verification row gets its own portfolio picker at review time (defaults to the first portfolio, changeable per row) — `recordBuy`/`recordSell`/verification-save all use the row's chosen portfolio, not a single page-wide one.
- `Upload.portfolioId` is now optional and `UploadRepository.getByHash` is global (file-hash dedup no longer scoped per portfolio) — a re-uploaded file is a duplicate regardless of which portfolio its candidates end up in. Duplicate-trade detection (`duplicateDetection.ts`) now checks against every portfolio's trades/allocations (`TradeRepository.getAll()`, new `TradeAllocationRepository.getAll()`), not just one.
- 5 new tests (173 total).

### Post-sprint-4 fix #2 — explicit two-phase Import workflow, grouped by ticker

Follow-up user feedback refined the order further: extract everything first and confirm extraction is complete, *then* distribute — and a ticker's sells must automatically follow its buys to whichever portfolio they're assigned to, not be assigned separately.

- `ImportPage` rebuilt around two explicit phases: **Step 1 — Extract** (drop as many files as needed; every file's candidates/verifications accumulate into one pool instead of replacing the previous file's results, with a running "N transactions from M files" counter as the completion signal) and **Step 2 — Distribute** (the pool grouped by ticker, one card per ticker).
- Each ticker card has exactly **one** portfolio picker shared by every buy, sell, and verification row for that ticker — assigning a ticker to a portfolio carries its sells along automatically, since a sell can only allocate against lots that exist in a specific portfolio.
- Buys within a ticker group are listed before sells, so the natural click order (add buys, then allocate sells) always has open lots to allocate against by the time the user reaches them.

### Post-sprint-4 fix #3 — batch multi-file selection

Immediate follow-up: Step 1 still required choosing and extracting one file at a time. The file input now accepts multiple files (`multiple` attribute) and the drop handler reads the whole `FileList`/drop payload, not just the first entry — selecting or dropping several files at once queues and processes them sequentially through one Tesseract worker (a "Processing X of N: filename" indicator tracks progress), with each file's outcome (extracted / duplicate / warnings) shown once the batch finishes and its transactions folded into the same running Step 1 pool.

### Post-sprint-4 fix #4 — extraction pool lost on navigation (real data-loss bug)

User-reported: after uploading files, navigating to Portfolios to create one, then back to Import — the entire extracted pool was gone. Root cause: `pendingCandidates`/`pendingVerifications`/`tickerPortfolio`/etc. lived in `ImportPage`'s local `useState`, which React discards the moment the component unmounts — exactly what happens when navigating away, even within the same SPA session.

- Extracted `src/presentation/lib/importSession.ts`: a module-level store (not component state) for the Step 1/2 pool, persisted to `localStorage` and read via a `useSyncExternalStore`-backed `useImportSession()` hook — survives both in-app navigation and a full page reload.
- Added an explicit "Start over" action (`PageHeader` actions slot) to clear the session once a user is done distributing, since it no longer clears itself.
- This was a genuine data-loss bug in a shipped feature, not a nice-to-have — flagging in case any other page-local state should be audited for the same "does this need to survive navigation" question.

### Sprint 5 — Dividend history extraction from OCR

User-reported real gap, working from two Thndr "My Position" screenshots (EAST, COMI): the position-verification screen's "Earned Cash Dividends" section (a dated list of past payouts) was being extracted for units/avg-cost only — the dividend history itself was dropped on the floor.

- Domain: `ParsedDividendCandidate` (`ticker`, `companyName`, `date`, `amount`) alongside the existing `ParsedTradeCandidate`.
- `BrokerParser.parseDividends(text)` — new interface method. `ThndrParser` locates the `"Earned Cash Dividends"` marker and regex-matches each `<date> EGP <amount>` row beneath it, resolving the ticker from the same position-verification header used for units/avg-cost; `CsvStatementParser.parseDividends` is a no-op (a transaction CSV export has no such section). Verified against the exact text shape of both user-provided screenshots.
- `ImportOrchestrator.ImportResult` gained a `dividends` field, populated whenever a position-verification screenshot is parsed.
- `PortfolioService.recordDividend` gained an optional historical `date` — a dividend read from a screenshot is timelined to when it was actually paid, not to import time. Manually-entered dividends still default to now.
- `ImportPage`'s Step 2 distribution pool now includes a dividend row per ticker group ("Add as Dividend"), using the same per-ticker portfolio picker as its buys/sells/verifications.
- `DashboardPage` gained a "Total Dividends" stat tile, summing `Dividend`-type timeline events across every portfolio. Confirmed (by reading `equityCurve.ts`/`portfolioReturn.ts` directly, no code change needed) that dividends already flowed correctly into both the equity curve (summed like any other timeline event) and portfolio return (excluded from the deposits/withdrawals-only contributed-capital denominator, so they show up purely as return).
- 5 new tests (178 total).

### Sprint 6 — Move trades between portfolios, Import "Clear all"

Two user-reported real gaps from actually using the app: (1) no way to fix a trade assigned to the wrong portfolio, or to redistribute after changing their mind on how holdings should be split; (2) Import's "Start over" only cleared the in-progress extraction pool — a re-uploaded file was still flagged as a duplicate because its `Upload` record (used purely for hash-based dedup) stayed in IndexedDB forever.

- **`TradeService.moveTrade(repos, tradeId, targetPortfolioId)`**: reassigns a `Trade` to a different portfolio. The buy's original cost is refunded to the source portfolio and charged to the target, and any of its sells' net proceeds move the same way, so cash correctness is never sacrificed for a data-entry fix. If the trade was closed together with other lots under one multi-trade `sellGroupId`, the move transitively pulls in every trade sharing that sell (BFS closure over the source portfolio's allocations) — a single sell action can never end up split across two portfolios. Only `Buy`/`Sell`/`PartialSell` timeline events whose `relatedTradeIds` are entirely inside the moving set travel with it; portfolio-level events (deposits, dividends, cash adjustments) never do, since they aren't lot-specific. Rejects the move (mirroring `recordBuy`'s own guard) if the target portfolio can't cover the net cost.
- **`TradesPage`** gained a per-row "Move to another portfolio" action (a small icon button + modal, target-portfolio picker), with a heads-up alert when moving one lot pulled in others from a shared sell.
- **Import "Clear all"** (renamed from "Start over"): now also deletes every persisted `Upload` record (`UploadRepository.getAll`, new), not just the in-memory/localStorage extraction pool — so a cleared session genuinely lets the same file be re-imported without tripping the duplicate-file check. `Upload` rows are dedup-only bookkeeping with no other reader in the app, so wiping them has no effect on trades/portfolios already recorded.
- 6 new tests (184 total).

### Post-sprint-6 fix — duplicate position-verification/dividend rows during Import

User-reported real bug, from an actual screenshot: uploading the same "My Position" screenshot more than once (a re-take, an accidental double-drop) produced multiple identical "Broker position check" rows in Step 2 — one already accepted, several more sitting redundantly beside it. Unlike a Buy/Sell, a position-verification or dividend reading carries no per-transaction identity (no date+price+shares to distinguish one execution from another), so nothing previously stopped the same reading from being added to the pending pool every time it was re-extracted.

- `ImportPage.processFiles` now content-dedupes incoming verifications (`ticker+units+avgCost`) and dividends (`ticker+date+amount`) against what's already in the pending pool before adding them — a repeated identical reading is silently skipped rather than piling up, with a note added to that file's result ("already in the list — not added again") so it's visible, not silent.
- Scoped deliberately to verifications/dividends only: Buy/Sell candidates keep their existing duplicate-detection behavior (flagged with a badge, never auto-removed) since those are real transactions where "add anyway" is a legitimate, informed choice — a redundant position reading carries no such decision to make.

## Sprint 7 — architecture & progress review, then autonomous execution

A full repo audit against the product vision (Completed / Partial / Not Implemented / Architecture flags — see the review artifact) was run as a one-time checkpoint, approved, and is now being worked through without per-task check-ins, in priority order.

- **Cash Adjustment / Split / Rights Issue UI**: all three were fully implemented and tested at the service layer (`PortfolioService`) but had *zero* UI trigger anywhere — a user could not record any of them no matter how they tried. `PortfolioDetailPage` gained an "Adjust Cash" action (signed amount, required notes) reusing the existing cash modal, and a "Corporate Action" modal (Split / Rights Issue toggle, ticker, required details) — both record-only on the timeline, matching `recordSplit`/`recordRightsIssue`'s documented, deliberate scope (no automatic share/price rebasing).
- **Manual dividend date**: the Import flow already dated a dividend to when it was actually paid; the manual "Record Dividend" modal never collected that date and always used "now". It now has an optional date field, defaulting to now when left blank — consistent with the import path.
- **Strategy-tag duplication resolved**: `Trade.strategyTags` (set at fill time) and `JournalEntry.strategyTags` (set or edited later) were two independent, unsynced fields, and `strategyAttribution()` only ever read the first — a tag added during reflection in the Journal silently never affected the Strategy Attribution table. Rather than delete either field (would silently drop real user data already saved), `strategyAttribution()` now attributes by the **union** of both per trade; `AnalyticsInput` gained an optional `journalEntries` field, wired through on `AnalyticsPage` (the one place the table is rendered).
- **Ledger export/import** (`BackupService.ts`, new `/data` page): the single highest-consequence gap the review found — until now, a cleared browser profile meant total, unrecoverable data loss, since ADR-001's "no backend" trade-off had no manual escape hatch at all. Export produces one versioned JSON snapshot (every portfolio, trade, allocation, timeline event, journal entry, verification — deliberately excluding `Upload` rows, which are dedup bookkeeping, not financial data); import is a full replace, never a merge, so the ledger after restoring always exactly matches the file rather than a blend of old and new. Required adding `getAll()` to `TimelineRepository`/`JournalRepository`/`VerificationRepository` and `delete()` to `VerificationRepository` (neither existed before — the same completeness gap this feature was built to close), and adding `journal` to the shared `AppRepositories` type.
- 10 new tests (196 total).

### Post-sprint-7 fix — garbled ticker fallback + a way to correct one

User-reported real bug, from real (test) screenshots: the same underlying position/trade data showed up repeatedly under several different, meaningless 2-3 letter ticker groups ("TE", "HH", "HI", "HN", "EGF"). Root cause: `ThndrParser`'s header-ticker fallback (used whenever a screenshot's company name doesn't resolve against `KNOWN_EGX_TICKERS`) accepted *any* all-caps token from 2 to 6 letters as a "ticker" — but every real EGX ticker is exactly 4 letters (every entry in `KNOWN_EGX_TICKERS` is 4 chars), so a 2-3 letter OCR fragment from unrelated header text (an icon's label, a misread word) was silently accepted as a ticker every time, spawning a bogus, unstable group per upload.

- Tightened the fallback to require exactly 4 letters; anything shorter now correctly falls through to "couldn't resolve the ticker" rather than being fabricated. 2 new tests.
- Since OCR ticker resolution can't be made perfect for every company outside the known list, `ImportPage` also gained a direct correction tool: clicking a ticker group's heading in Step 2 turns it into an editable field, and confirming a new ticker moves every pending row (buys, sells, verifications, dividends) from the wrong ticker to the corrected one — a `renameTickerGroup` operation on the pending pool only, before anything is added as a real trade.
- Also explained in-app terminology to the reporting user: "Add as Trade" records a parsed Buy candidate as a real `Trade`; "Allocate Sell" opens the lot-picker so a parsed Sell candidate can specify exactly which open lot(s) it closes (per ADR-002 — this app never assumes FIFO).

## Next recommended sprint

1. **Split/Rights Issue automatic rebasing**: still deliberately out of scope (see `PortfolioService.recordSplit`/`recordRightsIssue`); revisit if a real user hits this.
2. **Sector Allocation**: still honestly unmodeled (no sector field on `Trade`/`Portfolio`) — either add one deliberately or keep the dashboard's honest "not yet modeled" empty state; don't fabricate data to fill the chart.
3. **OCR confidence-aware UX**: Sprint 3 added `confidence` scoring but it's only a passive badge today — consider auto-collapsing/deprioritizing low-confidence candidates in the Import review list, or requiring an explicit confirmation step before a "low" candidate can be added as a trade.
4. **A real second broker's screenshot format**: `CsvStatementParser` validated the interface with a non-OCR input; the OCR-specific parts of the interface (`parseOrdersScreenText`, `parseOrderRowsText`, `resolveHeaderTicker`) still only have one real implementation (Thndr) — worth validating against an actual second brokerage app's screenshots if/when real sample data is available.

Each of these should get its own gap-check at sprint start — this list is a starting point, not a commitment, and should be re-prioritized against whatever the repo audit finds at that time.

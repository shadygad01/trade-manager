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

## Next recommended sprint

1. **Split/Rights Issue automatic rebasing**: Sprint 2 deliberately left these record-only (see `PortfolioService.recordSplit`/`recordRightsIssue`); revisit if a real user hits this.
2. **Sector Allocation**: still honestly unmodeled (no sector field on `Trade`/`Portfolio`) — either add one deliberately or keep the dashboard's honest "not yet modeled" empty state; don't fabricate data to fill the chart.
3. **Multi-device sync / export-import**: ADR-001 accepted "no multi-device sync" as a limitation of the fully-client-side architecture — an explicit export/import (e.g. a signed JSON snapshot) would let a user move their ledger between devices without standing up a backend.
4. **OCR confidence-aware UX**: Sprint 3 added `confidence` scoring but it's only a passive badge today — consider auto-collapsing/deprioritizing low-confidence candidates in the Import review list, or requiring an explicit confirmation step before a "low" candidate can be added as a trade.
5. **A real second broker's screenshot format**: `CsvStatementParser` validated the interface with a non-OCR input; the OCR-specific parts of the interface (`parseOrdersScreenText`, `parseOrderRowsText`, `resolveHeaderTicker`) still only have one real implementation (Thndr) — worth validating against an actual second brokerage app's screenshots if/when real sample data is available.

Each of these should get its own gap-check at sprint start — this list is a starting point, not a commitment, and should be re-prioritized against whatever the repo audit finds at that time.

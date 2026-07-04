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

## Next recommended sprint

Priority-ordered, pick the top 2-3 per the "implement highest-priority only" rule:

1. **Buy Zone visualization** (`TradesPage`, grouped by ticker): plot each open lot's entry price so an investor sees exactly where capital entered — the most-cited differentiator in the product vision and the cheapest to build (data already exists in `openTrades`).
2. **Sell Map**: extend the existing lot-expansion UI on `TradesPage` into a clear open/partial/closed visual grouping per ticker (partial infrastructure already shipped this sprint via `getTradeStatus`).
3. **Capital Deployment flow**: a simple Sankey-style or stepped visualization of cash → ticker → cash movements, sourced from `TimelineEvent` + `Trade`/`TradeAllocation` history.
4. **Cross-portfolio equity comparison**: overlay each portfolio's equity curve (data already computed per-portfolio via `equityCurve`; needs a multi-portfolio aggregation view, likely on `DashboardPage`).
5. **OCR confidence scoring**: attach a per-candidate confidence signal to `ImportOrchestrator`'s output (e.g. based on which parse path resolved it — flat vs. row-isolated rescan — and whether digit-normalization/fuzzy-ticker-matching had to intervene) so low-confidence rows are visually distinct before the user confirms them.

Each of these should get its own gap-check at sprint start — this list is a starting point, not a commitment, and should be re-prioritized against whatever the repo audit finds at that time.

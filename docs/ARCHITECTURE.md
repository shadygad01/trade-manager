# Architecture

Portfolio OS is a **static, client-side application**. There is no backend server and no server-side database — everything a user does is persisted in the browser via IndexedDB, and the whole app ships as a static bundle to GitHub Pages. This was a deliberate choice (see [ADR-001](#adr-001-fully-client-side-no-backend) below), not a limitation carried over from anywhere else.

## Layering

```
presentation  →  application  →  domain
infrastructure  →  domain
```

Dependencies only ever point inward. `domain` depends on nothing. `application` depends only on `domain` (it is written entirely against the repository *interfaces* in `src/domain/repositories`, never a concrete Dexie class). `infrastructure` implements those same interfaces. `presentation` is the only layer that wires a concrete `infrastructure` implementation into `application` services.

| Layer | Path | Contents |
|---|---|---|
| Domain | `src/domain/` | `entities/` (Portfolio, Trade, TradeAllocation, TimelineEvent, JournalEntry, PositionVerification, Upload), `value-objects/` (Money, Ticker, id, knownTickers), `repositories/index.ts` (the ports) |
| Application | `src/application/` | `services/TradeService.ts`, `services/PortfolioService.ts`, `services/BackupService.ts` (use cases), `analytics/` (the analytics engine — see [ANALYTICS_ENGINE.md](ANALYTICS_ENGINE.md)) |
| Infrastructure | `src/infrastructure/` | `db/` (Dexie adapters), `market-data/` (price snapshot client), `ocr/` (the import pipeline — see [OCR_SUBSYSTEM.md](OCR_SUBSYSTEM.md)) |
| Presentation | `src/presentation/` | React pages/components, wired to `application` services via `infrastructure` repositories |

This means the entire trade/allocation/analytics logic is testable with in-memory fakes and has zero dependency on IndexedDB, Tesseract, or React — see `src/application/testUtils/fakeRepositories.ts` and the 200+ tests across the three inner layers.

This layering is machine-enforced, not just documented: `.dependency-cruiser.cjs` encodes the same inward-only rules (domain → nothing, application → domain only, infrastructure → domain only) and runs as part of `npm run lint` (`npm run arch:check` to run it alone) — a stray import that reaches outward across a layer boundary fails CI instead of just failing code review.

For the finer-grained subsystem-by-subsystem dependency graph inside this layering (which engine depends on which, which Dexie tables are shared, what's safe to work on in parallel), see [EXECUTION_GRAPH.md](EXECUTION_GRAPH.md).

## Testing the presentation layer

Every test above is domain/application/infrastructure-only by design — pure functions and repository interfaces need no DOM. `presentation` has its own, smaller test surface: React Testing Library + jsdom (`@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`), added once the review flagged zero component coverage as the single biggest gap given how much of this app's real regressions have been UI-only (a silently-vanishing button, a swallowed error). Component test files opt into a DOM environment per-file with a `// @vitest-environment jsdom` comment at the top (the global default stays `"node"` for every other test, which doesn't need one); `src/presentation/testUtils/setupTests.ts` registers jest-dom's matchers and an `afterEach(cleanup)` (needed because this codebase never enables Vitest's `globals` option, so React Testing Library's own automatic-cleanup detection never fires). Page-level tests mock the `@presentation/lib/data` module's `repos` singleton — the same seam the app itself uses to swap in a real Dexie-backed implementation — rather than standing up a real IndexedDB, so a real application-layer function like `computePositions` still runs for real against the mocked repository boundary.

## Architectural decisions

### ADR-001: Fully client-side, no backend

**Decision:** All data lives in the browser (IndexedDB via Dexie). No API server, no hosted database.

**Why:** The product must ship its own GitHub Pages deployment (static hosting only) and its own database. A hosted backend would mean a second piece of infrastructure to run, pay for, and keep independent from any other project. A purely client-side app satisfies both constraints directly: GitHub Pages serves the static bundle, and IndexedDB *is* the database — no server in between.

**Trade-off accepted:** No multi-device sync, no automatic server-side backup. A user's ledger lives in one browser profile. This is an explicit, accepted limitation, not an oversight — revisit only if real-time multi-device sync becomes a requirement, and treat it as a new ADR (e.g. a sync layer), not a silent architecture change.

A **manual** escape hatch for this trade-off does exist: `BackupService.exportLedger`/`importLedger` (`/data` page) produce and restore a single versioned JSON snapshot of every portfolio, trade, allocation, timeline event, journal entry, and verification — moving a ledger between devices, or recovering from a cleared browser profile, without introducing any server. Import is a full replace, never a merge, by deliberate design (see the file's own doc comment) — conflict resolution for a merge is a materially harder problem this app doesn't need to solve for a single-user, one-profile-at-a-time workflow.

**GitHub Pages + client-side routing pitfall (fixed):** a static host with no server-side rewrite rule only has a real file at `/trade-manager/index.html` — every other path (`/trade-manager/import`, `/trade-manager/portfolios/:id`, etc.) is a route `wouter` resolves client-side, not a file GitHub Pages can serve directly. A hard refresh or a direct/bookmarked deep link therefore hit a genuine GitHub 404 (this is unrelated to IndexedDB — no user data is ever touched by it, but a bare 404 page looks exactly like "the whole app disappeared"). Fixed with the standard [spa-github-pages](https://github.com/rafgraph/spa-github-pages) redirect: `public/404.html` re-encodes the requested path into a query string and redirects to the site root, and a matching inline script in `index.html` decodes it and restores the real path via `history.replaceState` before `wouter` ever reads `window.location` — so a refresh or direct link lands back on the exact page requested instead of a 404.

### ADR-002: Explicit per-trade allocation, never FIFO/average-cost

**Decision:** Every Buy creates one immutable `Trade`. A Sell must specify exactly which `Trade`(s) it closes and how many shares from each (`TradeAllocation`), instead of the system silently picking lots via FIFO or pooling everything into a single average cost.

**Why:** FIFO and average-cost accounting both destroy information — you can no longer tell which specific execution a P/L figure came from, and both silently misattribute P/L when a user's mental model of "which shares I sold" doesn't match the algorithm's. Requiring explicit allocation keeps every trade's full history reconstructable, which is a named product requirement.

**Consequence:** Selling is a slightly heavier UI interaction (the user picks lots) in exchange for the ledger never lying about what happened.

### ADR-003: Independent price snapshot, not a live per-request API call

**Decision:** Current prices come from a static `public/price-snapshot.json`, regenerated on a schedule by this repo's own `scripts/fetch-prices` + `.github/workflows/update-prices.yml`, and read client-side by `SnapshotPriceRepository` (the *only* class in the codebase allowed to read price data — see its file header).

**Why:** A static site with no backend cannot safely hold API keys or proxy a paid data provider, and calling public price APIs directly from a user's browser is unreliable (CORS, rate limits vary per visitor). Publishing one snapshot the whole app reads from keeps a strict single source of truth and matches the "own workflows" / "single source of truth" requirements without introducing a server.

**Trade-off accepted:** Prices are as fresh as the last scheduled run (default: every 30 minutes during EGX trading hours), not real-time tick data.

### ADR-004: Fixed-point `Money`, not raw floats

**Decision:** All cost-basis, P/L, and cash arithmetic goes through `src/domain/value-objects/Money.ts` (integer micros internally), never plain JS numbers added/subtracted directly.

**Why:** Floating point drift compounds across hundreds of trades; a P/L figure that's off by fractions of a piastre per trade adds up to a real, user-visible discrepancy over a portfolio's lifetime.

### ADR-005: Independent from any other codebase

**Decision:** This repository does not import, vendor, or otherwise couple to any other project's code. Where a prior implementation informed the design (screenshot OCR heuristics, the general shape of a portfolio tracker), the logic was re-derived and rebuilt here, not copied.

**Why:** Named product requirement — this is a standalone product with its own repository, release cycle, and architecture.

## Extending the system

- **New analytics metric:** add one pure function under `src/application/analytics/calculators/`, register it in `AnalyticsEngine.ts`. No other file changes needed.
- **New broker OCR support:** implement `BrokerParser` (`src/infrastructure/ocr/parsers/BrokerParser.ts`) and add an instance to `ImportOrchestrator`'s parser list. Do not special-case a second broker inside `ThndrParser.ts`.
- **New timeline event type:** extend `TimelineEventType` in `src/domain/entities/TimelineEvent.ts`; existing timeline rendering already switches on `type` generically.

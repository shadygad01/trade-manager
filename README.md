# Portfolio OS

A professional Trade &amp; Portfolio Management platform for Egyptian retail investors — built as a standalone product, independent from any other codebase.

Every Buy creates a unique, immutable Trade. Trades never lose their identity, never merge automatically, and never destroy execution history. Selling never assumes FIFO or average cost — you choose exactly which trade(s) a sell closes.

## Features

- **Unlimited portfolios** (Investment, Trading, Swing, Experiments, Retirement, Education, or custom), each with its own cash, holdings, return, and equity curve.
- **Immutable trade ledger** with explicit, multi-lot partial-sell allocation.
- **Timeline** of every portfolio event: buys, sells, deposits, withdrawals, dividends, splits, rights issues, cash adjustments, notes.
- **Journal** per trade: entry/exit reasoning, lessons learned, strategy tags, images and attachments.
- **Analytics engine**: win rate, profit factor, average winner/loser, holding time, portfolio/monthly/annual return, exposure, cash ratio, drawdown, equity curve, capital deployment — see [`docs/ANALYTICS_ENGINE.md`](docs/ANALYTICS_ENGINE.md).
- **Thndr screenshot import**: OCR pipeline that reads Buy/Sell confirmations, portfolio/position screenshots, and statements in Arabic or English — see [`docs/OCR_SUBSYSTEM.md`](docs/OCR_SUBSYSTEM.md).
- **Dashboard**: total value, total return, realized/unrealized P/L, cash and portfolio allocation, equity curve, best/worst portfolio, capital deployment, monthly performance.

## Architecture

Clean Architecture with one-way inward dependencies. No backend server, no database server — the app is a static bundle deployed to GitHub Pages, with all data persisted client-side in IndexedDB. Full details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
src/
  domain/          entities, value objects, repository interfaces
  application/      services (TradeService, PortfolioService) + analytics engine
  infrastructure/   Dexie (IndexedDB) persistence, OCR subsystem, price-snapshot client
  presentation/     React UI
scripts/
  fetch-prices/     standalone script, run by its own scheduled GitHub Action,
                     publishing public/price-snapshot.json — the single source
                     of truth for market prices
```

## Getting started

```bash
npm ci
npm run dev       # local dev server
npm test          # vitest — 121 tests across domain/application/infrastructure
npm run build     # typecheck + production build
```

## Deployment

- `.github/workflows/ci.yml` — typecheck, test, build on every PR and push to `main`.
- `.github/workflows/deploy-pages.yml` — builds and publishes to GitHub Pages on push to `main`.
- `.github/workflows/update-prices.yml` — runs `scripts/fetch-prices` on a schedule during EGX trading hours and commits the refreshed `public/price-snapshot.json`.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layering, dependency rules, and key architectural decisions.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — entities, IndexedDB schema, and the trade/allocation model.
- [`docs/ANALYTICS_ENGINE.md`](docs/ANALYTICS_ENGINE.md) — every metric and how to add a new one.
- [`docs/OCR_SUBSYSTEM.md`](docs/OCR_SUBSYSTEM.md) — the Thndr screenshot import pipeline and how to add a new broker.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — gap analysis, sprint log, and the next recommended sprint.

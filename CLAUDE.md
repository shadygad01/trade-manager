# Portfolio OS (trade-manager)

Standalone Trade & Portfolio Management platform for Egyptian retail investors. Independent product, independent repo — do not couple this codebase to any other project's modules.

## Architecture

Clean Architecture, dependency direction always points inward:

```
presentation  -->  application  -->  domain
infrastructure -->  domain
```

- `src/domain` — entities, value objects, repository interfaces. No dependencies on anything else in the project.
- `src/application` — services and the analytics engine. Depends only on `@domain`. Never imports `@infrastructure` or `@presentation`.
- `src/infrastructure` — Dexie (IndexedDB) persistence, the OCR subsystem, and the market-data snapshot client. Implements `@domain` repository interfaces.
- `src/presentation` — React UI. Wires infrastructure repositories into application services.

No backend server. No database server. Everything runs in the browser; the app is a static bundle. Market prices come from a JSON snapshot published by this repo's own scheduled GitHub Action (`scripts/fetch-prices`) — that snapshot is the single source of truth for prices; do not add a second price source.

Deployed to two static targets from the same build: **GitHub Pages** (`deploy-pages.yml`, primary/documented — `https://shadygad01.github.io/trade-manager/`) and **Cloudflare Workers** (`wrangler.jsonc` + the `@cloudflare/vite-plugin` entry in `vite.config.ts`, deployed via Cloudflare's own GitHub build integration — `https://trade-manager.shady-gad-mb.workers.dev/`). The Cloudflare plugin is guarded with `process.env.VITEST` in `vite.config.ts` since it crashes inside Vitest's own dev server otherwise. Both `ci.yml` and `deploy-pages.yml` run on Node 22 (not 20) because `wrangler`/`miniflare` require it.

## Core domain rule

Every Buy creates one immutable `Trade` (a lot). Selling never assumes FIFO or average cost — the caller must name exactly which `Trade`(s) a sell closes and how many shares from each, recorded as `TradeAllocation`s. Do not reintroduce implicit lot-selection logic anywhere.

## Working on this repo

Start each session by reading `docs/ROADMAP.md` (gap analysis + sprint log). Audit the current state against the product vision before adding features; implement the highest-priority gap(s) only, not the whole backlog. Update the sprint log and "Next recommended sprint" section when you finish.

For any task touching more than one subsystem, read `docs/EXECUTION_GRAPH.md` first — it maps every subsystem's dependencies, shared state, and which parts of the codebase are safe to change in parallel versus which must be sequenced.

## Conventions

- No comments except where a business rule or heuristic is genuinely non-obvious.
- Money/cost-basis math goes through `Money` (`src/domain/value-objects/Money.ts`), never raw floats.
- Extend the analytics engine by adding one calculator file under `src/application/analytics/calculators/` plus one registry entry in `AnalyticsEngine.ts` — no architectural changes needed.
- Extend broker OCR support by adding a new `BrokerParser` implementation under `src/infrastructure/ocr/parsers/` — do not special-case a new broker inside `ThndrParser.ts`.

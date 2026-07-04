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

No backend server. No database server. Everything runs in the browser; the app is a static bundle deployed to GitHub Pages. Market prices come from a JSON snapshot published by this repo's own scheduled GitHub Action (`scripts/fetch-prices`) — that snapshot is the single source of truth for prices; do not add a second price source.

## Core domain rule

Every Buy creates one immutable `Trade` (a lot). Selling never assumes FIFO or average cost — the caller must name exactly which `Trade`(s) a sell closes and how many shares from each, recorded as `TradeAllocation`s. Do not reintroduce implicit lot-selection logic anywhere.

## Conventions

- No comments except where a business rule or heuristic is genuinely non-obvious.
- Money/cost-basis math goes through `Money` (`src/domain/value-objects/Money.ts`), never raw floats.
- Extend the analytics engine by adding one calculator file under `src/application/analytics/calculators/` plus one registry entry in `AnalyticsEngine.ts` — no architectural changes needed.
- Extend broker OCR support by adding a new `BrokerParser` implementation under `src/infrastructure/ocr/parsers/` — do not special-case a new broker inside `ThndrParser.ts`.

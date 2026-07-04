import { createRepositories } from "@infrastructure/db/repositories";
import { SnapshotPriceRepository } from "@infrastructure/market-data/SnapshotPriceRepository";
import { ImportOrchestrator } from "@infrastructure/ocr/ImportOrchestrator";
import type { PriceRepository } from "@domain/repositories";

/**
 * Single app-wide repository bundle. `createRepositories()` is the
 * infrastructure layer's Dexie-backed factory, returning
 * {portfolios, trades, tradeAllocations, timeline, journal, verifications, uploads}.
 * `@application/services/types.ts`'s `AppRepositories` (consumed by
 * TradeService/PortfolioService) additionally expects an `allocations` key —
 * aliased here to the same `tradeAllocations` instance so one object
 * satisfies both call sites without the two layers agreeing on a field name.
 * Price data comes from a separate repository since it isn't Dexie-backed.
 */
const baseRepos = createRepositories();
const priceRepository: PriceRepository = new SnapshotPriceRepository();

export const repos = {
  ...baseRepos,
  allocations: baseRepos.tradeAllocations,
  prices: priceRepository,
};

export type Repos = typeof repos;

export const importOrchestrator = new ImportOrchestrator();

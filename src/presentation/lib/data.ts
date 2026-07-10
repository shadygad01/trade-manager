import { createRepositories } from "@infrastructure/db/repositories";
import { SnapshotPriceRepository } from "@infrastructure/market-data/SnapshotPriceRepository";
import type { ImportOrchestrator } from "@infrastructure/ocr/ImportOrchestrator";
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
export { purgeTickerData, purgeAllData } from "@infrastructure/db/purge";

const baseRepos = createRepositories();
const priceRepository: PriceRepository = new SnapshotPriceRepository();

export const repos = {
  ...baseRepos,
  allocations: baseRepos.tradeAllocations,
  prices: priceRepository,
};

export type Repos = typeof repos;

/**
 * Tesseract.js and pdfjs-dist (pulled in transitively by ImportOrchestrator)
 * are by far the largest dependencies in this app and are only ever needed
 * on the Import page — a dynamic import here keeps them out of the main
 * bundle entirely, fetched once on first use and memoized rather than on
 * every page load.
 */
let importOrchestratorPromise: Promise<ImportOrchestrator> | null = null;

export function getImportOrchestrator(): Promise<ImportOrchestrator> {
  if (!importOrchestratorPromise) {
    importOrchestratorPromise = import("@infrastructure/ocr/ImportOrchestrator").then((m) => new m.ImportOrchestrator());
  }
  return importOrchestratorPromise;
}

import { createRepositories } from "@infrastructure/db/repositories";
import { SnapshotPriceRepository } from "@infrastructure/market-data/SnapshotPriceRepository";
import type { ImportOrchestrator } from "@infrastructure/ocr/ImportOrchestrator";
import type { PriceRepository } from "@domain/repositories";
import { backfillRawTransactionsSilently, BackfillAlreadyRanError } from "@application/services/backfillRawTransactions";

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
 * BF-1 (see docs/PORTFOLIO_OS_V2_SPEC.md Part 19's Validation Design):
 * one-time, silent, fire-and-forget conversion of every pre-existing
 * portfolio's Trade/TradeAllocation/PositionVerification/dividend/
 * cash-adjustment history into RawTransaction facts, so the fact log is
 * complete for every existing user, not just one built going forward.
 * Deliberately the SILENT variant — see backfillRawTransactions.ts's own
 * module doc comment for why: it appends facts only, never triggers a
 * commit, never touches Trade/TradeAllocation/ledgerCache/allocationsCache,
 * so this call has ZERO observable effect on anything the app currently
 * renders. `BackfillAlreadyRanError` is the expected, silent outcome on
 * every load after the first (no `source: "backfill"` row existing yet is
 * the only condition that lets it run) — any OTHER failure is logged, never
 * thrown into the module's own top-level evaluation, so a bug here can
 * never block the app from starting.
 */
backfillRawTransactionsSilently(repos).catch((err) => {
  if (err instanceof BackfillAlreadyRanError) return;
  console.error(
    "One-time RawTransaction backfill failed — the app continues normally; cash-projection facts for pre-existing history may stay incomplete until this succeeds on a future load:",
    err
  );
});

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

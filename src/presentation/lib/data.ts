import { createRepositories, createDiagnosticsRepositories } from "@infrastructure/db/repositories";
import { SnapshotPriceRepository } from "@infrastructure/market-data/SnapshotPriceRepository";
import { NoopDiagnosticsRecorder } from "@infrastructure/diagnostics/NoopDiagnosticsRecorder";
import { RecordingDiagnosticsRecorder } from "@infrastructure/diagnostics/RecordingDiagnosticsRecorder";
import type { ImportOrchestrator } from "@infrastructure/ocr/ImportOrchestrator";
import type { PriceRepository, DiagnosticsRecorder } from "@domain/repositories";
import { generateId } from "@domain/value-objects/id";
import { backfillRawTransactionsSilently, BackfillAlreadyRanError } from "@application/services/backfillRawTransactions";
import { pruneDiagnostics } from "@application/services/diagnostics/retentionPolicy";
import { isDeveloperModeEnabled } from "./developerMode";

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
 * Diagnostics Center wiring (docs/DIAGNOSTICS_CENTER_SPEC.md Part 3.3/4).
 * Deliberately NOT part of `repos`/`AppRepositories` above — no
 * business-layer file may hold a diagnostics repository (Part 5.4), and
 * nothing here is ever read to make a business decision. `diagnostics` is
 * the one recorder instance every instrumented call site uses; it's a
 * no-op (zero IndexedDB writes) unless Developer Mode was on at this page
 * load — see `developerMode.ts` for why toggling requires a reload rather
 * than swapping this live.
 */
const diagnosticsRepos = createDiagnosticsRepositories();
export const diagnosticEventRepository = diagnosticsRepos.events;
export const diagnosticCaseRepository = diagnosticsRepos.cases;

export const diagnostics: DiagnosticsRecorder = isDeveloperModeEnabled()
  ? new RecordingDiagnosticsRecorder(diagnosticEventRepository, generateId())
  : new NoopDiagnosticsRecorder();

/** Session Recorder (docs/DIAGNOSTICS_CENTER_SPEC.md Part 5.1) — always the first event of a session when Developer Mode is on. */
diagnostics.recordSessionEvent({ workflowStep: "AppStart", label: "Application started" });

/** Part 4.3/9: retention pruning runs once per boot, only when Developer Mode is on, and can never block app startup. */
if (isDeveloperModeEnabled()) {
  pruneDiagnostics(diagnosticEventRepository, diagnosticCaseRepository).catch((err) => {
    console.warn("Diagnostics retention pruning failed — the app continues normally:", err);
  });
}

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

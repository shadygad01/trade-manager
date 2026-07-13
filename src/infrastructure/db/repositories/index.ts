import { db as sharedDb, type PortfolioOsDatabase } from "../db";
import { DexiePortfolioRepository } from "./DexiePortfolioRepository";
import { DexieTradeRepository } from "./DexieTradeRepository";
import { DexieTradeAllocationRepository } from "./DexieTradeAllocationRepository";
import { DexieTimelineRepository } from "./DexieTimelineRepository";
import { DexieJournalRepository } from "./DexieJournalRepository";
import { DexieVerificationRepository } from "./DexieVerificationRepository";
import { DexieUploadRepository } from "./DexieUploadRepository";
import { DexieRawTransactionRepository } from "./DexieRawTransactionRepository";
import { DexieCommittedLedgerRepository } from "./DexieCommittedLedgerRepository";
import { DexiePendingExecutionRepository } from "./DexiePendingExecutionRepository";
import { DexieDiagnosticEventRepository } from "./DexieDiagnosticEventRepository";
import { DexieDiagnosticCaseRepository } from "./DexieDiagnosticCaseRepository";

export { DexiePortfolioRepository } from "./DexiePortfolioRepository";
export { DexieTradeRepository } from "./DexieTradeRepository";
export { DexieTradeAllocationRepository } from "./DexieTradeAllocationRepository";
export { DexieTimelineRepository } from "./DexieTimelineRepository";
export { DexieJournalRepository } from "./DexieJournalRepository";
export { DexieVerificationRepository } from "./DexieVerificationRepository";
export { DexieUploadRepository } from "./DexieUploadRepository";
export { DexieRawTransactionRepository } from "./DexieRawTransactionRepository";
export { DexieCommittedLedgerRepository } from "./DexieCommittedLedgerRepository";
export { DexiePendingExecutionRepository } from "./DexiePendingExecutionRepository";
export { DexieDiagnosticEventRepository } from "./DexieDiagnosticEventRepository";
export { DexieDiagnosticCaseRepository } from "./DexieDiagnosticCaseRepository";

export interface Repositories {
  portfolios: DexiePortfolioRepository;
  trades: DexieTradeRepository;
  tradeAllocations: DexieTradeAllocationRepository;
  timeline: DexieTimelineRepository;
  journal: DexieJournalRepository;
  verifications: DexieVerificationRepository;
  uploads: DexieUploadRepository;
  rawTransactions: DexieRawTransactionRepository;
  committedLedger: DexieCommittedLedgerRepository;
  pendingExecutions: DexiePendingExecutionRepository;
}

export function createRepositories(database: PortfolioOsDatabase = sharedDb): Repositories {
  return {
    portfolios: new DexiePortfolioRepository(database),
    trades: new DexieTradeRepository(database),
    tradeAllocations: new DexieTradeAllocationRepository(database),
    timeline: new DexieTimelineRepository(database),
    journal: new DexieJournalRepository(database),
    verifications: new DexieVerificationRepository(database),
    uploads: new DexieUploadRepository(database),
    rawTransactions: new DexieRawTransactionRepository(database),
    committedLedger: new DexieCommittedLedgerRepository(database),
    pendingExecutions: new DexiePendingExecutionRepository(database),
  };
}

/**
 * Deliberately separate from `createRepositories()`/`Repositories` above —
 * docs/DIAGNOSTICS_CENTER_SPEC.md Part 5.4 requires no business-layer file
 * ever holds a diagnostics repository, so they're never bundled into the
 * same object business code already depends on.
 */
export interface DiagnosticsRepositories {
  events: DexieDiagnosticEventRepository;
  cases: DexieDiagnosticCaseRepository;
}

export function createDiagnosticsRepositories(database: PortfolioOsDatabase = sharedDb): DiagnosticsRepositories {
  return {
    events: new DexieDiagnosticEventRepository(database),
    cases: new DexieDiagnosticCaseRepository(database),
  };
}

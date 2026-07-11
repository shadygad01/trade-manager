import type {
  PortfolioRepository,
  TradeRepository,
  TradeAllocationRepository,
  TimelineRepository,
  JournalRepository,
  VerificationRepository,
  UploadRepository,
  PendingExecutionRepository,
} from "@domain/repositories";

export interface AppRepositories {
  portfolios: PortfolioRepository;
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  timeline: TimelineRepository;
  journal: JournalRepository;
  verifications: VerificationRepository;
  /** Read by ledgerRebuild.ts as the ONLY source of parsed trade candidates it's allowed to reconstruct the ledger from — never the ledger itself. */
  uploads: UploadRepository;
  pendingExecutions: PendingExecutionRepository;
}

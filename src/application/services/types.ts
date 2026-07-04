import type {
  PortfolioRepository,
  TradeRepository,
  TradeAllocationRepository,
  TimelineRepository,
  JournalRepository,
  VerificationRepository,
} from "@domain/repositories";

export interface AppRepositories {
  portfolios: PortfolioRepository;
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  timeline: TimelineRepository;
  journal: JournalRepository;
  verifications: VerificationRepository;
}

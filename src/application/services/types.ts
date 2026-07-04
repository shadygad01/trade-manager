import type {
  PortfolioRepository,
  TradeRepository,
  TradeAllocationRepository,
  TimelineRepository,
  VerificationRepository,
} from "@domain/repositories";

export interface AppRepositories {
  portfolios: PortfolioRepository;
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  timeline: TimelineRepository;
  verifications: VerificationRepository;
}

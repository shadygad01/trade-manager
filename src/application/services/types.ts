import type { PortfolioRepository, TradeRepository, TradeAllocationRepository, TimelineRepository } from "@domain/repositories";

export interface AppRepositories {
  portfolios: PortfolioRepository;
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  timeline: TimelineRepository;
}

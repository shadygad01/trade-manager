import type { AppRepositories } from "./types";
import type { CommitEngineRepos } from "./commitEngine";
import { computePositions } from "./TradeService";
import { computeHoldings } from "./holdingsEngine";
import { canonicalKey } from "./ledgerRebuild";
import { normalizeTicker } from "@domain/value-objects/Ticker";

/**
 * System Validation: compares the pre-migration architecture's live output
 * (Trade/TradeAllocation tables, TradeService.computePositions) against the
 * new architecture's committed output (ledgerCache/allocationsCache,
 * computeHoldings) for one portfolio, ticker by ticker. Read-only — never
 * writes anything, never fixes anything. This is a pragmatic v1: it checks
 * shares/cost-basis agreement and that every old Trade has a matching new
 * LotOpened event, rather than the full old-vs-new difference-classification
 * taxonomy the canonical-model design sketches (bucketing expected
 * differences like duplicate-collapse or chronological-reorder) — that
 * taxonomy only has cases to classify once real duplicate/aggregate/
 * cross-source data has migrated, which backfilled data (verified
 * unconditionally, one row in old, one row in new, no collapsing) doesn't
 * yet exercise. This gates cutover in the meantime: a ticker with any
 * difference here means investigate before trusting the new system's
 * output for it.
 */

export type ValidationDifferenceCategory = "missing-in-new" | "shares-mismatch" | "cost-basis-mismatch";

export interface ValidationDifference {
  category: ValidationDifferenceCategory;
  detail: string;
}

export interface TickerValidationResult {
  ticker: string;
  differences: ValidationDifference[];
  status: "clear" | "blocked";
}

export interface PortfolioValidationReport {
  portfolioId: string;
  tickers: TickerValidationResult[];
  summary: {
    tickersCompared: number;
    clear: number;
    blocked: number;
  };
}

const SHARES_TOLERANCE = 1e-6;
const COST_BASIS_TOLERANCE = 0.01; // one cent — Money-based arithmetic on both sides should agree exactly; anything past rounding noise is real

export async function validatePortfolio(
  repos: AppRepositories & CommitEngineRepos,
  portfolioId: string,
  priceMap: Record<string, number> = {}
): Promise<PortfolioValidationReport> {
  const [oldTrades, oldPositions] = await Promise.all([repos.trades.getByPortfolio(portfolioId), computePositions(repos, portfolioId, priceMap)]);
  const tickers = new Set(oldTrades.map((t) => normalizeTicker(t.ticker)));

  const results: TickerValidationResult[] = [];
  for (const ticker of tickers) {
    const differences: ValidationDifference[] = [];

    const [newEvents, newAllocations] = await Promise.all([
      repos.committedLedger.getLedgerEvents(portfolioId, ticker),
      repos.committedLedger.getAllocations(portfolioId, ticker),
    ]);
    const newHoldings = computeHoldings(newEvents, newAllocations, priceMap).find((h) => h.ticker === ticker);
    const oldPosition = oldPositions.find((p) => p.ticker === ticker);

    const oldShares = oldPosition?.totalShares ?? 0;
    const newShares = newHoldings?.totalShares ?? 0;
    if (Math.abs(oldShares - newShares) > SHARES_TOLERANCE) {
      differences.push({ category: "shares-mismatch", detail: `Old system computes ${oldShares} open shares; new system computes ${newShares}.` });
    }

    const oldCostBasis = oldPosition?.costBasis ?? 0;
    const newCostBasis = newHoldings?.costBasis ?? 0;
    if (Math.abs(oldCostBasis - newCostBasis) > COST_BASIS_TOLERANCE) {
      differences.push({
        category: "cost-basis-mismatch",
        detail: `Old system computes cost basis ${oldCostBasis.toFixed(2)}; new system computes ${newCostBasis.toFixed(2)}.`,
      });
    }

    const newLotKeys = new Set(newEvents.filter((e) => e.type === "LotOpened").map((e) => e.eventId));
    for (const trade of oldTrades.filter((t) => normalizeTicker(t.ticker) === ticker)) {
      const key = canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
      if (!newLotKeys.has(key)) {
        differences.push({
          category: "missing-in-new",
          detail: `Trade ${trade.id} (${trade.shares}sh @ ${trade.entryPrice} on ${trade.executionDate}) has no matching LotOpened event in the new system — has this ticker been backfilled and assigned to a portfolio yet?`,
        });
      }
    }

    results.push({ ticker, differences, status: differences.length === 0 ? "clear" : "blocked" });
  }

  return {
    portfolioId,
    tickers: results.sort((a, b) => a.ticker.localeCompare(b.ticker)),
    summary: {
      tickersCompared: results.length,
      clear: results.filter((r) => r.status === "clear").length,
      blocked: results.filter((r) => r.status === "blocked").length,
    },
  };
}

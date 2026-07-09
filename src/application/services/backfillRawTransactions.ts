import type { TradeRepository, TradeAllocationRepository, VerificationRepository } from "@domain/repositories";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import {
  createRawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
  type PositionVerificationCapturePayload,
} from "@domain/entities/RawTransaction";
import { canonicalKey } from "./ledgerRebuild";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { appendAndMaybeCommit, type CommitEngineRepos } from "./commitEngine";

/**
 * One-time, additive conversion of everything already committed under the
 * pre-migration architecture (Trade, TradeAllocation, PositionVerification)
 * into RawTransaction rows, source "backfill" — see verificationEngine.ts
 * for why those rows bypass normal verification (already reconciled once,
 * under the old system's own rules, at the time). Never touches the
 * original trades/tradeAllocations/verifications tables — this only reads
 * them. Every write routes through appendAndMaybeCommit, so a ticker's
 * ledgerCache/allocationsCache populate immediately as its backfilled facts
 * land, exactly like any other write to this architecture.
 *
 * Field naming matches presentation/lib/data.ts's `repos` singleton exactly
 * (`allocations`, not `tradeAllocations`) so this can be called directly
 * against the app's real repos with no adapter.
 */

export interface BackfillRepos extends CommitEngineRepos {
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  verifications: VerificationRepository;
}

export interface BackfillResult {
  buysBackfilled: number;
  sellOrdersBackfilled: number;
  verificationsBackfilled: number;
}

export class BackfillAlreadyRanError extends Error {
  constructor() {
    super("Backfill has already run — re-running would duplicate every historical fact. This is a one-time operation.");
    this.name = "BackfillAlreadyRanError";
  }
}

/** Same grouping key TradeService/duplicateDetection.ts's groupSellAllocationsByOrder already uses — sellGroupId, with a legacy composite fallback for any pre-sellGroupId row. */
function groupAllocationsBySellOrder(allocations: TradeAllocation[]): Map<string, TradeAllocation[]> {
  const groups = new Map<string, TradeAllocation[]>();
  for (const a of allocations) {
    const key = a.sellGroupId || `legacy:${a.executionDate}|${Math.round(a.exitPrice * 10_000) / 10_000}`;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  return groups;
}

export async function backfillRawTransactions(repos: BackfillRepos): Promise<BackfillResult> {
  const existing = await repos.rawTransactions.getAll();
  if (existing.some((t) => t.source === "backfill")) {
    throw new BackfillAlreadyRanError();
  }

  const [trades, allocations, verifications] = await Promise.all([
    repos.trades.getAll(),
    repos.allocations.getAll(),
    repos.verifications.getAll(),
  ]);
  const tradeById = new Map(trades.map((t) => [t.id, t]));

  for (const trade of trades) {
    const ticker = normalizeTicker(trade.ticker);
    const payload: BuyExecutionPayload = {
      ticker,
      shares: trade.shares,
      price: trade.entryPrice,
      fees: trade.fees,
      taxes: trade.taxes,
      executionDate: trade.executionDate,
      executionTime: trade.executionTime,
      companyName: trade.companyName,
      transactionNumber: trade.transactionNumber,
    };
    await appendAndMaybeCommit(repos, createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: trade.portfolioId, ticker, payload }));
  }

  const sellGroups = groupAllocationsBySellOrder(allocations);
  for (const group of sellGroups.values()) {
    // A sell order's price/date/time/transactionNumber are shared across
    // every allocation line it was split into — SellAllocationForm only
    // ever captures one exitPrice per sell action, even when the resulting
    // shares are recorded as separate TradeAllocation rows per lot closed.
    const first = group[0];
    const ticker = normalizeTicker(first.ticker);
    const totalShares = group.reduce((sum, a) => sum + a.sharesClosed, 0);
    const totalFees = group.reduce((sum, a) => sum + a.fees, 0);
    const totalTaxes = group.reduce((sum, a) => sum + a.taxes, 0);

    const sellPayload: SellExecutionPayload = {
      ticker,
      shares: totalShares,
      price: first.exitPrice,
      fees: totalFees,
      taxes: totalTaxes,
      executionDate: first.executionDate,
      executionTime: first.executionTime,
      transactionNumber: first.transactionNumber,
    };
    // Computed the same way generateLedgerEvents will later derive this
    // sell order's own eventId — deterministic, so the backfilled
    // SellAllocationDecision below references exactly what the Ledger
    // Engine will produce from this same SellExecution once committed.
    const sellEventId = canonicalKey({ side: "SELL", ticker, date: first.executionDate, shares: totalShares, price: first.exitPrice });
    await appendAndMaybeCommit(repos, createRawTransaction({ kind: "SellExecution", source: "backfill", portfolioId: first.portfolioId, ticker, payload: sellPayload }));

    const decisionAllocations = group.map((a) => {
      const trade = tradeById.get(a.tradeId);
      if (!trade) throw new Error(`backfill: allocation ${a.id} references a trade that no longer exists (${a.tradeId})`);
      const lotRef = canonicalKey({
        side: "BUY",
        ticker: normalizeTicker(trade.ticker),
        date: trade.executionDate,
        shares: trade.shares,
        price: trade.entryPrice,
      });
      return { lotRef, shares: a.sharesClosed };
    });
    const decisionPayload: SellAllocationDecisionPayload = { sellExecutionId: sellEventId, allocations: decisionAllocations };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ kind: "SellAllocationDecision", source: "backfill", portfolioId: first.portfolioId, ticker, payload: decisionPayload })
    );
  }

  for (const verification of verifications) {
    const ticker = normalizeTicker(verification.ticker);
    const payload: PositionVerificationCapturePayload = {
      ticker,
      units: verification.units,
      avgCost: verification.avgCost,
      capturedAt: verification.capturedAt,
      companyName: verification.companyName,
    };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ kind: "PositionVerificationCapture", source: "backfill", portfolioId: verification.portfolioId, ticker, payload })
    );
  }

  return { buysBackfilled: trades.length, sellOrdersBackfilled: sellGroups.size, verificationsBackfilled: verifications.length };
}

import type { TradeRepository, TradeAllocationRepository, VerificationRepository, TimelineRepository, PortfolioRepository } from "@domain/repositories";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import {
  createRawTransaction,
  type RawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
  type PositionVerificationCapturePayload,
  type DividendPaymentPayload,
  type CashAdjustmentPayload,
} from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { type GroupingSignature, toGroupingSignature } from "@domain/value-objects/identity";
import { appendAndMaybeCommit, type CommitEngineRepos } from "./commitEngine";

/**
 * One-time, additive conversion of everything already committed under the
 * pre-migration architecture (Trade, TradeAllocation, PositionVerification)
 * into RawTransaction rows, source "backfill" — see verificationEngine.ts
 * for why those rows bypass normal verification (already reconciled once,
 * under the old system's own rules, at the time). Never touches the
 * original trades/tradeAllocations/verifications tables — this only reads
 * them.
 *
 * Two entry points share the same fact-construction logic below, differing
 * ONLY in how each fact is written (see `runBackfill`'s `write` parameter):
 *
 * - `backfillRawTransactions` (unchanged, still the only one any existing
 *   test/caller uses) routes every write through `appendAndMaybeCommit` —
 *   a ticker's ledgerCache/allocationsCache (and, per commitEngine's own
 *   Phase 9.8 projection step, the legacy Trade/TradeAllocation rows
 *   themselves) populate/rewrite immediately as its backfilled facts reach
 *   a terminal verification verdict ("backfill" source is always
 *   auto-Verified — see verificationEngine.ts), exactly like any other
 *   write to this architecture. This is deliberate and tested
 *   (`backfillRawTransactions.test.ts`'s own "commits into
 *   ledgerCache/allocationsCache automatically" case) — appropriate for an
 *   explicit, human-reviewed action (e.g. a future "Migrate my data" button
 *   mirroring RebuildLedgerPanel/ProvenanceRepairPanel's dry-run-then-confirm
 *   pattern), where a user consciously triggers a operation whose worst case
 *   is `projectLegacyTicker` rewriting their entire ledger's Trade/
 *   TradeAllocation rows in one pass and can review/undo the result.
 *
 * - `backfillRawTransactionsSilently` routes every write through
 *   `repos.rawTransactions.append` directly — inheriting
 *   `RawTransactionRepository`'s own structurally-enforced append-only
 *   contract (reinforced by the dependency-cruiser rule restricting direct
 *   Dexie access) and touching NO other table. This is the only variant
 *   safe to run unattended on every app load: see
 *   docs/PORTFOLIO_OS_V2_SPEC.md Part 19's "BF-1 Validation Design" for the
 *   full safety analysis of why the commit-triggering path was judged NOT
 *   provably safe for an automatic, un-reviewed trigger (it would rewrite
 *   every ticker's legacy Trade/TradeAllocation identity across a user's
 *   ENTIRE portfolio in one pass, the first time this ships, with no way to
 *   validate that rewrite against real historical data shapes from this
 *   environment) and why this narrower variant closes that gap by
 *   construction rather than by review discipline alone.
 *
 * Field naming matches presentation/lib/data.ts's `repos` singleton exactly
 * (`allocations`, not `tradeAllocations`) so either entry point can be
 * called directly against the app's real repos with no adapter.
 */

type FactWriter = (repos: BackfillRepos, transaction: Omit<RawTransaction, "seq">) => Promise<RawTransaction>;

const reactiveWrite: FactWriter = (repos, transaction) => appendAndMaybeCommit(repos, transaction);
const silentWrite: FactWriter = (repos, transaction) => repos.rawTransactions.append(transaction);

export interface BackfillRepos extends CommitEngineRepos {
  portfolios: PortfolioRepository;
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  verifications: VerificationRepository;
  timeline: TimelineRepository;
}

export interface BackfillResult {
  buysBackfilled: number;
  sellOrdersBackfilled: number;
  verificationsBackfilled: number;
  /** Dividend/CashAdjustment TimelineEvents converted to facts — see PortfolioService.recordDividend/recordCashAdjustment, which only started writing these facts going forward; every pre-existing portfolio's history needs this one-time conversion the same way Trade/TradeAllocation did. */
  cashEventsBackfilled: number;
}

export class BackfillAlreadyRanError extends Error {
  constructor() {
    super("Backfill has already run — re-running would duplicate every historical fact. This is a one-time operation.");
    this.name = "BackfillAlreadyRanError";
  }
}

/** Same grouping key TradeService/duplicateDetection.ts's groupSellAllocationsByOrder already uses — sellGroupId, with a legacy composite (date+price+time) fallback for any pre-sellGroupId row. */
function groupAllocationsBySellOrder(allocations: TradeAllocation[]): Map<GroupingSignature, TradeAllocation[]> {
  const groups = new Map<GroupingSignature, TradeAllocation[]>();
  for (const a of allocations) {
    const key = toGroupingSignature(a.sellGroupId || `legacy:${a.executionDate}|${Math.round(a.exitPrice * 10_000) / 10_000}|${a.executionTime}`);
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  return groups;
}

async function runBackfill(repos: BackfillRepos, write: FactWriter): Promise<BackfillResult> {
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
    await write(
      repos,
      createRawTransaction({ id: trade.id, kind: "BuyExecution", source: "backfill", portfolioId: trade.portfolioId, ticker, payload })
    );
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
    // Reuses the legacy sellGroupId as the fact's own id (when the group has
    // one — every post-sellGroupId row does) so the SellAllocationDecision
    // below can reference this SellExecution by its real, always-unique id
    // instead of a recomputed value hash two distinct sells could share
    // (see TradeService.ensureSellFacts/ledgerProjection.resolveLotRef —
    // same real-id contract, applied here for the one-time migration).
    const sellFact = createRawTransaction({
      id: first.sellGroupId || undefined,
      kind: "SellExecution",
      source: "backfill",
      portfolioId: first.portfolioId,
      ticker,
      payload: sellPayload,
    });
    await write(repos, sellFact);

    const decisionAllocations = group.map((a) => {
      const trade = tradeById.get(a.tradeId);
      if (!trade) throw new Error(`backfill: allocation ${a.id} references a trade that no longer exists (${a.tradeId})`);
      return { lotRef: trade.id, shares: a.sharesClosed };
    });
    const decisionPayload: SellAllocationDecisionPayload = { sellExecutionId: sellFact.id, allocations: decisionAllocations };
    await write(
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
    await write(
      repos,
      createRawTransaction({ kind: "PositionVerificationCapture", source: "backfill", portfolioId: verification.portfolioId, ticker, payload })
    );
  }

  // Dividend/CashAdjustment: recordDividend/recordCashAdjustment only start
  // writing these facts going forward (see PortfolioService.ts) — every
  // dividend/adjustment already on a pre-existing portfolio's timeline needs
  // this one-time conversion, the same reason Trade/TradeAllocation needed
  // one. Reuses the TimelineEvent's own id as the fact's id, matching the
  // id-correlation those functions now use going forward, so a portfolio
  // backfilled here and then edited afterward never double-facts the same
  // event under two different ids. Enumerated from every portfolio, not
  // just ones with a Trade/Allocation/Verification — a portfolio that has
  // only ever received a dividend or manual cash top-up must not be missed.
  const allPortfolios = await repos.portfolios.getAll();
  let cashEventsBackfilled = 0;
  for (const portfolio of allPortfolios) {
    const portfolioId = portfolio.id;
    const events = await repos.timeline.getByPortfolio(portfolioId);
    for (const event of events) {
      if (event.type === "Dividend") {
        const payload: DividendPaymentPayload = { ticker: event.ticker, amount: event.amount ?? 0, date: event.timestamp.slice(0, 10) };
        await write(repos, createRawTransaction({ id: event.id, kind: "DividendPayment", source: "backfill", portfolioId, payload }));
        cashEventsBackfilled += 1;
      } else if (event.type === "CashAdjustment") {
        const payload: CashAdjustmentPayload = { amount: event.amount ?? 0, notes: event.notes ?? "", date: event.timestamp.slice(0, 10) };
        await write(repos, createRawTransaction({ id: event.id, kind: "CashAdjustment", source: "backfill", portfolioId, payload }));
        cashEventsBackfilled += 1;
      }
    }
  }

  return { buysBackfilled: trades.length, sellOrdersBackfilled: sellGroups.size, verificationsBackfilled: verifications.length, cashEventsBackfilled };
}

/** Commit-triggering variant — see this file's module doc comment. Existing, tested, unchanged behavior. */
export async function backfillRawTransactions(repos: BackfillRepos): Promise<BackfillResult> {
  return runBackfill(repos, reactiveWrite);
}

/**
 * Append-only variant, safe for unattended use (e.g. an automatic app-load
 * hook) — see this file's module doc comment and
 * docs/PORTFOLIO_OS_V2_SPEC.md Part 19's BF-1 Validation Design for why the
 * commit-triggering variant above is NOT used here. Produces byte-identical
 * RawTransaction facts to `backfillRawTransactions`; the only difference is
 * that `repos.rawTransactions.append` is called directly instead of
 * `appendAndMaybeCommit`, so `ledgerCache`, `allocationsCache`, `trades`,
 * and `allocations` are never read from or written to by this function —
 * verified by `backfillRawTransactions.test.ts`'s own isolation tests.
 */
export async function backfillRawTransactionsSilently(repos: BackfillRepos): Promise<BackfillResult> {
  return runBackfill(repos, silentWrite);
}

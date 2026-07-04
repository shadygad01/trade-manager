import { createTrade, isOpen, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, realizedPnlMicros, type TradeAllocation } from "@domain/entities/TradeAllocation";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { KNOWN_EGX_TICKERS } from "@domain/value-objects/knownTickers";
import { TRACKING_START_DATE, isBeforeTrackingStart } from "@domain/value-objects/trackingWindow";
import type { AppRepositories } from "./types";

function companyNameForTicker(ticker: string): string | undefined {
  return KNOWN_EGX_TICKERS.find((t) => t.ticker === ticker)?.companyName;
}

function assertWithinTrackingRange(executionDate: string): void {
  if (isBeforeTrackingStart(executionDate)) {
    throw new Error(`Transactions before ${TRACKING_START_DATE} are not tracked: got ${executionDate}`);
  }
}

function toTimestamp(executionDate: string, executionTime: string): string {
  return `${executionDate}T${executionTime}`;
}

function microsToMoney(totalMicros: number): Money {
  return Money.from(totalMicros / 1_000_000);
}

export interface RecordBuyInput {
  portfolioId: string;
  ticker: string;
  companyName?: string;
  /** Explicit sector override. When omitted, falls back to the known-ticker sector lookup — never fabricated for an unmapped ticker. */
  sector?: string;
  shares: number;
  entryPrice: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime: string;
  notes?: string;
  strategyTags?: string[];
}

export interface RecordBuyResult {
  trade: Trade;
}

export async function recordBuy(repos: AppRepositories, input: RecordBuyInput): Promise<RecordBuyResult> {
  assertWithinTrackingRange(input.executionDate);
  const portfolio = await repos.portfolios.getById(input.portfolioId);
  if (!portfolio) {
    throw new Error(`Portfolio not found: ${input.portfolioId}`);
  }

  const fees = input.fees ?? 0;
  const taxes = input.taxes ?? 0;
  const totalCost = Money.from(input.shares * input.entryPrice).add(Money.from(fees)).add(Money.from(taxes));
  const currentCash = Money.from(portfolio.cash);

  const normalizedTicker = normalizeTicker(input.ticker);
  const trade = createTrade({
    id: generateId(),
    portfolioId: input.portfolioId,
    ticker: normalizedTicker,
    companyName: input.companyName,
    sector: input.sector ?? sectorForTicker(normalizedTicker),
    shares: input.shares,
    entryPrice: input.entryPrice,
    fees,
    taxes,
    executionDate: input.executionDate,
    executionTime: input.executionTime,
    notes: input.notes,
    strategyTags: input.strategyTags,
  });
  await repos.trades.save(trade);

  const updatedPortfolio = { ...portfolio, cash: currentCash.subtract(totalCost).toNumber() };
  await repos.portfolios.save(updatedPortfolio);

  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId: input.portfolioId,
      type: "Buy",
      timestamp: toTimestamp(input.executionDate, input.executionTime),
      ticker: trade.ticker,
      relatedTradeIds: [trade.id],
      amount: -totalCost.toNumber(),
      shares: input.shares,
      notes: input.notes,
    })
  );

  return { trade };
}

/**
 * Undoes a mistaken buy — the real fix for ground-truth reconciliation's
 * (see reconciliation.ts) `quantityMismatch`, which usually means a
 * duplicate import. An earlier "Accept as current" action only re-labeled
 * the wrong computed total as verified rather than fixing anything, and was
 * removed for exactly that reason — this instead deletes the actual
 * offending trade so the ledger becomes correct on its own, symmetrically
 * undoing exactly what `recordBuy` did: refunding the cash it debited and
 * removing the `Buy` timeline event and any journal entry that narrated it,
 * so nothing is left behind, the same as if the trade had never been
 * recorded.
 *
 * Guarded to only ever delete a trade with zero shares closed against it
 * (`remainingShares === shares`): once even one allocation exists, deleting
 * the trade out from under it would orphan that `TradeAllocation` and
 * silently corrupt realized P/L — this is refused outright rather than
 * attempted, matching this app's ledger-never-lies philosophy (ADR-002).
 */
export async function deleteTrade(repos: AppRepositories, tradeId: string): Promise<void> {
  const trade = await repos.trades.getById(tradeId);
  if (!trade) {
    throw new Error(`Trade not found: ${tradeId}`);
  }
  if (trade.remainingShares !== trade.shares) {
    throw new Error(
      "This trade has shares closed against it (a sell allocation exists) — it can't be deleted without corrupting that history."
    );
  }

  const portfolio = await repos.portfolios.getById(trade.portfolioId);
  if (!portfolio) {
    throw new Error(`Portfolio not found: ${trade.portfolioId}`);
  }

  const totalCost = Money.from(trade.shares * trade.entryPrice).add(Money.from(trade.fees)).add(Money.from(trade.taxes));
  await repos.portfolios.save({ ...portfolio, cash: Money.from(portfolio.cash).add(totalCost).toNumber() });

  const events = await repos.timeline.getByPortfolio(trade.portfolioId);
  const buyEvent = events.find((e) => e.type === "Buy" && e.relatedTradeIds?.includes(tradeId));
  if (buyEvent) {
    await repos.timeline.delete(buyEvent.id);
  }

  const journalEntry = await repos.journal.getByTrade(tradeId);
  if (journalEntry) {
    await repos.journal.delete(journalEntry.id);
  }

  await repos.trades.delete(tradeId);
}

export interface RenameTickerResult {
  tradesUpdated: number;
  allocationsUpdated: number;
  timelineEventsUpdated: number;
  verificationsUpdated: number;
}

/**
 * Corrects a wrong ticker across every already-recorded row, not just the
 * Import page's pending pool: OCR ticker resolution can still be wrong (see
 * ThndrParser's confidence tiers), and now that Import auto-commits most
 * rows instead of waiting for a manual click, the pending-pool-only rename
 * is no longer the only place a correction is needed — a wrong ticker can
 * just as easily already be sitting in the real ledger by the time it's
 * noticed. Touches every table that carries a ticker field: `Trade`
 * (ticker, companyName, and sector — re-derived from the corrected ticker,
 * or cleared rather than left stale if the new ticker doesn't resolve),
 * `TradeAllocation`, `TimelineEvent`, and `PositionVerification`. Never
 * touches anything else about these rows (shares/price/dates/notes are
 * untouched) — this is purely a ticker-identity fix.
 */
export async function renameTickerEverywhere(
  repos: AppRepositories,
  oldTickerRaw: string,
  newTickerRaw: string
): Promise<RenameTickerResult> {
  const oldTicker = normalizeTicker(oldTickerRaw);
  const newTicker = normalizeTicker(newTickerRaw);
  const empty: RenameTickerResult = { tradesUpdated: 0, allocationsUpdated: 0, timelineEventsUpdated: 0, verificationsUpdated: 0 };
  if (!newTicker || newTicker === oldTicker) {
    return empty;
  }

  const [trades, allocations, timelineEvents, verifications] = await Promise.all([
    repos.trades.getAll(),
    repos.allocations.getAll(),
    repos.timeline.getAll(),
    repos.verifications.getAll(),
  ]);

  const matchingTrades = trades.filter((t) => normalizeTicker(t.ticker) === oldTicker);
  for (const t of matchingTrades) {
    await repos.trades.save({
      ...t,
      ticker: newTicker,
      companyName: companyNameForTicker(newTicker) ?? t.companyName,
      sector: sectorForTicker(newTicker),
    });
  }

  const matchingAllocations = allocations.filter((a) => normalizeTicker(a.ticker) === oldTicker);
  for (const a of matchingAllocations) {
    await repos.allocations.save({ ...a, ticker: newTicker });
  }

  const matchingEvents = timelineEvents.filter((e) => e.ticker !== undefined && normalizeTicker(e.ticker) === oldTicker);
  for (const e of matchingEvents) {
    await repos.timeline.save({ ...e, ticker: newTicker });
  }

  const matchingVerifications = verifications.filter((v) => normalizeTicker(v.ticker) === oldTicker);
  for (const v of matchingVerifications) {
    await repos.verifications.save({
      ...v,
      ticker: newTicker,
      companyName: companyNameForTicker(newTicker) ?? v.companyName,
    });
  }

  return {
    tradesUpdated: matchingTrades.length,
    allocationsUpdated: matchingAllocations.length,
    timelineEventsUpdated: matchingEvents.length,
    verificationsUpdated: matchingVerifications.length,
  };
}

export interface RecordSellAllocationInput {
  tradeId: string;
  shares: number;
  exitPrice: number;
  fees?: number;
  taxes?: number;
  notes?: string;
  exitReason?: string;
}

export interface RecordSellInput {
  portfolioId: string;
  ticker: string;
  sellGroupId?: string;
  allocations: RecordSellAllocationInput[];
  executionDate: string;
  executionTime: string;
}

export interface RecordSellResult {
  realizedPnl: Money;
  allocations: TradeAllocation[];
}

export async function recordSell(repos: AppRepositories, input: RecordSellInput): Promise<RecordSellResult> {
  if (input.allocations.length === 0) {
    throw new Error("recordSell requires at least one allocation");
  }
  assertWithinTrackingRange(input.executionDate);

  const portfolio = await repos.portfolios.getById(input.portfolioId);
  if (!portfolio) {
    throw new Error(`Portfolio not found: ${input.portfolioId}`);
  }

  const ticker = normalizeTicker(input.ticker);
  const sellGroupId = input.sellGroupId ?? generateId();

  const createdAllocations: TradeAllocation[] = [];
  const relatedTradeIds: string[] = [];
  let netProceeds = Money.zero();
  let realizedMicros = 0;
  let fullyClosedCount = 0;

  for (const line of input.allocations) {
    const trade = await repos.trades.getById(line.tradeId);
    if (!trade) {
      throw new Error(`Trade not found: ${line.tradeId}`);
    }
    if (trade.portfolioId !== input.portfolioId) {
      throw new Error(`Trade ${trade.id} does not belong to portfolio ${input.portfolioId}`);
    }
    if (normalizeTicker(trade.ticker) !== ticker) {
      throw new Error(`Trade ${trade.id} ticker mismatch: expected ${ticker}, got ${trade.ticker}`);
    }
    if (line.shares > trade.remainingShares) {
      throw new Error(
        `Cannot close ${line.shares} shares of trade ${trade.id}: only ${trade.remainingShares} remain`
      );
    }

    const allocation = createTradeAllocation({
      id: generateId(),
      sellGroupId,
      portfolioId: input.portfolioId,
      tradeId: trade.id,
      ticker,
      sharesClosed: line.shares,
      exitPrice: line.exitPrice,
      fees: line.fees,
      taxes: line.taxes,
      executionDate: input.executionDate,
      executionTime: input.executionTime,
      notes: line.notes,
      exitReason: line.exitReason,
    });
    await repos.allocations.save(allocation);
    createdAllocations.push(allocation);
    relatedTradeIds.push(trade.id);

    const remainingShares = trade.remainingShares - line.shares;
    await repos.trades.saveRemainingShares(trade.id, remainingShares);
    if (remainingShares === 0) {
      fullyClosedCount += 1;
    }

    const lineProceeds = Money.from(line.shares * line.exitPrice)
      .subtract(Money.from(line.fees ?? 0))
      .subtract(Money.from(line.taxes ?? 0));
    netProceeds = netProceeds.add(lineProceeds);
    realizedMicros += realizedPnlMicros(allocation, trade);
  }

  const updatedPortfolio = { ...portfolio, cash: Money.from(portfolio.cash).add(netProceeds).toNumber() };
  await repos.portfolios.save(updatedPortfolio);

  const isSingleFullClose = input.allocations.length === 1 && fullyClosedCount === 1;
  const totalSharesClosed = createdAllocations.reduce((sum, a) => sum + a.sharesClosed, 0);

  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId: input.portfolioId,
      type: isSingleFullClose ? "Sell" : "PartialSell",
      timestamp: toTimestamp(input.executionDate, input.executionTime),
      ticker,
      relatedTradeIds,
      relatedAllocationIds: createdAllocations.map((a) => a.id),
      amount: netProceeds.toNumber(),
      shares: totalSharesClosed,
    })
  );

  return { realizedPnl: microsToMoney(realizedMicros), allocations: createdAllocations };
}

export interface MoveTradeResult {
  /** Every trade actually moved — includes the requested trade plus any other lot pulled in because it shares a sellGroupId (a multi-lot sell can't be split across two portfolios). */
  movedTradeIds: string[];
}

/**
 * Reassigns a trade (and everything economically tied to it) to a different
 * portfolio — for fixing a trade assigned to the wrong portfolio at import
 * time, or a change of mind about how holdings should be split. The buy's
 * original cost is refunded to the source portfolio and charged to the
 * target; any of its sells' net proceeds move the same way, so both
 * portfolios' cash stays correct rather than the trade silently taking its
 * cash history with it.
 *
 * If the trade was sold together with other lots in one multi-trade sell
 * (shared `sellGroupId`), all of those lots move too — a single sell action
 * can't end up split across two portfolios.
 */
export async function moveTrade(
  repos: AppRepositories,
  tradeId: string,
  targetPortfolioId: string
): Promise<MoveTradeResult> {
  const trade = await repos.trades.getById(tradeId);
  if (!trade) {
    throw new Error(`Trade not found: ${tradeId}`);
  }
  const sourcePortfolioId = trade.portfolioId;
  if (sourcePortfolioId === targetPortfolioId) {
    return { movedTradeIds: [trade.id] };
  }

  const sourcePortfolio = await repos.portfolios.getById(sourcePortfolioId);
  if (!sourcePortfolio) {
    throw new Error(`Portfolio not found: ${sourcePortfolioId}`);
  }
  const targetPortfolio = await repos.portfolios.getById(targetPortfolioId);
  if (!targetPortfolio) {
    throw new Error(`Portfolio not found: ${targetPortfolioId}`);
  }

  const [portfolioTrades, portfolioAllocations, portfolioEvents] = await Promise.all([
    repos.trades.getByPortfolio(sourcePortfolioId),
    repos.allocations.getByPortfolio(sourcePortfolioId),
    repos.timeline.getByPortfolio(sourcePortfolioId),
  ]);
  const tradeById = new Map(portfolioTrades.map((t) => [t.id, t]));

  const allocationsByTrade = new Map<string, TradeAllocation[]>();
  for (const allocation of portfolioAllocations) {
    const list = allocationsByTrade.get(allocation.tradeId) ?? [];
    list.push(allocation);
    allocationsByTrade.set(allocation.tradeId, list);
  }

  const moveSet = new Set<string>([tradeId]);
  const queue = [tradeId];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const allocation of allocationsByTrade.get(current) ?? []) {
      for (const sibling of portfolioAllocations) {
        if (sibling.sellGroupId === allocation.sellGroupId && !moveSet.has(sibling.tradeId)) {
          moveSet.add(sibling.tradeId);
          queue.push(sibling.tradeId);
        }
      }
    }
  }

  const tradesToMove = [...moveSet].map((id) => {
    const t = tradeById.get(id);
    if (!t) throw new Error(`Trade not found in source portfolio ${sourcePortfolioId}: ${id}`);
    return t;
  });
  const allocationsToMove = portfolioAllocations.filter((a) => moveSet.has(a.tradeId));

  const buyCost = Money.sum(tradesToMove.map((t) => Money.from(t.entryPrice * t.shares + t.fees + t.taxes)));
  const netProceeds = Money.sum(
    allocationsToMove.map((a) =>
      Money.from(a.sharesClosed * a.exitPrice).subtract(Money.from(a.fees)).subtract(Money.from(a.taxes))
    )
  );
  const netCost = buyCost.subtract(netProceeds);

  await repos.portfolios.save({ ...sourcePortfolio, cash: Money.from(sourcePortfolio.cash).add(netCost).toNumber() });
  await repos.portfolios.save({ ...targetPortfolio, cash: Money.from(targetPortfolio.cash).subtract(netCost).toNumber() });

  for (const t of tradesToMove) {
    await repos.trades.save({ ...t, portfolioId: targetPortfolioId });
  }
  for (const a of allocationsToMove) {
    await repos.allocations.save({ ...a, portfolioId: targetPortfolioId });
  }

  // Only Buy/Sell/PartialSell events narrate specific trades (relatedTradeIds);
  // deposits, dividends, etc. are portfolio-level and never move with a trade.
  const eventsToMove = portfolioEvents.filter((e) => {
    const ids = e.relatedTradeIds;
    return ids !== undefined && ids.length > 0 && ids.every((id) => moveSet.has(id));
  });
  for (const e of eventsToMove) {
    await repos.timeline.save({ ...e, portfolioId: targetPortfolioId });
  }

  return { movedTradeIds: [...moveSet] };
}

export interface SplitTickerEntry {
  ticker: string;
  portfolios: { portfolioId: string; shares: number }[];
}

/**
 * A ticker held (nonzero remaining shares) in more than one portfolio is
 * usually a mistake, not intent — a broker account is one real position
 * regardless of which app-side portfolio bucket a given buy landed in, and a
 * position split this way makes any single portfolio's own broker-screenshot
 * reconciliation compare an incomplete subset against the real total. This
 * surfaces every such ticker so it can be pointed at `consolidateTicker`.
 */
export function findTickersSplitAcrossPortfolios(trades: Trade[]): SplitTickerEntry[] {
  const byTicker = new Map<string, Map<string, number>>();
  for (const t of trades) {
    if (t.remainingShares <= 0) continue;
    const ticker = normalizeTicker(t.ticker);
    const byPortfolio = byTicker.get(ticker) ?? new Map<string, number>();
    byPortfolio.set(t.portfolioId, (byPortfolio.get(t.portfolioId) ?? 0) + t.remainingShares);
    byTicker.set(ticker, byPortfolio);
  }

  const result: SplitTickerEntry[] = [];
  for (const [ticker, byPortfolio] of byTicker) {
    if (byPortfolio.size > 1) {
      result.push({
        ticker,
        portfolios: [...byPortfolio.entries()].map(([portfolioId, shares]) => ({ portfolioId, shares })),
      });
    }
  }
  return result.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export interface ConsolidateTickerResult {
  movedTradeIds: string[];
  movedVerificationIds: string[];
}

/**
 * Reunites a ticker scattered across portfolios into one, for exactly the
 * mistake findTickersSplitAcrossPortfolios detects. Moves every trade for
 * the ticker (via moveTrade, so cash/sell-groups/timeline stay correct) plus
 * any broker-position verification recorded for it under a different
 * portfolio — a screenshot showing the real total belongs with wherever
 * that total's trades now live, not wherever it happened to be imported.
 */
export async function consolidateTicker(
  repos: AppRepositories,
  ticker: string,
  targetPortfolioId: string
): Promise<ConsolidateTickerResult> {
  const normalizedTicker = normalizeTicker(ticker);

  const allTrades = await repos.trades.getAll();
  const tradeIdsToMove = allTrades
    .filter((t) => normalizeTicker(t.ticker) === normalizedTicker && t.portfolioId !== targetPortfolioId)
    .map((t) => t.id);

  const moved = new Set<string>();
  for (const tradeId of tradeIdsToMove) {
    if (moved.has(tradeId)) continue;
    const current = await repos.trades.getById(tradeId);
    if (!current || current.portfolioId === targetPortfolioId) continue;
    const result = await moveTrade(repos, tradeId, targetPortfolioId);
    for (const id of result.movedTradeIds) moved.add(id);
  }

  const allVerifications = await repos.verifications.getAll();
  const verificationsToMove = allVerifications.filter(
    (v) => normalizeTicker(v.ticker) === normalizedTicker && v.portfolioId !== targetPortfolioId
  );
  const movedVerificationIds: string[] = [];
  for (const v of verificationsToMove) {
    await repos.verifications.save({ ...v, portfolioId: targetPortfolioId });
    movedVerificationIds.push(v.id);
  }

  return { movedTradeIds: [...moved], movedVerificationIds };
}

export interface PositionAggregate {
  ticker: string;
  totalShares: number;
  costBasis: number;
  avgCost: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  openTrades: Trade[];
}

export async function computePositions(
  repos: AppRepositories,
  portfolioId: string,
  priceMap: Record<string, number>
): Promise<PositionAggregate[]> {
  const trades = await repos.trades.getByPortfolio(portfolioId);
  const openTrades = trades.filter(isOpen);

  const byTicker = new Map<string, Trade[]>();
  for (const trade of openTrades) {
    const ticker = normalizeTicker(trade.ticker);
    const bucket = byTicker.get(ticker);
    if (bucket) {
      bucket.push(trade);
    } else {
      byTicker.set(ticker, [trade]);
    }
  }

  const positions: PositionAggregate[] = [];
  for (const [ticker, tickerTrades] of byTicker) {
    const totalShares = tickerTrades.reduce((sum, t) => sum + t.remainingShares, 0);
    const costBasis = Money.sum(
      tickerTrades.map((t) =>
        Money.from(t.entryPrice * t.shares + t.fees + t.taxes).multiply(t.remainingShares / t.shares)
      )
    );
    const avgCost = totalShares > 0 ? costBasis.divide(totalShares).toNumber() : 0;
    const currentPrice = priceMap[ticker];
    const marketValue = currentPrice !== undefined ? totalShares * currentPrice : undefined;
    const unrealizedPnl = marketValue !== undefined ? marketValue - costBasis.toNumber() : undefined;
    const unrealizedPnlPct =
      unrealizedPnl !== undefined && costBasis.isPositive() ? (unrealizedPnl / costBasis.toNumber()) * 100 : undefined;

    positions.push({
      ticker,
      totalShares,
      costBasis: costBasis.toNumber(),
      avgCost,
      currentPrice,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPct,
      openTrades: tickerTrades,
    });
  }

  return positions;
}

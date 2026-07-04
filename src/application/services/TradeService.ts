import { createTrade, isOpen, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, realizedPnlMicros, type TradeAllocation } from "@domain/entities/TradeAllocation";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { InsufficientCashError } from "./errors";
import type { AppRepositories } from "./types";

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
  const portfolio = await repos.portfolios.getById(input.portfolioId);
  if (!portfolio) {
    throw new Error(`Portfolio not found: ${input.portfolioId}`);
  }

  const fees = input.fees ?? 0;
  const taxes = input.taxes ?? 0;
  const totalCost = Money.from(input.shares * input.entryPrice).add(Money.from(fees)).add(Money.from(taxes));
  const currentCash = Money.from(portfolio.cash);
  if (totalCost.greaterThan(currentCash)) {
    throw new InsufficientCashError(
      input.portfolioId,
      totalCost.toNumber(),
      currentCash.toNumber(),
      `Insufficient cash in portfolio ${input.portfolioId}: need ${totalCost.toFixed()}, have ${currentCash.toFixed()}`
    );
  }

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

  if (netCost.isPositive() && netCost.greaterThan(Money.from(targetPortfolio.cash))) {
    throw new InsufficientCashError(
      targetPortfolioId,
      netCost.toNumber(),
      Money.from(targetPortfolio.cash).toNumber(),
      `Insufficient cash in target portfolio ${targetPortfolioId}: need ${netCost.toFixed()}, have ${Money.from(targetPortfolio.cash).toFixed()}`
    );
  }

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

import { createTrade, isOpen, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, realizedPnlMicros, type TradeAllocation } from "@domain/entities/TradeAllocation";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
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
  shares: number;
  entryPrice: number;
  fees?: number;
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
  const totalCost = Money.from(input.shares * input.entryPrice).add(Money.from(fees));
  const currentCash = Money.from(portfolio.cash);
  if (totalCost.greaterThan(currentCash)) {
    throw new Error(
      `Insufficient cash in portfolio ${input.portfolioId}: need ${totalCost.toFixed()}, have ${currentCash.toFixed()}`
    );
  }

  const trade = createTrade({
    id: generateId(),
    portfolioId: input.portfolioId,
    ticker: normalizeTicker(input.ticker),
    shares: input.shares,
    entryPrice: input.entryPrice,
    fees,
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

    const lineProceeds = Money.from(line.shares * line.exitPrice).subtract(Money.from(line.fees ?? 0));
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
        Money.from(t.entryPrice * t.shares + t.fees).multiply(t.remainingShares / t.shares)
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

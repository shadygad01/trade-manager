import { isOpen, type Trade } from "@domain/entities/Trade";
import { Money } from "@domain/value-objects/Money";
import { normalizeTicker } from "@domain/value-objects/Ticker";

export interface OpenPositionStats {
  positionCount: number;
  winRate: number;
  profitFactor: number;
  avgWinner: number;
  avgLoser: number;
  largestWinner: number;
  largestLoser: number;
  avgHoldingDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Mark-to-market performance of every still-open Trade lot against today's
 * priceMap snapshot — the unrealized counterpart to
 * winRate/profitFactor/avgWinner/avgLoser/holdingTime, which only look at
 * realized TradeAllocations and read as 0 on a portfolio with nothing closed
 * yet. A ticker missing from priceMap is skipped entirely (never priced at
 * zero), matching summarizeOpenPositions' documented behavior.
 */
export function openPositionStats(
  trades: Trade[],
  priceMap: Record<string, number>,
  today: string = new Date().toISOString().slice(0, 10)
): OpenPositionStats {
  const pnls: number[] = [];
  let weightedDaysTotal = 0;
  let sharesTotal = 0;

  for (const trade of trades.filter(isOpen)) {
    const price = priceMap[normalizeTicker(trade.ticker)];
    if (price === undefined) continue;

    const costBasis = Money.from(trade.entryPrice * trade.shares + trade.fees + trade.taxes).multiply(
      trade.remainingShares / trade.shares
    );
    const marketValue = Money.from(trade.remainingShares * price);
    pnls.push(marketValue.subtract(costBasis).toNumber());

    const days = (Date.parse(today) - Date.parse(trade.executionDate)) / MS_PER_DAY;
    weightedDaysTotal += days * trade.remainingShares;
    sharesTotal += trade.remainingShares;
  }

  const winners = pnls.filter((p) => p > 0);
  const losers = pnls.filter((p) => p < 0);
  const grossProfit = winners.reduce((sum, p) => sum + p, 0);
  const grossLoss = Math.abs(losers.reduce((sum, p) => sum + p, 0));

  return {
    positionCount: pnls.length,
    winRate: pnls.length > 0 ? (winners.length / pnls.length) * 100 : 0,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    avgWinner: winners.length > 0 ? grossProfit / winners.length : 0,
    avgLoser: losers.length > 0 ? -grossLoss / losers.length : 0,
    largestWinner: pnls.length > 0 ? Math.max(...pnls) : 0,
    largestLoser: pnls.length > 0 ? Math.min(...pnls) : 0,
    avgHoldingDays: sharesTotal > 0 ? weightedDaysTotal / sharesTotal : 0,
  };
}

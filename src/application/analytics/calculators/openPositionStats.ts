import { isOpen, type Trade } from "@domain/entities/Trade";
import { Money } from "@domain/value-objects/Money";
import { normalizeTicker } from "@domain/value-objects/Ticker";

export interface OpenPositionStats {
  positionCount: number;
  winRate: number;
  /** Gross unrealized profit / gross unrealized loss, in money — dollar-weighted, unlike the % fields below. */
  profitFactor: number;
  /** Average/largest unrealized return, as % of that lot's own cost basis (not a money amount). */
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
  const moneyPnls: number[] = [];
  const pctPnls: number[] = [];
  let weightedDaysTotal = 0;
  let sharesTotal = 0;

  for (const trade of trades.filter(isOpen)) {
    const price = priceMap[normalizeTicker(trade.ticker)];
    if (price === undefined) continue;

    const costBasis = Money.from(trade.entryPrice * trade.shares + trade.fees + trade.taxes).multiply(
      trade.remainingShares / trade.shares
    );
    const marketValue = Money.from(trade.remainingShares * price);
    const costBasisNumber = costBasis.toNumber();
    moneyPnls.push(marketValue.subtract(costBasis).toNumber());
    pctPnls.push(((marketValue.toNumber() - costBasisNumber) / costBasisNumber) * 100);

    const days = (Date.parse(today) - Date.parse(trade.executionDate)) / MS_PER_DAY;
    weightedDaysTotal += days * trade.remainingShares;
    sharesTotal += trade.remainingShares;
  }

  const winnerMoney = moneyPnls.filter((p) => p > 0);
  const loserMoney = moneyPnls.filter((p) => p < 0);
  const grossProfit = winnerMoney.reduce((sum, p) => sum + p, 0);
  const grossLoss = Math.abs(loserMoney.reduce((sum, p) => sum + p, 0));
  const winnerPcts = pctPnls.filter((_, i) => moneyPnls[i] > 0);
  const loserPcts = pctPnls.filter((_, i) => moneyPnls[i] < 0);

  return {
    positionCount: moneyPnls.length,
    winRate: moneyPnls.length > 0 ? (winnerMoney.length / moneyPnls.length) * 100 : 0,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    avgWinner: winnerPcts.length > 0 ? winnerPcts.reduce((sum, p) => sum + p, 0) / winnerPcts.length : 0,
    avgLoser: loserPcts.length > 0 ? loserPcts.reduce((sum, p) => sum + p, 0) / loserPcts.length : 0,
    largestWinner: pctPnls.length > 0 ? Math.max(...pctPnls) : 0,
    largestLoser: pctPnls.length > 0 ? Math.min(...pctPnls) : 0,
    avgHoldingDays: sharesTotal > 0 ? weightedDaysTotal / sharesTotal : 0,
  };
}

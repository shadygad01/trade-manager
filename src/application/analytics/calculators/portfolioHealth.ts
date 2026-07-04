import { isOpen, type Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { cashRatio } from "./cashRatio";
import { realizedPnlMicrosForAllocations } from "./shared";

export interface PortfolioHealth {
  cashRatio: number;
  openTradeCount: number;
  largestPositionTicker?: string;
  largestPositionPct: number;
  /** Herfindahl-Hirschman Index of position weights (0-1): sum of each position's squared share of invested value. Higher = more concentrated in fewer names. */
  concentrationScore: number;
  /** 1 - concentrationScore, expressed 0-100: higher = capital is spread across more positions. */
  diversificationScore: number;
  largestWinner: number;
  largestLoser: number;
  /** Composite 0-100 score: rewards diversification and a moderate cash buffer, penalizes concentration and cash sitting completely idle or fully deployed. */
  healthScore: number;
}

const HEALTHY_CASH_RATIO_PCT = 20;

export function portfolioHealth(
  trades: Trade[],
  allocations: TradeAllocation[],
  priceMap: Record<string, number>,
  cash: number
): PortfolioHealth {
  const openTrades = trades.filter(isOpen);

  const valueByTicker = new Map<string, number>();
  for (const trade of openTrades) {
    const ticker = normalizeTicker(trade.ticker);
    const price = priceMap[ticker];
    // Falls back to entry price when the ticker is missing from the price
    // snapshot, so an untracked/illiquid holding still counts toward
    // concentration instead of silently vanishing from the health picture.
    const value = trade.remainingShares * (price ?? trade.entryPrice);
    valueByTicker.set(ticker, (valueByTicker.get(ticker) ?? 0) + value);
  }

  const investedValue = [...valueByTicker.values()].reduce((sum, v) => sum + v, 0);
  const totalEquity = cash + investedValue;

  let largestPositionTicker: string | undefined;
  let largestPositionValue = 0;
  let concentrationScore = 0;
  for (const [ticker, value] of valueByTicker) {
    if (value > largestPositionValue) {
      largestPositionValue = value;
      largestPositionTicker = ticker;
    }
    const weight = investedValue > 0 ? value / investedValue : 0;
    concentrationScore += weight * weight;
  }
  const largestPositionPct = investedValue > 0 ? (largestPositionValue / investedValue) * 100 : 0;
  const diversificationScore = investedValue > 0 ? (1 - concentrationScore) * 100 : 0;

  const realizedMicros = realizedPnlMicrosForAllocations(allocations, trades);
  const largestWinner = realizedMicros.length > 0 ? Math.max(...realizedMicros) / 1_000_000 : 0;
  const largestLoser = realizedMicros.length > 0 ? Math.min(...realizedMicros) / 1_000_000 : 0;

  const cashRatioPct = cashRatio(cash, totalEquity);
  const cashComponent = investedValue > 0 ? Math.max(0, 100 - Math.abs(cashRatioPct - HEALTHY_CASH_RATIO_PCT) * 2) : 0;
  const healthScore = Math.max(0, Math.min(100, diversificationScore * 0.6 + cashComponent * 0.4));

  return {
    cashRatio: cashRatioPct,
    openTradeCount: openTrades.length,
    largestPositionTicker,
    largestPositionPct,
    concentrationScore,
    diversificationScore,
    largestWinner,
    largestLoser,
    healthScore,
  };
}

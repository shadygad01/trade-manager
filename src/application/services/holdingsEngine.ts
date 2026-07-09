import { Money } from "@domain/value-objects/Money";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { LedgerEvent, LotOpenedEvent } from "./ledgerEngine";
import type { Allocation } from "./allocationEngine";

/**
 * Holdings Engine: a per-ticker open-lot aggregate, computed fresh on every
 * call from the Ledger's LotOpened events and the Allocation Engine's
 * output — reusing TradeService.computePositions' exact formulas (cost
 * basis pro-rated by remaining/original shares, same Money arithmetic
 * throughout, same guarded division for avgCost/unrealizedPnlPct). No
 * persistence, no cache, by design (see the canonical-model spec's Holdings
 * Engine section): this reduce is O(open lots for one ticker), cheap enough
 * that caching it would just be duplicating work the Ledger/Allocation
 * caches already made cheap. If a measured bottleneck ever justifies a
 * cache later, it's a transparent, invalidate-on-commit read-through layer
 * added around this function — this function's contract never changes.
 */

export interface OpenLot extends LotOpenedEvent {
  remainingShares: number;
}

export interface Holding {
  ticker: string;
  totalShares: number;
  costBasis: number;
  avgCost: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  openLots: OpenLot[];
}

export function computeHoldings(ledgerEvents: LedgerEvent[], allocations: Allocation[], priceMap: Record<string, number>): Holding[] {
  const closedByLot = new Map<string, number>();
  for (const a of allocations) {
    closedByLot.set(a.lotEventId, (closedByLot.get(a.lotEventId) ?? 0) + a.shares);
  }

  const openLots: OpenLot[] = ledgerEvents
    .filter((e): e is LotOpenedEvent => e.type === "LotOpened")
    .map((lot) => ({ ...lot, remainingShares: lot.shares - (closedByLot.get(lot.eventId) ?? 0) }))
    .filter((lot) => lot.remainingShares > 0);

  const byTicker = new Map<string, OpenLot[]>();
  for (const lot of openLots) {
    const ticker = normalizeTicker(lot.ticker);
    const bucket = byTicker.get(ticker);
    if (bucket) bucket.push(lot);
    else byTicker.set(ticker, [lot]);
  }

  const holdings: Holding[] = [];
  for (const [ticker, tickerLots] of byTicker) {
    const totalShares = tickerLots.reduce((sum, l) => sum + l.remainingShares, 0);
    const costBasis = Money.sum(
      tickerLots.map((l) => Money.from(l.price * l.shares + (l.fees ?? 0) + (l.taxes ?? 0)).multiply(l.remainingShares / l.shares))
    );
    const avgCost = totalShares > 0 ? costBasis.divide(totalShares).toNumber() : 0;
    const currentPrice = priceMap[ticker];
    const marketValue = currentPrice !== undefined ? totalShares * currentPrice : undefined;
    const unrealizedPnl = marketValue !== undefined ? marketValue - costBasis.toNumber() : undefined;
    const unrealizedPnlPct =
      unrealizedPnl !== undefined && costBasis.isPositive() ? (unrealizedPnl / costBasis.toNumber()) * 100 : undefined;

    holdings.push({
      ticker,
      totalShares,
      costBasis: costBasis.toNumber(),
      avgCost,
      currentPrice,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPct,
      openLots: tickerLots,
    });
  }

  return holdings;
}

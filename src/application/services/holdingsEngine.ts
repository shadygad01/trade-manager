import { Money } from "@domain/value-objects/Money";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { LedgerEvent, LotOpenedEvent, SellRecordedEvent } from "./ledgerEngine";
import type { Allocation } from "./allocationEngine";

/**
 * Holdings Engine: a per-ticker open-lot aggregate, computed fresh from the
 * canonical ledger. Explicit allocation decisions remain authoritative for
 * lot choice. If a verified SellRecorded event has no usable allocation, the
 * remaining shares are consumed deterministically FIFO so a closed position
 * cannot survive merely because an allocation fact is missing or stale.
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

function eventChronoKey(event: LedgerEvent): string {
  return `${event.executionDate}T${event.executionTime ?? "00:00"}`;
}

function buildOpenLots(ledgerEvents: LedgerEvent[], allocations: Allocation[]): OpenLot[] {
  const lots = ledgerEvents
    .filter((event): event is LotOpenedEvent => event.type === "LotOpened")
    .map((lot) => ({ ...lot, remainingShares: lot.shares }));
  const lotById = new Map(lots.map((lot) => [lot.eventId, lot]));
  const allocatedBySell = new Map<string, number>();

  // Apply explicit decisions first. Clamp per-lot deductions so malformed or
  // duplicated decisions cannot create negative inventory.
  for (const allocation of allocations) {
    const lot = lotById.get(allocation.lotEventId);
    if (!lot) continue;
    const deduction = Math.min(Math.max(allocation.shares, 0), lot.remainingShares);
    lot.remainingShares -= deduction;
    allocatedBySell.set(allocation.sellEventId, (allocatedBySell.get(allocation.sellEventId) ?? 0) + deduction);
  }

  // Any verified sell not covered by a usable explicit decision is still an
  // economic disposal. Consume only lots that existed when the sell happened,
  // oldest first. This preserves explicit user choices while guaranteeing the
  // invariant: open shares = max(0, buys - verified sells).
  const sells = ledgerEvents
    .filter((event): event is SellRecordedEvent => event.type === "SellRecorded")
    .sort((a, b) => eventChronoKey(a).localeCompare(eventChronoKey(b)) || a.eventId.localeCompare(b.eventId));
  for (const sell of sells) {
    let remainingToAllocate = Math.max(0, sell.shares - (allocatedBySell.get(sell.eventId) ?? 0));
    if (remainingToAllocate <= 0) continue;
    const eligibleLots = lots
      .filter((lot) => lot.remainingShares > 0 && eventChronoKey(lot) <= eventChronoKey(sell))
      .sort((a, b) => eventChronoKey(a).localeCompare(eventChronoKey(b)) || a.eventId.localeCompare(b.eventId));
    for (const lot of eligibleLots) {
      if (remainingToAllocate <= 0) break;
      const deduction = Math.min(lot.remainingShares, remainingToAllocate);
      lot.remainingShares -= deduction;
      remainingToAllocate -= deduction;
    }
  }

  return lots.filter((lot) => lot.remainingShares > 1e-6);
}

export function computeHoldings(ledgerEvents: LedgerEvent[], allocations: Allocation[], priceMap: Record<string, number>): Holding[] {
  const openLots = buildOpenLots(ledgerEvents, allocations);
  const byTicker = new Map<string, OpenLot[]>();
  for (const lot of openLots) {
    const ticker = normalizeTicker(lot.ticker);
    const bucket = byTicker.get(ticker);
    if (bucket) bucket.push(lot);
    else byTicker.set(ticker, [lot]);
  }

  const holdings: Holding[] = [];
  for (const [ticker, tickerLots] of byTicker) {
    const totalShares = tickerLots.reduce((sum, lot) => sum + lot.remainingShares, 0);
    const costBasis = Money.sum(
      tickerLots.map((lot) => Money.from(lot.price * lot.shares + (lot.fees ?? 0) + (lot.taxes ?? 0)).multiply(lot.remainingShares / lot.shares))
    );
    const avgCost = totalShares > 0 ? costBasis.divide(totalShares).toNumber() : 0;
    const currentPrice = priceMap[ticker];
    const marketValue = currentPrice !== undefined ? totalShares * currentPrice : undefined;
    const unrealizedPnl = marketValue !== undefined ? marketValue - costBasis.toNumber() : undefined;
    const unrealizedPnlPct = unrealizedPnl !== undefined && costBasis.isPositive() ? (unrealizedPnl / costBasis.toNumber()) * 100 : undefined;

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

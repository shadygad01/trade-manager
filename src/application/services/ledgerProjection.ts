import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type {
  RawTransactionRepository,
  TradeRepository,
  TradeAllocationRepository,
  TimelineRepository,
  JournalRepository,
} from "@domain/repositories";
import {
  createRawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { generateId } from "@domain/value-objects/id";
import { canonicalKey } from "./ledgerRebuild";
import type { LedgerEvent, LotOpenedEvent } from "./ledgerEngine";
import type { Allocation } from "./allocationEngine";

/**
 * Legacy-Ledger Projection: makes the Trade/TradeAllocation tables (the only
 * thing the UI reads) a DERIVED view of the committed raw-transaction output,
 * per (portfolioId, ticker), instead of accumulated mutable state. Called by
 * commitEngine.commitTicker right after it rewrites ledgerCache — so the same
 * event that makes the canonical ledger more correct (a better historical
 * import reaching a terminal verdict) now also rewrites the legacy rows the
 * user actually sees. remainingShares is always recomputed here from the
 * replayed allocations, never carried over from the previous value.
 *
 * Identity is stable across re-projection: LedgerEvent.eventId IS
 * canonicalKey(side/ticker/date/shares/price) (see canonicalizeTradeEntries),
 * so an existing legacy Trade whose own canonical key equals a lot's eventId
 * is UPDATED in place — same id, same notes/strategyTags/sector/createdAt —
 * keeping journal entries and timeline references valid. Only a lot with no
 * existing counterpart creates a new row, and only an existing row no longer
 * present in the rebuilt ledger is deleted (with its journal entry and Buy
 * timeline event, mirroring deleteTrade's cleanup).
 *
 * DELIBERATELY NEVER TOUCHES portfolio.cash. Legacy recordBuy/recordSell/
 * deleteTrade mutate cash imperatively at action time; a projection that
 * re-applied cash for corrected history would double-count everything the
 * legacy flow already applied. Historical corrections are share-count/lot
 * corrections; cash remains the user's explicitly-editable figure (see
 * PortfolioService.setCash and docs/ROADMAP.md's open cash-redesign item).
 */

export interface LegacyLedgerRepos {
  rawTransactions: RawTransactionRepository;
  trades: TradeRepository;
  allocations: TradeAllocationRepository;
  timeline?: TimelineRepository;
  journal?: JournalRepository;
}

function tradeCanonicalKey(t: Trade): string {
  return canonicalKey({ side: "BUY", ticker: normalizeTicker(t.ticker), date: t.executionDate, shares: t.shares, price: t.entryPrice });
}

/** Same grouping backfillRawTransactions uses — sellGroupId with the legacy composite fallback. */
function groupBySellOrder(allocations: TradeAllocation[]): Map<string, TradeAllocation[]> {
  const groups = new Map<string, TradeAllocation[]>();
  for (const a of allocations) {
    const key = a.sellGroupId || `legacy:${a.executionDate}|${Math.round(a.exitPrice * 10_000) / 10_000}`;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  return groups;
}

/**
 * Gap-backfill, per ticker, run BEFORE every projection: any legacy Trade or
 * sell order for (portfolioId, ticker) that has no matching live raw fact
 * gets one appended (source "backfill" — unconditionally trusted by the
 * Verification Engine, same as the original one-time backfill). Without
 * this, a projection would delete legitimate legacy rows created by flows
 * that predate their fact writers (manual buys/sells recorded between the
 * original backfill and Phase 9.8). Idempotent by construction: an existing
 * live fact with the same canonical key means nothing is appended. A buy
 * fact appended here reuses the legacy trade's own id, keeping the
 * fact-to-trade correlation exact. Appends go straight to
 * rawTransactions.append — never appendAndMaybeCommit — because this runs
 * INSIDE commitTicker (recursion would deadlock nothing but would recompute
 * everything redundantly).
 */
export async function ensureLegacyFactsExist(repos: LegacyLedgerRepos, portfolioId: string, ticker: string): Promise<number> {
  const normalized = normalizeTicker(ticker);
  const all = await repos.rawTransactions.getAll();

  // Keyed on EVER-existed, not just live: a retracted fact means the user
  // explicitly voided that execution (deleteTrade, a discarded candidate) —
  // re-appending a fresh backfill fact for the same canonical key would
  // resurrect exactly what they deleted, in a loop (retract → gap-fill
  // re-facts → projection re-creates the row → retract again...). A key
  // that was never seen at all is the only genuine gap this fills.
  const everBuyKeys = new Set(
    all
      .filter((t) => t.kind === "BuyExecution" && t.ticker !== undefined && normalizeTicker(t.ticker) === normalized)
      .map((t) => {
        const p = t.payload as BuyExecutionPayload;
        return canonicalKey({ side: "BUY", ticker: normalized, date: p.executionDate, shares: p.shares, price: p.price });
      })
  );
  const everSellKeys = new Set(
    all
      .filter((t) => t.kind === "SellExecution" && t.ticker !== undefined && normalizeTicker(t.ticker) === normalized)
      .map((t) => {
        const p = t.payload as SellExecutionPayload;
        return canonicalKey({ side: "SELL", ticker: normalized, date: p.executionDate, shares: p.shares, price: p.price });
      })
  );
  const everDecisionSellIds = new Set(
    all.filter((t) => t.kind === "SellAllocationDecision").map((t) => (t.payload as SellAllocationDecisionPayload).sellExecutionId)
  );
  const existingIds = new Set(all.map((t) => t.id));

  const legacyTrades = (await repos.trades.getByPortfolio(portfolioId)).filter((t) => normalizeTicker(t.ticker) === normalized);
  const legacyAllocations = (await repos.allocations.getByPortfolio(portfolioId)).filter((a) => normalizeTicker(a.ticker) === normalized);
  const tradeById = new Map(legacyTrades.map((t) => [t.id, t]));

  let appended = 0;

  for (const trade of legacyTrades) {
    if (everBuyKeys.has(tradeCanonicalKey(trade))) continue;
    const payload: BuyExecutionPayload = {
      ticker: normalized,
      shares: trade.shares,
      price: trade.entryPrice,
      fees: trade.fees,
      taxes: trade.taxes,
      executionDate: trade.executionDate,
      executionTime: trade.executionTime,
      companyName: trade.companyName,
      transactionNumber: trade.transactionNumber,
      notes: trade.notes,
      strategyTags: trade.strategyTags.length > 0 ? trade.strategyTags : undefined,
      sector: trade.sector,
    };
    await repos.rawTransactions.append(
      createRawTransaction({
        id: existingIds.has(trade.id) ? undefined : trade.id,
        kind: "BuyExecution",
        source: "backfill",
        portfolioId,
        ticker: normalized,
        payload,
      })
    );
    everBuyKeys.add(tradeCanonicalKey(trade));
    appended += 1;
  }

  for (const [, group] of groupBySellOrder(legacyAllocations)) {
    const first = group[0];
    const totalShares = group.reduce((sum, a) => sum + a.sharesClosed, 0);
    const sellKey = canonicalKey({ side: "SELL", ticker: normalized, date: first.executionDate, shares: totalShares, price: first.exitPrice });

    if (!everSellKeys.has(sellKey)) {
      const sellPayload: SellExecutionPayload = {
        ticker: normalized,
        shares: totalShares,
        price: first.exitPrice,
        fees: group.reduce((sum, a) => sum + a.fees, 0),
        taxes: group.reduce((sum, a) => sum + a.taxes, 0),
        executionDate: first.executionDate,
        executionTime: first.executionTime,
        transactionNumber: first.transactionNumber,
        notes: first.notes,
        exitReason: first.exitReason,
      };
      await repos.rawTransactions.append(
        createRawTransaction({ kind: "SellExecution", source: "backfill", portfolioId, ticker: normalized, payload: sellPayload })
      );
      everSellKeys.add(sellKey);
      appended += 1;
    }

    // The decision is the half Import's own SellExecution write never covers
    // — this is what preserves a manual lot-selection (ADR-002) as an
    // immutable fact so it survives every future rebuild.
    if (!everDecisionSellIds.has(sellKey)) {
      const decisionAllocations = group.flatMap((a) => {
        const trade = tradeById.get(a.tradeId);
        if (!trade) return [];
        return [{ lotRef: tradeCanonicalKey(trade), shares: a.sharesClosed }];
      });
      if (decisionAllocations.length > 0) {
        const decisionPayload: SellAllocationDecisionPayload = { sellExecutionId: sellKey, allocations: decisionAllocations };
        await repos.rawTransactions.append(
          createRawTransaction({ kind: "SellAllocationDecision", source: "backfill", portfolioId, ticker: normalized, payload: decisionPayload })
        );
        everDecisionSellIds.add(sellKey);
        appended += 1;
      }
    }
  }

  return appended;
}

function tradesEqual(a: Trade, b: Trade): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function allocationsEqual(a: TradeAllocation, b: TradeAllocation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rewrites (portfolioId, ticker)'s legacy Trade/TradeAllocation rows from the
 * freshly committed Ledger/Allocation Engine output. See the module doc
 * comment for the identity, deletion, and cash rules.
 */
export async function projectLegacyTicker(
  repos: LegacyLedgerRepos,
  portfolioId: string,
  ticker: string,
  events: LedgerEvent[],
  engineAllocations: Allocation[]
): Promise<void> {
  const normalized = normalizeTicker(ticker);
  const existingTrades = (await repos.trades.getByPortfolio(portfolioId)).filter((t) => normalizeTicker(t.ticker) === normalized);
  const existingAllocations = (await repos.allocations.getByPortfolio(portfolioId)).filter((a) => normalizeTicker(a.ticker) === normalized);

  const lots = events.filter((e): e is LotOpenedEvent => e.type === "LotOpened");
  const closedByLot = new Map<string, number>();
  for (const a of engineAllocations) {
    closedByLot.set(a.lotEventId, (closedByLot.get(a.lotEventId) ?? 0) + a.shares);
  }

  const existingByCanonicalKey = new Map(existingTrades.map((t) => [tradeCanonicalKey(t), t]));
  const tradeIdByLotEventId = new Map<string, string>();
  const keptTradeIds = new Set<string>();

  for (const lot of lots) {
    const remainingShares = lot.shares - (closedByLot.get(lot.eventId) ?? 0);
    const match = existingByCanonicalKey.get(lot.eventId);
    if (match) {
      tradeIdByLotEventId.set(lot.eventId, match.id);
      keptTradeIds.add(match.id);
      const updated: Trade = {
        ...match,
        fees: lot.fees ?? match.fees,
        taxes: lot.taxes ?? match.taxes,
        executionTime: lot.executionTime ?? match.executionTime,
        companyName: lot.companyName ?? match.companyName,
        transactionNumber: lot.transactionNumber ?? match.transactionNumber,
        remainingShares,
      };
      if (!tradesEqual(match, updated)) await repos.trades.save(updated);
    } else {
      const created: Trade = {
        id: lot.eventId,
        portfolioId,
        ticker: normalized,
        companyName: lot.companyName,
        sector: sectorForTicker(normalized),
        shares: lot.shares,
        entryPrice: lot.price,
        fees: lot.fees ?? 0,
        taxes: lot.taxes ?? 0,
        executionDate: lot.executionDate,
        executionTime: lot.executionTime ?? "00:00",
        remainingShares,
        strategyTags: [],
        createdAt: new Date().toISOString(),
        transactionNumber: lot.transactionNumber,
      };
      await repos.trades.save(created);
      tradeIdByLotEventId.set(lot.eventId, created.id);
      keptTradeIds.add(created.id);
      if (repos.timeline) {
        const cost = lot.shares * lot.price + (lot.fees ?? 0) + (lot.taxes ?? 0);
        await repos.timeline.save(
          createTimelineEvent({
            id: generateId(),
            portfolioId,
            type: "Buy",
            timestamp: `${lot.executionDate}T${lot.executionTime ?? "00:00"}`,
            ticker: normalized,
            relatedTradeIds: [created.id],
            amount: -cost,
            shares: lot.shares,
          })
        );
      }
    }
  }

  for (const stale of existingTrades) {
    if (keptTradeIds.has(stale.id)) continue;
    if (repos.journal) {
      const entry = await repos.journal.getByTrade(stale.id);
      if (entry) await repos.journal.delete(entry.id);
    }
    if (repos.timeline) {
      const events_ = await repos.timeline.getByPortfolio(portfolioId);
      const buyEvent = events_.find((e) => e.type === "Buy" && e.relatedTradeIds?.includes(stale.id));
      if (buyEvent) await repos.timeline.delete(buyEvent.id);
    }
    await repos.trades.delete(stale.id);
  }

  const keptAllocationIds = new Set<string>();
  for (const a of engineAllocations) {
    const tradeId = tradeIdByLotEventId.get(a.lotEventId);
    if (!tradeId) continue;
    const match = existingAllocations.find(
      (x) => x.tradeId === tradeId && x.sharesClosed === a.shares && x.executionDate === a.executionDate
    );
    if (match) {
      keptAllocationIds.add(match.id);
      const updated: TradeAllocation = {
        ...match,
        exitPrice: a.price,
        fees: a.fees,
        taxes: a.taxes,
        executionTime: a.executionTime ?? match.executionTime,
        transactionNumber: a.transactionNumber ?? match.transactionNumber,
      };
      if (!allocationsEqual(match, updated)) await repos.allocations.save(updated);
    } else {
      const created: TradeAllocation = {
        id: a.id,
        sellGroupId: a.sellEventId,
        portfolioId,
        tradeId,
        ticker: normalized,
        sharesClosed: a.shares,
        exitPrice: a.price,
        fees: a.fees,
        taxes: a.taxes,
        executionDate: a.executionDate,
        executionTime: a.executionTime ?? "00:00",
        createdAt: new Date().toISOString(),
        transactionNumber: a.transactionNumber,
      };
      await repos.allocations.save(created);
      keptAllocationIds.add(created.id);
    }
  }

  for (const stale of existingAllocations) {
    if (!keptAllocationIds.has(stale.id)) await repos.allocations.delete(stale.id);
  }
}

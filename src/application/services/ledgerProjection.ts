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
  type RawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { generateId } from "@domain/value-objects/id";
import { type GroupingSignature, toGroupingSignature } from "@domain/value-objects/identity";
import { canonicalKey } from "./ledgerRebuild";
import { isRetracted, findLiveExecutionFact } from "./rawTransactionFolds";
import { timesConflict } from "./duplicateDetection";
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

/**
 * Resolves the id a SellAllocationDecision should reference for this buy
 * lot: the real, always-unique RawTransaction id of the live BuyExecution
 * fact this trade already owns.
 *
 * `id === trade.id` (the fast path below) does NOT hold whenever
 * `ensureBuyFact` (TradeService.ts) ADOPTED a pre-existing extraction-time
 * fact rather than minting a fresh one — the whole point of the broker-
 * record trust policy — since adoption assigns the fact's portfolio without
 * ever renaming the fact's own id to match the freshly-generated `trade.id`
 * (see `ensureBuyFact`'s `else` branch). This was a real, found bug: for
 * every Excel-adopted lot, `resolveLotRef` fell all the way through to the
 * TIME-BLIND `tradeCanonicalKey` fallback, so two genuinely distinct real
 * Buys sharing every field except execution time (routine — splitting a
 * large order into same-price fills minutes apart, e.g. a real reported
 * case: two 49-share buys at E£42.40 on 01 Feb 2023, 10:32AM and 10:34AM)
 * produced the IDENTICAL `lotRef` string. The Allocation Engine could then
 * silently misattribute a Sell's allocation against the wrong lot of the
 * pair during any later ledger rebuild/projection replay, corrupting the
 * ticker's remaining-share count with no error, no race, and no
 * concurrency involved — fully deterministic, reproduced from a real
 * user's broker Excel replayed sequentially with no concurrent calls at all.
 *
 * Fixed by trying a value+time-disambiguated live-fact lookup (the same
 * `findLiveExecutionFact` helper `ensureBuyFact`'s own `sameValueCandidates`
 * tie-break and `findUnclaimedSellExecutionFact` already use for this exact
 * problem) before falling back to the fully time-blind canonical key — the
 * canonical-key fallback now only applies when even time can't disambiguate
 * (e.g. two real fills at the identical minute) or no fact exists at all
 * yet (pre-migration data, or a caller that hasn't run
 * `ensureLegacyFactsExist` for this ticker).
 */
export function resolveLotRef(all: RawTransaction[], trade: Trade): string {
  const ownFact = all.find((t) => t.id === trade.id && t.kind === "BuyExecution" && !isRetracted(all, t.id));
  if (ownFact) return ownFact.id;
  const matched = findLiveExecutionFact(all, {
    kind: "BuyExecution",
    ticker: normalizeTicker(trade.ticker),
    date: trade.executionDate,
    shares: trade.shares,
    price: trade.entryPrice,
    time: trade.executionTime,
  });
  return matched ? matched.id : tradeCanonicalKey(trade);
}

/** Same grouping backfillRawTransactions/duplicateDetection.groupSellAllocationsByOrder use — sellGroupId with the legacy composite fallback (date+price+time, so two distinct legacy same-day/same-price sell orders never merge — see duplicateDetection.ts's own doc comment on this key). */
function groupBySellOrder(allocations: TradeAllocation[]): Map<GroupingSignature, TradeAllocation[]> {
  const groups = new Map<GroupingSignature, TradeAllocation[]>();
  for (const a of allocations) {
    const key = toGroupingSignature(a.sellGroupId || `legacy:${a.executionDate}|${Math.round(a.exitPrice * 10_000) / 10_000}|${a.executionTime}`);
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
 * original backfill and Phase 9.8). A buy fact appended here reuses the
 * legacy trade's own id, keeping the fact-to-trade correlation exact.
 * Appends go straight to rawTransactions.append — never appendAndMaybeCommit
 * — because this runs INSIDE commitTicker (recursion would deadlock nothing
 * but would recompute everything redundantly).
 *
 * Coverage is counted per canonical-key GROUP, not checked as a plain
 * boolean: two legacy trades (or sell orders) can legitimately share an
 * identical canonical key (same ticker/date/shares/price), and a boolean
 * "has this key been seen" check would consider the second one already
 * covered by the first's fact, permanently leaving it with none of its own
 * — exactly the gap that let the second one silently vanish once the next
 * projection ran (it's absent from `keptTradeIds`/`keptAllocationIds`, so
 * treated as stale and deleted). Each trade/sell-order instance is matched
 * to its own live fact 1:1 (already-id-linked instances first, then any
 * remaining unlinked live facts of that value, oldest processing order
 * first); only once every existing fact in the group is claimed does a
 * further instance get a brand new fact of its own.
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
  const liveBuyFactsByKey = new Map<string, RawTransaction[]>();
  for (const t of all) {
    if (t.kind !== "BuyExecution" || t.ticker === undefined || normalizeTicker(t.ticker) !== normalized) continue;
    if (isRetracted(all, t.id)) continue;
    const p = t.payload as BuyExecutionPayload;
    const key = canonicalKey({ side: "BUY", ticker: normalized, date: p.executionDate, shares: p.shares, price: p.price });
    const list = liveBuyFactsByKey.get(key) ?? [];
    list.push(t);
    liveBuyFactsByKey.set(key, list);
  }
  const liveSellFactsByKey = new Map<string, RawTransaction[]>();
  for (const t of all) {
    if (t.kind !== "SellExecution" || t.ticker === undefined || normalizeTicker(t.ticker) !== normalized) continue;
    if (isRetracted(all, t.id)) continue;
    const p = t.payload as SellExecutionPayload;
    const key = canonicalKey({ side: "SELL", ticker: normalized, date: p.executionDate, shares: p.shares, price: p.price });
    const list = liveSellFactsByKey.get(key) ?? [];
    list.push(t);
    liveSellFactsByKey.set(key, list);
  }
  const everDecisionSellIds = new Set(
    all
      .filter((t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id))
      .map((t) => (t.payload as SellAllocationDecisionPayload).sellExecutionId)
  );

  const legacyTrades = (await repos.trades.getByPortfolio(portfolioId))
    .filter((t) => normalizeTicker(t.ticker) === normalized)
    .sort((a, b) => a.id.localeCompare(b.id));
  const legacyAllocations = (await repos.allocations.getByPortfolio(portfolioId)).filter((a) => normalizeTicker(a.ticker) === normalized);
  const tradeById = new Map(legacyTrades.map((t) => [t.id, t]));

  let appended = 0;

  const consumedBuyCount = new Map<string, number>();
  for (const trade of legacyTrades) {
    const key = tradeCanonicalKey(trade);
    const candidates = liveBuyFactsByKey.get(key) ?? [];
    if (candidates.some((f) => f.id === trade.id)) continue; // already id-linked — covered.

    const consumed = consumedBuyCount.get(key) ?? 0;
    consumedBuyCount.set(key, consumed + 1);
    if (consumed < candidates.length) continue; // an existing (unlinked, e.g. Import-written) fact covers this instance.

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
    const fact = createRawTransaction({ id: trade.id, kind: "BuyExecution", source: "backfill", portfolioId, ticker: normalized, payload });
    await repos.rawTransactions.append(fact);
    // Recorded in `all` (not just the by-key index) so this same call's
    // later sell-decision pass can resolve `resolveLotRef` against it too,
    // when a sell being backfilled in the SAME pass closes this exact lot.
    all.push({ ...fact, seq: 0 });
    appended += 1;
  }

  const consumedSellCount = new Map<string, number>();
  for (const [, group] of groupBySellOrder(legacyAllocations)) {
    const first = group[0];
    const totalShares = group.reduce((sum, a) => sum + a.sharesClosed, 0);
    const sellValueKey = canonicalKey({ side: "SELL", ticker: normalized, date: first.executionDate, shares: totalShares, price: first.exitPrice });
    const candidateFactId = first.sellGroupId || undefined;
    const sellCandidates = liveSellFactsByKey.get(sellValueKey) ?? [];

    let sellExecutionId: string;
    const alreadyLinked = candidateFactId !== undefined && sellCandidates.some((f) => f.id === candidateFactId);
    if (alreadyLinked) {
      sellExecutionId = candidateFactId!;
    } else {
      const consumed = consumedSellCount.get(sellValueKey) ?? 0;
      consumedSellCount.set(sellValueKey, consumed + 1);
      if (consumed < sellCandidates.length) {
        // An existing (unlinked, e.g. Import-written) fact covers this sell order instance.
        sellExecutionId = sellCandidates[consumed].id;
      } else {
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
        const fact = createRawTransaction({
          id: candidateFactId,
          kind: "SellExecution",
          source: "backfill",
          portfolioId,
          ticker: normalized,
          payload: sellPayload,
        });
        await repos.rawTransactions.append(fact);
        sellExecutionId = fact.id;
        appended += 1;
      }
    }

    // The decision is the half Import's own SellExecution write never covers
    // — this is what preserves a manual lot-selection (ADR-002) as an
    // immutable fact so it survives every future rebuild.
    if (!everDecisionSellIds.has(sellExecutionId) && !everDecisionSellIds.has(sellValueKey)) {
      const decisionAllocations = group.flatMap((a) => {
        const trade = tradeById.get(a.tradeId);
        if (!trade) return [];
        return [{ lotRef: resolveLotRef(all, trade), shares: a.sharesClosed }];
      });
      if (decisionAllocations.length > 0) {
        const decisionPayload: SellAllocationDecisionPayload = { sellExecutionId, allocations: decisionAllocations };
        await repos.rawTransactions.append(
          createRawTransaction({ kind: "SellAllocationDecision", source: "backfill", portfolioId, ticker: normalized, payload: decisionPayload })
        );
        everDecisionSellIds.add(sellExecutionId);
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

  // Grouped by VALUE (not a plain 1:1 map): two existing trades can share an
  // identical canonicalKey when they share ticker/date/shares/price (the
  // exact scenario this fix exists for), so a lot's plain or disambiguated
  // eventId must be resolved WITHIN this value-sharing group, never by a
  // single overwritten map slot — see resolveExistingTradeForLot below.
  const existingByValueKey = new Map<string, Trade[]>();
  for (const t of existingTrades) {
    const list = existingByValueKey.get(tradeCanonicalKey(t)) ?? [];
    list.push(t);
    existingByValueKey.set(tradeCanonicalKey(t), list);
  }
  const claimedTradeIds = new Set<string>();

  /**
   * Resolves which (if any) existing Trade row this lot event already
   * corresponds to. An EXACT id match (a trade a prior projection already
   * linked to this exact lot identity — correct even when two trades share
   * a value, since each disambiguated eventId is unique) always wins over a
   * same-value FALLBACK match (any not-yet-claimed trade sharing this lot's
   * plain value — needed for a trade this projection has never linked
   * before, e.g. a freshly manually-recorded trade whose own id is an
   * arbitrary UUID unrelated to any canonicalKey shape). Both maps are
   * pre-built (`matchLotsToTrades` below) in a dedicated EXACT-first pass
   * across ALL lots before any fallback claim happens — resolving one lot
   * at a time, in `lots`' own chronological order, would let an early lot
   * "steal" via fallback the very trade a LATER lot in the same group was
   * always meant to exact-match, corrupting whichever trade loses the race
   * (see the regression test proving two same-value Buy lots survive
   * multiple sequential commits regardless of chronological order).
   */
  const exactMatchByLotEventId = new Map<string, Trade>();
  for (const lot of lots) {
    const plainValueKey = canonicalKey({ side: "BUY", ticker: normalized, date: lot.executionDate, shares: lot.shares, price: lot.price });
    const candidates = existingByValueKey.get(plainValueKey) ?? [];
    const exact = candidates.find((t) => t.id === lot.eventId);
    if (exact) exactMatchByLotEventId.set(lot.eventId, exact);
  }

  function resolveExistingTradeForLot(lot: LotOpenedEvent): Trade | undefined {
    const exact = exactMatchByLotEventId.get(lot.eventId);
    if (exact && !claimedTradeIds.has(exact.id)) return exact;
    if (exact) return undefined; // its exact match is already claimed by itself elsewhere — impossible by construction, but never silently fall through to steal another trade
    const plainValueKey = canonicalKey({ side: "BUY", ticker: normalized, date: lot.executionDate, shares: lot.shares, price: lot.price });
    const candidates = existingByValueKey.get(plainValueKey) ?? [];
    // A candidate destined for a DIFFERENT lot's exact match is off-limits to
    // this lot's fallback, even before that other lot has been processed —
    // otherwise the same steal this two-pass split exists to prevent could
    // still happen via the fallback branch itself.
    const reservedForOtherLot = new Set(
      [...exactMatchByLotEventId.entries()].filter(([eventId]) => eventId !== lot.eventId).map(([, t]) => t.id)
    );
    const available = candidates.filter((t) => !claimedTradeIds.has(t.id) && !reservedForOtherLot.has(t.id));
    // The value key is time-blind (ticker/date/shares/price only), so two
    // genuinely distinct lots (e.g. two same-price fills minutes apart) can
    // both land in `available`. Prefer whichever one's own executionTime
    // actually agrees with this lot's, rather than array order, so a real
    // execution's Trade row keeps updating in place instead of a wrong
    // sibling being claimed here (real, reproduced bug: the unclaimed
    // sibling then fell to the "no match" branch below and spawned a
    // phantom extra Trade for the SAME real execution). Falls back to the
    // first available candidate, unchanged from prior behavior, when time
    // can't disambiguate.
    return available.length > 1 ? (available.find((t) => !timesConflict(lot.executionTime, t.executionTime)) ?? available[0]) : available[0];
  }

  const tradeIdByLotEventId = new Map<string, string>();
  const keptTradeIds = new Set<string>();

  for (const lot of lots) {
    const remainingShares = lot.shares - (closedByLot.get(lot.eventId) ?? 0);
    const match = resolveExistingTradeForLot(lot);
    if (match) {
      claimedTradeIds.add(match.id);
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

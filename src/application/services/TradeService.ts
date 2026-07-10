import { createTrade, isOpen, type Trade } from "@domain/entities/Trade";
import { createTradeAllocation, realizedPnlMicros, type TradeAllocation } from "@domain/entities/TradeAllocation";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { sectorForTicker } from "@domain/value-objects/knownSectors";
import { KNOWN_EGX_TICKERS, tickerForCompanyNameFallback } from "@domain/value-objects/knownTickers";
import { getTrackingStartDate, isBeforeTrackingStart } from "@domain/value-objects/trackingWindow";
import type { AppRepositories } from "./types";
import { retractRawTransaction, renameRawTransactionsTicker, assignPortfolio, appendAndMaybeCommit, type CommitEngineRepos } from "./commitEngine";
import { canonicalKey } from "./ledgerRebuild";
import { isRetracted } from "./rawTransactionFolds";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";

function companyNameForTicker(ticker: string): string | undefined {
  return KNOWN_EGX_TICKERS.find((t) => t.ticker === ticker)?.companyName;
}

function assertWithinTrackingRange(executionDate: string): void {
  if (isBeforeTrackingStart(executionDate)) {
    throw new Error(`Transactions before ${getTrackingStartDate()} are not tracked: got ${executionDate}`);
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
  /** Broker-assigned unique execution ID (e.g. Thndr's Invoice "Transaction No.") when the source document carried one — see Trade.transactionNumber. */
  transactionNumber?: string;
}

export interface RecordBuyResult {
  trade: Trade;
}

/**
 * Phase 9.8 fact writer: every recorded Buy now also lands in the immutable
 * RawTransaction log (when the repos bundle carries it — the app's real
 * singleton always does), so a manual Record Buy is no longer invisible to
 * the canonical rebuild. Guarded by canonical-key lookup: an Import-flow Buy
 * whose fact was already written at extraction time (importRecording.ts)
 * appends nothing — it only gets its portfolio assignment confirmed. Same
 * non-fatal isolation as every dual-write in this migration.
 */
async function ensureBuyFact(repos: CommitEngineRepos & Partial<AppRepositories>, trade: Trade, input: RecordBuyInput): Promise<void> {
  const ticker = normalizeTicker(trade.ticker);
  const key = canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
  const all = await repos.rawTransactions.getAll();
  const liveMatch = all.find((t) => {
    if (t.kind !== "BuyExecution" || t.ticker === undefined || normalizeTicker(t.ticker) !== ticker) return false;
    if (isRetracted(all, t.id)) return false;
    const p = t.payload as BuyExecutionPayload;
    return canonicalKey({ side: "BUY", ticker, date: p.executionDate, shares: p.shares, price: p.price }) === key;
  });

  if (!liveMatch) {
    const payload: BuyExecutionPayload = {
      ticker,
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
      // Only a genuine user override is a fact — a derivable sector is recomputed, never stored.
      sector: input.sector,
    };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ id: trade.id, kind: "BuyExecution", source: "manual", portfolioId: trade.portfolioId, ticker, payload })
    );
  } else {
    await assignPortfolio(repos, ticker, trade.portfolioId);
  }
}

export async function recordBuy(repos: AppRepositories & Partial<CommitEngineRepos>, input: RecordBuyInput): Promise<RecordBuyResult> {
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
    transactionNumber: input.transactionNumber,
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

  if (repos.rawTransactions && repos.committedLedger) {
    await ensureBuyFact(repos as AppRepositories & CommitEngineRepos, trade, input).catch((err) => {
      console.error("ensureBuyFact failed (fact write, non-fatal):", err);
    });
  }

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
export async function deleteTrade(repos: AppRepositories & Partial<CommitEngineRepos>, tradeId: string): Promise<void> {
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

  // Migration dual-write: retract the matching RawTransaction (if this repos
  // bundle is wired up for the new architecture — see presentation/lib/data.ts)
  // so a deleted trade can't resurrect itself the next time this ticker's
  // portfolio assignment/commit runs. Best-effort and isolated for the same
  // reason as every other shadow write in this migration (see ImportPage.tsx's
  // recordImportedRawTransactions/assignPortfolio calls) — a failure here must
  // never turn a successful, already-applied legacy delete into a thrown error.
  if (repos.rawTransactions && repos.committedLedger) {
    const commitRepos: CommitEngineRepos = { rawTransactions: repos.rawTransactions, committedLedger: repos.committedLedger };
    await retractMatchingRawTransaction(commitRepos, trade).catch((err) => {
      console.error("Raw transaction retraction failed (shadow write, non-fatal):", err);
    });
  }
}

/**
 * Finds every live BuyExecution RawTransaction that corresponds to a legacy
 * Trade — same correlation key (ticker/side/date/shares/price)
 * backfillRawTransactions and systemValidation already use to line up old
 * and new records — and retracts them ALL. Retracting only the first match
 * used to be enough (nothing read the facts); with Phase 9.8's legacy
 * projection, any lingering live same-key fact would re-CREATE the deleted
 * trade as a freshly projected lot on the ticker's next commit — the exact
 * resurrection this retraction exists to prevent.
 */
async function retractMatchingRawTransaction(repos: CommitEngineRepos, trade: Trade): Promise<void> {
  const ticker = normalizeTicker(trade.ticker);
  const key = canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
  const all = await repos.rawTransactions.getAll();
  const matches = all.filter((t) => {
    if (t.kind !== "BuyExecution" || t.ticker === undefined || normalizeTicker(t.ticker) !== ticker) return false;
    if (isRetracted(all, t.id)) return false;
    const payload = t.payload as BuyExecutionPayload;
    return canonicalKey({ side: "BUY", ticker, date: payload.executionDate, shares: payload.shares, price: payload.price }) === key;
  });
  // All but the last are appended without the commit trigger, so the ticker
  // recommits ONCE against the fully retracted set — triggering per
  // retraction would let a mid-sequence commit see a half-retracted set and
  // transiently re-project a lot that's about to be voided.
  for (const match of matches.slice(0, -1)) {
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: match.id, reason: "Trade deleted in the pre-migration UI" } })
    );
  }
  const last = matches[matches.length - 1];
  if (last) await retractRawTransaction(repos, last.id, "Trade deleted in the pre-migration UI");
}

/**
 * Corrects a mistaken execution date on a Buy lot — the date twin of
 * renameTickerEverywhere: a trade's fields are otherwise immutable, but the
 * user is the ledger's source of truth, and a wrongly-OCR'd date (or an
 * opening-balance placeholder once the real invoice turns up) misplaces the
 * lot in the timeline and every date-bucketed analytic. Touches ONLY the
 * date: shares/price/fees/allocations are untouched, and the matching Buy
 * timeline event moves with it so the two never disagree. Refused when the
 * new date would land after a sell that already closed shares from this lot
 * — a lot can't be bought after part of it was sold.
 */
export async function correctTradeExecutionDate(repos: AppRepositories, tradeId: string, newDate: string): Promise<void> {
  assertWithinTrackingRange(newDate);
  const today = new Date().toISOString().slice(0, 10);
  if (newDate > today) {
    throw new Error(`Execution date can't be in the future: got ${newDate}`);
  }

  const trade = await repos.trades.getById(tradeId);
  if (!trade) {
    throw new Error(`Trade not found: ${tradeId}`);
  }

  const allocations = await repos.allocations.getByTrade(tradeId);
  const earliestSell = allocations.map((a) => a.executionDate).sort()[0];
  if (earliestSell !== undefined && newDate > earliestSell) {
    throw new Error(
      `This lot has a sell dated ${earliestSell} — its buy date can't be after shares from it were already sold.`
    );
  }

  await repos.trades.save({ ...trade, executionDate: newDate });

  const events = await repos.timeline.getByPortfolio(trade.portfolioId);
  const buyEvent = events.find((e) => e.type === "Buy" && e.relatedTradeIds?.includes(tradeId));
  if (buyEvent) {
    await repos.timeline.save({ ...buyEvent, timestamp: toTimestamp(newDate, trade.executionTime) });
  }
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
  repos: AppRepositories & Partial<CommitEngineRepos>,
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

  // Migration dual-write: also corrects every still-live RawTransaction
  // currently resolving to oldTicker (if this repos bundle is wired up for
  // the new architecture — see presentation/lib/data.ts). Without this, a
  // renamed ticker's raw transactions stay permanently orphaned under the
  // old ticker — immutable, and never matched by assignPortfolio again —
  // since RawTransaction has no update method to correct them in place.
  // Best-effort and isolated for the same reason as every other shadow
  // write in this migration.
  if (repos.rawTransactions && repos.committedLedger) {
    const commitRepos: CommitEngineRepos = { rawTransactions: repos.rawTransactions, committedLedger: repos.committedLedger };
    await renameRawTransactionsTicker(commitRepos, oldTicker, newTicker).catch((err) => {
      console.error("Raw transaction ticker correction failed (shadow write, non-fatal):", err);
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
  /** Broker-assigned unique execution ID for the sell order this allocates (e.g. Thndr's Invoice "Transaction No.") — applied to every resulting allocation row, same as sellGroupId. See TradeAllocation.transactionNumber. */
  transactionNumber?: string;
}

export interface RecordSellResult {
  realizedPnl: Money;
  allocations: TradeAllocation[];
}

export async function recordSell(repos: AppRepositories & Partial<CommitEngineRepos>, input: RecordSellInput): Promise<RecordSellResult> {
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
  const closedTrades: Trade[] = [];
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
      transactionNumber: input.transactionNumber,
    });
    await repos.allocations.save(allocation);
    createdAllocations.push(allocation);
    closedTrades.push(trade);
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

  if (repos.rawTransactions && repos.committedLedger) {
    await ensureSellFacts(repos as AppRepositories & CommitEngineRepos, input, ticker, sellGroupId, createdAllocations, closedTrades).catch(
      (err) => {
        console.error("ensureSellFacts failed (fact write, non-fatal):", err);
      }
    );
  }

  return { realizedPnl: microsToMoney(realizedMicros), allocations: createdAllocations };
}

/**
 * Phase 9.8 fact writer, Sell side: (1) the SellExecution fact — skipped
 * when an Import-written one with the same canonical key already exists —
 * and (2) the SellAllocationDecision fact, the immutable record of WHICH
 * lots the user chose to close (ADR-002). The decision is the half no
 * Import path ever writes, so it's checked and written independently of the
 * execution fact; `sellExecutionId`/`lotRef` use canonical keys, exactly the
 * eventIds generateLedgerEvents derives for these same facts (the identical
 * convention backfillRawTransactions established), so the Allocation Engine
 * replays this decision correctly on every future rebuild.
 */
async function ensureSellFacts(
  repos: CommitEngineRepos & Partial<AppRepositories>,
  input: RecordSellInput,
  ticker: string,
  sellGroupId: string,
  createdAllocations: TradeAllocation[],
  closedTrades: Trade[]
): Promise<void> {
  const totalShares = createdAllocations.reduce((sum, a) => sum + a.sharesClosed, 0);
  const price = createdAllocations[0].exitPrice;
  const sellKey = canonicalKey({ side: "SELL", ticker, date: input.executionDate, shares: totalShares, price });
  const all = await repos.rawTransactions.getAll();
  const isLive = (id: string) => !isRetracted(all, id);

  const liveSellMatch = all.find((t) => {
    if (t.kind !== "SellExecution" || t.ticker === undefined || normalizeTicker(t.ticker) !== ticker) return false;
    if (!isLive(t.id)) return false;
    const p = t.payload as SellExecutionPayload;
    return canonicalKey({ side: "SELL", ticker, date: p.executionDate, shares: p.shares, price: p.price }) === sellKey;
  });
  if (!liveSellMatch) {
    const payload: SellExecutionPayload = {
      ticker,
      shares: totalShares,
      price,
      fees: createdAllocations.reduce((sum, a) => sum + a.fees, 0),
      taxes: createdAllocations.reduce((sum, a) => sum + a.taxes, 0),
      executionDate: input.executionDate,
      executionTime: input.executionTime,
      transactionNumber: input.transactionNumber,
      notes: createdAllocations[0].notes,
      exitReason: createdAllocations[0].exitReason,
    };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ id: sellGroupId, kind: "SellExecution", source: "manual", portfolioId: input.portfolioId, ticker, payload })
    );
  }

  const liveDecisionExists = all.some(
    (t) => t.kind === "SellAllocationDecision" && isLive(t.id) && (t.payload as SellAllocationDecisionPayload).sellExecutionId === sellKey
  );
  if (!liveDecisionExists) {
    const payload: SellAllocationDecisionPayload = {
      sellExecutionId: sellKey,
      allocations: createdAllocations.map((a, i) => ({
        lotRef: canonicalKey({
          side: "BUY",
          ticker: normalizeTicker(closedTrades[i].ticker),
          date: closedTrades[i].executionDate,
          shares: closedTrades[i].shares,
          price: closedTrades[i].entryPrice,
        }),
        shares: a.sharesClosed,
      })),
    };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({
        id: `${sellGroupId}|decision`,
        kind: "SellAllocationDecision",
        source: "manual",
        portfolioId: input.portfolioId,
        ticker,
        payload,
      })
    );
  }

  await assignPortfolio(repos, ticker, input.portfolioId);
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

export interface MisnamedTickerEntry {
  /** The raw company-name string a ticker group ended up filed under, e.g. "MEDINET MASR HOUSING". */
  wrongTicker: string;
  /** The real EGX symbol it should be, e.g. "MASR". */
  realTicker: string;
  shares: number;
}

/**
 * A ticker string that's actually a company name (see
 * tickerForCompanyNameFallback) means some trades were committed back when
 * that company wasn't yet in KNOWN_EGX_TICKERS, so OCR ticker resolution fell
 * back to filing the whole group under the raw name instead of the real
 * symbol — the same split Import's own one-click rename fixes for a still-
 * pending batch (see knownTickers.ts's own doc comment), except these rows
 * are already fully committed and long since cleared from any Import
 * session, so that pending-pool-only fix can never reach them again. This
 * surfaces every such already-recorded ticker globally (not scoped to one
 * portfolio — the real symbol may already have its own trades elsewhere)
 * so it can be pointed at renameTickerEverywhere.
 */
export function findMisnamedTickers(trades: Trade[]): MisnamedTickerEntry[] {
  const sharesByTicker = new Map<string, number>();
  for (const t of trades) {
    const ticker = normalizeTicker(t.ticker);
    sharesByTicker.set(ticker, (sharesByTicker.get(ticker) ?? 0) + t.remainingShares);
  }

  const result: MisnamedTickerEntry[] = [];
  for (const [wrongTicker, shares] of sharesByTicker) {
    const realTicker = tickerForCompanyNameFallback(wrongTicker);
    if (realTicker && normalizeTicker(realTicker) !== wrongTicker) {
      result.push({ wrongTicker, realTicker: normalizeTicker(realTicker), shares });
    }
  }
  return result.sort((a, b) => a.wrongTicker.localeCompare(b.wrongTicker));
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

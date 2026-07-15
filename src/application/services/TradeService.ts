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
import type { DiagnosticsRecorder } from "@domain/repositories";
import {
  retractRawTransaction,
  renameRawTransactionsTicker,
  assignPortfolioToFact,
  appendAndMaybeCommit,
  type CommitEngineRepos,
} from "./commitEngine";
import { canonicalKey } from "./ledgerRebuild";
import { resolveLotRef } from "./ledgerProjection";
import { isRetracted, resolveCurrentTicker, findUnclaimedSellExecutionFact } from "./rawTransactionFolds";
import { timesConflict } from "./duplicateDetection";
import {
  createRawTransaction,
  type RawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
  type RawTransactionSource,
} from "@domain/entities/RawTransaction";

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
  /** Evidence source when restoring a buy from a parsed broker document. Omitted for a genuinely manual entry. */
  source?: RawTransactionSource;
  /** Import-only performance hint: append/assign the fact now and let the caller commit the ticker once after the batch. */
  deferCommit?: boolean;
}

export interface RecordBuyResult {
  trade: Trade;
}

/**
 * High-throughput import writer. The normal recordBuy path is intentionally
 * simple for interactive edits, but it performs several reads and writes per
 * lot. Repeating that path for a large broker workbook makes the work O(n²)
 * and keeps React/Dexie busy for the whole click. Import confirmation uses
 * this method instead: read the current snapshot once, build the complete
 * write set in memory, then bulk-write the trades, timeline events, and raw
 * facts in one transaction supplied by ImportPage.
 */
export async function recordBuyBatch(
  repos: AppRepositories & Partial<CommitEngineRepos>,
  inputs: RecordBuyInput[],
  diagnostics?: DiagnosticsRecorder,
): Promise<RecordBuyResult[]> {
  if (inputs.length === 0) return [];

  const portfolioIds = [...new Set(inputs.map((input) => input.portfolioId))];
  const portfolios = new Map<string, Awaited<ReturnType<typeof repos.portfolios.getById>>>();
  const tradesByPortfolio = new Map<string, Trade[]>();
  for (const portfolioId of portfolioIds) {
    const portfolio = await repos.portfolios.getById(portfolioId);
    if (!portfolio) throw new Error(`Portfolio not found: ${portfolioId}`);
    portfolios.set(portfolioId, portfolio);
    const portfolioTrades = repos.trades.getByPortfolio
      ? await repos.trades.getByPortfolio(portfolioId)
      : (await repos.trades.getAll()).filter((trade) => trade.portfolioId === portfolioId);
    tradesByPortfolio.set(portfolioId, portfolioTrades);
  }

  const rawRepos = repos.rawTransactions && repos.committedLedger ? (repos as AppRepositories & CommitEngineRepos) : undefined;
  const allFacts = rawRepos ? await rawRepos.rawTransactions.getAll() : [];
  const factsToAppend: Omit<RawTransaction, "seq">[] = [];
  const tradesToWrite: Trade[] = [];
  const timelineToWrite = [] as Awaited<ReturnType<typeof createTimelineEvent>>[];
  const results: RecordBuyResult[] = [];
  const factSeqByTradeId = new Map<string, number | undefined>();

  for (const input of inputs) {
    assertWithinTrackingRange(input.executionDate);
    const normalizedTicker = normalizeTicker(input.ticker);
    const portfolio = portfolios.get(input.portfolioId)!;
    const fees = input.fees ?? 0;
    const taxes = input.taxes ?? 0;
    const totalCost = Money.from(input.shares * input.entryPrice).add(Money.from(fees)).add(Money.from(taxes));
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
    tradesToWrite.push(trade);
    tradesByPortfolio.get(input.portfolioId)!.push(trade);
    portfolios.set(input.portfolioId, { ...portfolio, cash: Money.from(portfolio.cash).subtract(totalCost).toNumber() });

    timelineToWrite.push(
      createTimelineEvent({
        id: generateId(),
        portfolioId: input.portfolioId,
        type: "Buy",
        timestamp: toTimestamp(input.executionDate, input.executionTime),
        ticker: normalizedTicker,
        relatedTradeIds: [trade.id],
        amount: -totalCost.toNumber(),
        shares: input.shares,
        notes: input.notes,
      }),
    );

    if (!rawRepos) {
      results.push({ trade });
      continue;
    }

    const existingTradeIds = new Set((tradesByPortfolio.get(input.portfolioId) ?? []).filter((candidate) => candidate.id !== trade.id).map((candidate) => candidate.id));
    const key = canonicalKey({ side: "BUY", ticker: normalizedTicker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
    const sameValueCandidates = allFacts.filter((fact) => {
      if (fact.kind !== "BuyExecution" || isRetracted(allFacts, fact.id)) return false;
      if (existingTradeIds.has(fact.id)) return false;
      const resolvedTicker = resolveCurrentTicker(allFacts, fact);
      if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== normalizedTicker) return false;
      const payload = fact.payload as BuyExecutionPayload;
      return canonicalKey({ side: "BUY", ticker: normalizedTicker, date: payload.executionDate, shares: payload.shares, price: payload.price }) === key;
    });
    const liveMatch =
      sameValueCandidates.length > 1
        ? (sameValueCandidates.find((fact) => !timesConflict(trade.executionTime, (fact.payload as BuyExecutionPayload).executionTime)) ?? sameValueCandidates[0])
        : sameValueCandidates[0];

    if (!liveMatch) {
      const fact = createRawTransaction({
        id: trade.id,
        kind: "BuyExecution",
        source: input.source ?? "manual",
        portfolioId: trade.portfolioId,
        ticker: normalizedTicker,
        payload: {
          ticker: normalizedTicker,
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
          sector: input.sector,
        },
      });
      factsToAppend.push(fact);
      allFacts.push({ ...fact, seq: 0 });
      factSeqByTradeId.set(trade.id, undefined);
    } else {
      factSeqByTradeId.set(trade.id, liveMatch.seq);
      // A pre-existing extraction fact is intentionally left unassigned here.
      // ImportPage's single trailing assignPortfolio sweep assigns all such
      // facts together after the bulk write; doing it in both places creates
      // duplicate PortfolioAssignment envelopes in lightweight adapters and
      // needlessly adds another append to the hot path.
    }
    results.push({ trade });
  }

  if (repos.trades.saveMany) await repos.trades.saveMany(tradesToWrite);
  else for (const trade of tradesToWrite) await repos.trades.save(trade);

  for (const portfolio of portfolios.values()) await repos.portfolios.save(portfolio!);

  if (repos.timeline.saveMany) await repos.timeline.saveMany(timelineToWrite);
  else for (const event of timelineToWrite) await repos.timeline.save(event);

  if (rawRepos && factsToAppend.length > 0) {
    const appended = rawRepos.rawTransactions.appendMany
      ? await rawRepos.rawTransactions.appendMany(factsToAppend)
      : await Promise.all(factsToAppend.map((fact) => rawRepos.rawTransactions.append(fact)));
    for (const fact of appended) {
      if (fact.kind === "BuyExecution") factSeqByTradeId.set(fact.id, fact.seq);
      diagnostics?.recordWrite({
        writer: "TradeService.ts",
        function: "recordBuyBatch",
        file: "src/application/services/TradeService.ts",
        table: "rawTransactions",
        objectId: fact.id,
        valueSource: "reference",
        factSeqCursor: fact.seq,
        reason: `Wrote a ${fact.kind} fact while confirming an import batch`,
        portfolioId: fact.portfolioId,
        ticker: fact.ticker,
      });
    }
  }

  for (const result of results) {
    const factSeqCursor = factSeqByTradeId.get(result.trade.id);
    diagnostics?.recordWrite({
      writer: "TradeService.ts",
      function: "recordBuyBatch",
      file: "src/application/services/TradeService.ts",
      table: "trades",
      objectId: result.trade.id,
      valueSource: factSeqCursor === undefined ? "reference" : "replayCursor",
      factSeqCursor,
      reason: "Recorded a Buy lot from an import batch",
      portfolioId: result.trade.portfolioId,
      ticker: result.trade.ticker,
    });
  }
  return results;
}

/**
 * Phase 9.8 fact writer: every recorded Buy now also lands in the immutable
 * RawTransaction log (when the repos bundle carries it — the app's real
 * singleton always does), so a manual Record Buy is no longer invisible to
 * the canonical rebuild. Guarded by canonical-key lookup: an Import-flow Buy
 * whose fact was already written at extraction time (importRecording.ts)
 * appends nothing — it only gets its portfolio assignment confirmed. Same
 * non-fatal isolation as every dual-write in this migration.
 *
 * The lookup only ever adopts a fact no OTHER existing Trade already owns
 * (`otherTradeIds`) — two genuinely distinct trades (e.g. two same-price
 * same-day buys) can share an identical canonical key, and blindly adopting
 * whichever fact matches by value would silently leave the second trade
 * with no fact of its own, orphaning it from the next commit's projection
 * (see the regression tests this guards: "a second buy sharing another's
 * exact value never adopts its fact").
 *
 * Returns the seq of the fact this trade now resolves to (freshly written or
 * adopted) — reused by `recordBuy` as its Writer Trace `factSeqCursor`
 * (docs/DIAGNOSTICS_CENTER_SPEC.md Part 2.3 §A) without an extra
 * `rawTransactions` read: an earlier draft of this instrumentation added a
 * fresh `getAll()` query for exactly this purpose, and that extra await
 * point measurably shifted async interleaving in this codebase's own
 * documented race-condition regression tests (ImportPage's ORWE/ABUK/ADPC
 * suites) — a stark, concrete reminder that Part 0's "never modifies
 * business logic" has to include timing, not just data.
 */
async function ensureBuyFact(
  repos: CommitEngineRepos & Partial<AppRepositories>,
  trade: Trade,
  input: RecordBuyInput,
  diagnostics?: DiagnosticsRecorder
): Promise<number | undefined> {
  const ticker = normalizeTicker(trade.ticker);
  const key = canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
  const all = await repos.rawTransactions.getAll();
  const otherTradeIds = new Set(
    (await repos.trades!.getByPortfolio(trade.portfolioId)).filter((t) => t.id !== trade.id).map((t) => t.id)
  );
  const sameValueCandidates = all.filter((t) => {
    if (t.kind !== "BuyExecution") return false;
    if (isRetracted(all, t.id)) return false;
    // Resolved through any live Correction (see rawTransactionFolds.ts's
    // resolveCurrentTicker doc comment) — reading t.ticker directly here
    // caused the same "stops recognizing a renamed fact" bug already fixed
    // in isTickerFullyOfficialBrokerExcelSourced and findUnclaimedSellExecutionFact.
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== ticker) return false;
    if (otherTradeIds.has(t.id)) return false;
    const p = t.payload as BuyExecutionPayload;
    return canonicalKey({ side: "BUY", ticker, date: p.executionDate, shares: p.shares, price: p.price }) === key;
  });
  // canonicalKey is time-blind (ticker/side/date/shares/price only) — two
  // genuinely distinct real Buys sharing every other field (e.g. two same-
  // price limit fills minutes apart) both land in sameValueCandidates. Prefer
  // whichever one's own executionTime actually agrees with this trade's, so
  // this trade adopts ITS OWN real fact rather than an arbitrary sibling's
  // (a real, reproduced bug: cross-linking two such facts spawned a phantom
  // extra Trade and left the other's row wrongly flagged "Duplicate" in
  // Import — see this module's own regression test). Falls back to the
  // first candidate, unchanged from the prior behavior, when time can't
  // disambiguate (only one candidate, or none has a matching time).
  const liveMatch =
    sameValueCandidates.length > 1
      ? (sameValueCandidates.find((t) => !timesConflict(trade.executionTime, (t.payload as BuyExecutionPayload).executionTime)) ?? sameValueCandidates[0])
      : sameValueCandidates[0];

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
    const appended = await appendAndMaybeCommit(
      repos,
      createRawTransaction({ id: trade.id, kind: "BuyExecution", source: input.source ?? "manual", portfolioId: trade.portfolioId, ticker, payload }),
      diagnostics,
      { writer: "TradeService.ts", function: "ensureBuyFact", file: "src/application/services/TradeService.ts", reason: "Wrote the BuyExecution fact backing a manually-recorded Buy" },
      input.deferCommit ? { deferCommit: true } : undefined,
    );
    return appended.seq;
  } else {
    await assignPortfolioToFact(repos, liveMatch.id, trade.portfolioId, diagnostics, input.deferCommit ? { deferCommit: true } : undefined);
    return liveMatch.seq;
  }
}

export async function recordBuy(
  repos: AppRepositories & Partial<CommitEngineRepos>,
  input: RecordBuyInput,
  diagnostics?: DiagnosticsRecorder
): Promise<RecordBuyResult> {
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
  const trade: Trade = createTrade({
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

  let factSeqCursor: number | undefined;
  if (repos.rawTransactions && repos.committedLedger) {
    factSeqCursor = await ensureBuyFact(repos as AppRepositories & CommitEngineRepos, trade, input, diagnostics).catch((err) => {
      console.error("ensureBuyFact failed (fact write, non-fatal):", err);
      return undefined;
    });
  }

  if (diagnostics && factSeqCursor !== undefined) {
    diagnostics.recordWrite({
      writer: "TradeService.ts",
      function: "recordBuy",
      file: "src/application/services/TradeService.ts",
      table: "trades",
      objectId: trade.id,
      valueSource: "replayCursor",
      factSeqCursor,
      reason: "Recorded a new Buy lot",
      portfolioId: input.portfolioId,
      ticker: trade.ticker,
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
 *
 * canonicalKey alone is deliberately time-blind, so this ALSO requires the
 * candidate fact's own executionTime to not conflict with the trade being
 * deleted's (the same discriminator ensureBuyFact's own sameValueCandidates
 * tie-break already uses). Without it, deleting ONE of two legitimate same-
 * value/different-time trades (e.g. two 49-share ABUK buys two minutes
 * apart) would retract BOTH of their real facts — permanently destroying the
 * SURVIVING sibling trade's own official-broker-excel provenance even though
 * that trade was never touched, silently degrading it to whatever
 * ensureLegacyFactsExist's gap-backfill reconstructs next (source
 * "backfill") on the next commit.
 */
async function retractMatchingRawTransaction(repos: CommitEngineRepos, trade: Trade): Promise<void> {
  const ticker = normalizeTicker(trade.ticker);
  const key = canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
  const all = await repos.rawTransactions.getAll();
  const matches = all.filter((t) => {
    if (t.kind !== "BuyExecution" || t.ticker === undefined || normalizeTicker(t.ticker) !== ticker) return false;
    if (isRetracted(all, t.id)) return false;
    const payload = t.payload as BuyExecutionPayload;
    if (timesConflict(trade.executionTime, payload.executionTime)) return false;
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
  /**
   * Which document type this sell was actually read from (see
   * ParsedTradeCandidate.source) — threaded through from the parsed
   * candidate so the SellExecution fact ensureSellFacts writes reflects the
   * real originating document instead of defaulting to "manual" for every
   * sell, regardless of source. Undefined only for a genuinely
   * user-typed sell with no document behind it (e.g. the Lot Manager's own
   * manual entry), where "manual" is the correct, real answer.
   */
  source?: RawTransactionSource;
}

export interface RecordSellResult {
  realizedPnl: Money;
  allocations: TradeAllocation[];
}

export async function recordSell(
  repos: AppRepositories & Partial<CommitEngineRepos>,
  input: RecordSellInput,
  diagnostics?: DiagnosticsRecorder
): Promise<RecordSellResult> {
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

    const allocation: TradeAllocation = createTradeAllocation({
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

  let factSeqCursor: number | undefined;
  if (repos.rawTransactions && repos.committedLedger) {
    factSeqCursor = await ensureSellFacts(
      repos as AppRepositories & CommitEngineRepos,
      input,
      ticker,
      sellGroupId,
      createdAllocations,
      closedTrades,
      diagnostics
    ).catch((err) => {
      console.error("ensureSellFacts failed (fact write, non-fatal):", err);
      return undefined;
    });
  }

  if (diagnostics && factSeqCursor !== undefined) {
    for (const allocation of createdAllocations) {
      diagnostics.recordWrite({
        writer: "TradeService.ts",
        function: "recordSell",
        file: "src/application/services/TradeService.ts",
        table: "tradeAllocations",
        objectId: allocation.id,
        valueSource: "replayCursor",
        factSeqCursor,
        reason: "Recorded a new sell allocation closing a lot",
        portfolioId: input.portfolioId,
        ticker,
      });
    }
    for (const trade of closedTrades) {
      diagnostics.recordWrite({
        writer: "TradeService.ts",
        function: "recordSell",
        file: "src/application/services/TradeService.ts",
        table: "trades",
        objectId: trade.id,
        valueSource: "replayCursor",
        factSeqCursor,
        reason: "Updated remaining shares after a sell allocation",
        portfolioId: input.portfolioId,
        ticker,
      });
    }
  }

  return { realizedPnl: microsToMoney(realizedMicros), allocations: createdAllocations };
}

/**
 * Phase 9.8 fact writer, Sell side: (1) the SellExecution fact and (2) the
 * SellAllocationDecision fact, the immutable record of WHICH lots the user
 * chose to close (ADR-002).
 *
 * The SellExecution fact is ADOPTED, not always freshly written: this ticker
 * may already have a live SellExecution fact for this exact sell (ticker/
 * date/shares/price) sitting in the log — the one `recordImportedRawTransactions`
 * wrote at extraction time, correctly sourced from the real originating
 * document (e.g. "official-broker-excel"). `findUnclaimedSellExecutionFact`
 * (rawTransactionFolds.ts) finds it, and this function reuses its id instead
 * of minting a new fact that would otherwise have to guess or hardcode a
 * source — this is the single, universal fix for a whole class of bug: a
 * ticker whose ENTIRE history should be traceable to one document silently
 * lost that provenance the moment ANY sell got allocated, regardless of
 * which specific ticker or how the ticker's Buy side was recorded (see
 * reconciliation.ts's isTickerFullyOfficialBrokerExcelSourced, and the
 * "needs corroborating evidence" regression this fixes for every affected
 * ticker at once, not one at a time).
 *
 * Only when NO unclaimed match exists does this write a genuinely fresh
 * fact, using `input.source` when the caller provided one (a fallback layer,
 * for the rare case the extraction-time write itself failed) or "manual"
 * (a genuinely user-typed sell with no candidate behind it at all).
 *
 * An EARLIER version of this exact idea (match by value, adopt if found)
 * caused a real regression: it had no notion of a fact already being
 * "claimed" by a previous sell, so two genuinely different sells sharing the
 * same value (same-price same-day orders are routine) silently merged onto
 * the SAME fact, orphaning the second sell's allocations. `sellExecutionId`
 * in the SellAllocationDecision below is what makes a fact "claimed" —
 * findUnclaimedSellExecutionFact excludes any fact a live decision already
 * points at, so a second same-value sell correctly falls through to minting
 * its own fact instead of reusing (and silently merging into) the first
 * sell's. See this module's regression tests ("a second sell sharing
 * another's exact value never merges with it").
 *
 * `lotRef` still references the real RawTransaction ids (via `resolveLotRef`
 * for each closed lot) instead of a recomputed canonical key — real ids are
 * always unique, so two coincidentally-identical lots can never be
 * conflated by the Allocation Engine, which resolves a reference by real id
 * first (see allocationEngine.indexEventsByReference) and only falls back to
 * the value-keyed identity for decisions written before this fix.
 */
/**
 * Returns the SellAllocationDecision fact's own seq — the last (and
 * therefore highest-seq) fact this function writes, reused by `recordSell`
 * as its Writer Trace `factSeqCursor` without an extra `rawTransactions`
 * read (same reasoning as `ensureBuyFact`'s own doc comment above).
 */
async function ensureSellFacts(
  repos: CommitEngineRepos & Partial<AppRepositories>,
  input: RecordSellInput,
  ticker: string,
  sellGroupId: string,
  createdAllocations: TradeAllocation[],
  closedTrades: Trade[],
  diagnostics?: DiagnosticsRecorder
): Promise<number | undefined> {
  const totalShares = createdAllocations.reduce((sum, a) => sum + a.sharesClosed, 0);
  const price = createdAllocations[0].exitPrice;

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

  const all = await repos.rawTransactions.getAll();
  const existingFact = findUnclaimedSellExecutionFact(all, {
    ticker,
    executionDate: input.executionDate,
    shares: totalShares,
    price,
    executionTime: input.executionTime,
  });
  const sellExecutionId = existingFact?.id ?? sellGroupId;
  if (!existingFact) {
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ id: sellGroupId, kind: "SellExecution", source: input.source ?? "manual", portfolioId: input.portfolioId, ticker, payload }),
      diagnostics,
      { writer: "TradeService.ts", function: "ensureSellFacts", file: "src/application/services/TradeService.ts", reason: "Wrote the SellExecution fact backing a manually-recorded Sell" }
    );
  }

  const decisionPayload: SellAllocationDecisionPayload = {
    sellExecutionId,
    allocations: createdAllocations.map((a, i) => ({
      lotRef: resolveLotRef(all, closedTrades[i]),
      shares: a.sharesClosed,
    })),
  };
  const decisionFact = await appendAndMaybeCommit(
    repos,
    createRawTransaction({
      id: `${sellGroupId}|decision`,
      kind: "SellAllocationDecision",
      source: "manual",
      portfolioId: input.portfolioId,
      ticker,
      payload: decisionPayload,
    }),
    diagnostics,
    { writer: "TradeService.ts", function: "ensureSellFacts", file: "src/application/services/TradeService.ts", reason: "Wrote the SellAllocationDecision fact recording which lots were closed" }
  );

  await assignPortfolioToFact(repos, sellExecutionId, input.portfolioId, diagnostics);
  return decisionFact.seq;
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

import { normalizeTicker } from "@domain/value-objects/Ticker";
import { generateId } from "@domain/value-objects/id";
import { Money } from "@domain/value-objects/Money";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import {
  createRawTransaction,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import type { AppRepositories } from "./types";
import { relevantTradeTransactions, retractRawTransaction, type CommitEngineRepos } from "./commitEngine";
import { generateLedgerEvents } from "./ledgerEngine";
import { generateAllocations } from "./allocationEngine";
import { ensureLegacyFactsExist, projectLegacyTicker, type LegacyLedgerRepos } from "./ledgerProjection";
import { isRetracted } from "./rawTransactionFolds";

/**
 * Lot Manager: the ticker-scoped Buy Lots / Sell Transactions / Allocation
 * Events workspace that replaces the old all-in-one Sell Allocation popup.
 *
 * Architecture (per docs/ROADMAP.md's Lot Manager sprint — see also
 * allocationEngine.ts's own doc comment): Allocation Events
 * (SellAllocationDecision facts) are the ONLY source of truth for which
 * shares of which Buy lot a Sell closes. This module never mutates a Buy or
 * Sell RawTransaction, and never writes a "remaining shares" number anywhere
 * — every read here recomputes it fresh from Buy quantity minus the sum of
 * live Allocation Events, by replaying generateLedgerEvents/
 * generateAllocations (the same pure, deterministic engines the canonical
 * ledger's commit pipeline uses) directly over the ticker's RawTransactions.
 *
 * Deliberately reads ALL live facts for the ticker, not just ones that have
 * reached a "Verified" import-corroboration verdict (see
 * commitEngine.shouldCommit) — a Lot Manager action is the user's own
 * direct, deliberate statement about their own trades, not an OCR read
 * awaiting corroboration, so gating it behind that verdict would leave a
 * purely-manual user (no broker screenshots ever imported) looking at a
 * permanently empty Lot Manager. Every write here still keeps the legacy
 * Trade/TradeAllocation tables (and the committedLedger cache) in sync
 * unconditionally afterward, so every other page reads the same numbers
 * immediately — see `syncTicker`.
 */

export type LotManagerRepos = AppRepositories & CommitEngineRepos;

export type BuyLotStatus = "open" | "partial" | "closed";
export type SellStatus = "pending" | "partial" | "completed";

export interface BuyLot {
  /** The BuyExecution RawTransaction's own id — always unique, never a value hash. */
  id: string;
  ticker: string;
  executionDate: string;
  executionTime?: string;
  shares: number;
  entryPrice: number;
  fees: number;
  taxes: number;
  costBasis: number;
  allocatedShares: number;
  remainingShares: number;
  status: BuyLotStatus;
  closedBy: LotClosingLine[];
}

export interface AllocationLine {
  buyLotId: string;
  buyLotExecutionDate: string;
  shares: number;
}

/** A Buy lot's own per-sell breakdown — the mirror of AllocationLine, read from the other side. */
export interface LotClosingLine {
  sellId: string;
  sellExecutionDate: string;
  shares: number;
}

export interface Sell {
  /** The SellExecution RawTransaction's own id. */
  id: string;
  ticker: string;
  executionDate: string;
  executionTime?: string;
  shares: number;
  price: number;
  fees: number;
  taxes: number;
  exitReason?: string;
  notes?: string;
  allocations: AllocationLine[];
  allocatedShares: number;
  remainingShares: number;
  status: SellStatus;
}

export interface TimelineEntry {
  id: string;
  type: "BUY" | "SELL";
  executionDate: string;
  executionTime?: string;
  shares: number;
  price: number;
  /** Every Allocation Event id touching this Buy/Sell — selecting this entry in the UI highlights all of them. */
  relatedAllocationIds: string[];
}

export interface ValidationIssue {
  code:
    | "over-allocation"
    | "negative-remaining"
    | "duplicate-allocation"
    | "missing-allocation"
    | "inventory-mismatch"
    | "chronological-violation";
  message: string;
  sellId?: string;
  buyLotId?: string;
}

export interface LotManagerSnapshot {
  ticker: string;
  buyLots: BuyLot[]; // oldest -> newest
  sells: Sell[]; // oldest -> newest
  currentPosition: {
    boughtShares: number;
    availableShares: number;
    allocatedShares: number;
    pendingAllocationShares: number;
  };
  timeline: TimelineEntry[];
  issues: ValidationIssue[];
}

/**
 * Rebuilds the ticker's Ledger + Allocation Events fresh from its live
 * RawTransactions — "delete all projections, rebuild everything," exactly
 * as the Lot Manager's rebuild contract requires (see this module's doc
 * comment and REBUILD in the spec this implements). Never reads a cache.
 */
async function computeLedger(repos: LotManagerRepos, portfolioId: string, ticker: string) {
  const normalized = normalizeTicker(ticker);
  const relevant = await relevantTradeTransactions(repos, portfolioId, normalized);
  const tradeTxns = relevant.filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution");
  const decisionTxns = relevant.filter((t) => t.kind === "SellAllocationDecision");
  const events = generateLedgerEvents(tradeTxns);
  const allocations = generateAllocations(events, decisionTxns);
  return { events, allocations };
}

/**
 * Keeps every other page's read path (committedLedger cache, legacy
 * Trade/TradeAllocation tables) in sync with the RawTransaction truth right
 * after a Lot Manager write — unconditionally, not gated by import
 * verification, since a Lot Manager action already IS the user's own
 * confirmed decision. Mirrors commitEngine.commitTicker's own two-step
 * sequence (gap-backfill, then commit cache + project legacy) without its
 * verdict gate.
 */
async function syncTicker(repos: LotManagerRepos, portfolioId: string, ticker: string): Promise<{ events: Awaited<ReturnType<typeof computeLedger>>["events"]; allocations: Awaited<ReturnType<typeof computeLedger>>["allocations"] }> {
  const normalized = normalizeTicker(ticker);
  await ensureLegacyFactsExist(repos as LegacyLedgerRepos, portfolioId, normalized);
  const { events, allocations } = await computeLedger(repos, portfolioId, normalized);
  await repos.committedLedger.commitTicker({ portfolioId, ticker: normalized, events, allocations });
  await projectLegacyTicker(repos as LegacyLedgerRepos, portfolioId, normalized, events, allocations);
  return { events, allocations };
}

export interface RecordSellTransactionInput {
  portfolioId: string;
  ticker: string;
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime?: string;
  notes?: string;
  exitReason?: string;
  transactionNumber?: string;
}

/**
 * Records a Sell EXECUTION only — no allocation. Cash is realized
 * immediately (the market doesn't care which lot accounting later
 * attributes it to); which Buy lot(s) it closes is a separate decision made
 * afterward via `setSellAllocation`/Auto Allocate. The sell starts life
 * "Pending" and stays visible (and sellable-from) until allocated.
 */
export async function recordSellTransaction(repos: LotManagerRepos, input: RecordSellTransactionInput): Promise<{ sellId: string }> {
  if (input.shares <= 0) throw new Error("Sell shares must be positive");
  if (input.price <= 0) throw new Error("Sell price must be positive");
  const ticker = normalizeTicker(input.ticker);
  const fees = input.fees ?? 0;
  const taxes = input.taxes ?? 0;

  const portfolio = await repos.portfolios.getById(input.portfolioId);
  if (!portfolio) throw new Error(`Portfolio not found: ${input.portfolioId}`);
  const netProceeds = Money.from(input.shares * input.price).subtract(Money.from(fees)).subtract(Money.from(taxes));
  await repos.portfolios.save({ ...portfolio, cash: Money.from(portfolio.cash).add(netProceeds).toNumber() });

  const payload: SellExecutionPayload = {
    ticker,
    shares: input.shares,
    price: input.price,
    fees,
    taxes,
    executionDate: input.executionDate,
    executionTime: input.executionTime,
    transactionNumber: input.transactionNumber,
    notes: input.notes,
    exitReason: input.exitReason,
  };
  const sellId = generateId();
  await repos.rawTransactions.append(
    createRawTransaction({ id: sellId, kind: "SellExecution", source: "manual", portfolioId: input.portfolioId, ticker, payload })
  );

  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId: input.portfolioId,
      type: "PartialSell",
      timestamp: `${input.executionDate}T${input.executionTime ?? "00:00"}`,
      ticker,
      amount: netProceeds.toNumber(),
      shares: input.shares,
      notes: input.exitReason ?? input.notes,
    })
  );

  await syncTicker(repos, input.portfolioId, ticker);
  return { sellId };
}

/** Buy lots dated after the sell can never be selected — displayed, never allocatable, per the Lot Manager's temporal-validation rule. */
export function isTemporallyValid(buyLot: Pick<BuyLot, "executionDate">, sell: Pick<Sell, "executionDate">): boolean {
  return buyLot.executionDate <= sell.executionDate;
}

export interface SetSellAllocationLine {
  buyLotId: string;
  shares: number;
}

/**
 * Replaces this Sell's ENTIRE allocation with the given lines — "View /
 * Edit / Continue" in the Manage Allocation modal all funnel through here
 * with the full desired final set (Continue = existing lines the user kept
 * + new ones; Edit = whatever the user changed to); `resetSellAllocation`
 * is the dedicated empty-set case. Retracts the sell's previous
 * SellAllocationDecision (if any) and appends a fresh one — Allocation
 * Events stay append-only/immutable; nothing is ever edited in place.
 *
 * Rejects (never silently clamps) any line that: overshoots the sell's own
 * share count, overshoots a lot's current remaining balance, references a
 * lot dated AFTER this sell (temporal violation — rejected even if the
 * caller is a programmatic FIFO confirm, not just manual entry), or
 * duplicates a lot within the same call.
 */
export async function setSellAllocation(repos: LotManagerRepos, portfolioId: string, ticker: string, sellId: string, lines: SetSellAllocationLine[]): Promise<void> {
  const normalized = normalizeTicker(ticker);
  const snapshot = await getLotManagerSnapshot(repos, portfolioId, normalized);
  const sell = snapshot.sells.find((s) => s.id === sellId);
  if (!sell) throw new Error(`Sell not found: ${sellId}`);

  const seenLots = new Set<string>();
  let totalRequested = 0;
  for (const line of lines) {
    if (line.shares <= 0) throw new Error("Allocation shares must be positive");
    if (seenLots.has(line.buyLotId)) throw new Error(`Duplicate allocation for the same Buy lot: ${line.buyLotId}`);
    seenLots.add(line.buyLotId);

    const lot = snapshot.buyLots.find((l) => l.id === line.buyLotId);
    if (!lot) throw new Error(`Buy lot not found: ${line.buyLotId}`);
    if (!isTemporallyValid(lot, sell)) {
      throw new Error(
        `This Buy transaction occurred after the selected Sell transaction and cannot be allocated.`
      );
    }
    // The lot's OWN current remaining balance already excludes whatever this
    // very sell previously had allocated to it (this is a REPLACE, not an
    // add), since `getLotManagerSnapshot` derives remaining from every live
    // decision including this sell's old one, which is still live until the
    // retraction below lands.
    const alreadyFromThisSell = sell.allocations.find((a) => a.buyLotId === line.buyLotId)?.shares ?? 0;
    if (line.shares > lot.remainingShares + alreadyFromThisSell) {
      throw new Error(`Cannot allocate ${line.shares} shares of a lot with only ${lot.remainingShares + alreadyFromThisSell} available.`);
    }
    totalRequested += line.shares;
  }
  if (totalRequested > sell.shares) {
    throw new Error(`Cannot allocate ${totalRequested} shares — this sell only closed ${sell.shares}.`);
  }

  // Clears this sell's legacy TradeAllocation rows FIRST, before either the
  // retraction below or syncTicker triggers any commit — retractRawTransaction
  // itself immediately runs a commit (see commitEngine.appendAndMaybeCommit's
  // Retraction branch), and ensureLegacyFactsExist's gap-backfill runs on
  // EVERY commit: if a legacy allocation row for this sell still existed at
  // that moment with no live decision behind it, it would read as a "gap"
  // (a legacy fact predating its RawTransaction) and resurrect the very
  // decision this call is retracting. Only this sell's own rows — every
  // other sell's allocations, and every Buy lot not involved in this one,
  // are untouched.
  const staleLegacyAllocations = (await repos.allocations.getByPortfolio(portfolioId)).filter((a) => a.sellGroupId === sellId);
  for (const stale of staleLegacyAllocations) {
    await repos.allocations.delete(stale.id);
  }

  const all = await repos.rawTransactions.getAll();
  const liveDecision = all.find(
    (t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id) && (t.payload as SellAllocationDecisionPayload).sellExecutionId === sellId
  );
  if (liveDecision) {
    await retractRawTransaction(repos, liveDecision.id, "Superseded by a new allocation from the Lot Manager");
  }
  if (lines.length > 0) {
    const payload: SellAllocationDecisionPayload = {
      sellExecutionId: sellId,
      allocations: lines.map((l) => ({ lotRef: l.buyLotId, shares: l.shares })),
    };
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "SellAllocationDecision", source: "manual", portfolioId, ticker: normalized, payload })
    );
  }

  await syncTicker(repos, portfolioId, normalized);
}

/** Reset Allocation: removes ONLY this Sell's Allocation Events. Nothing else — no other Sell, no Buy lot's OTHER allocations — is touched. */
export async function resetSellAllocation(repos: LotManagerRepos, portfolioId: string, ticker: string, sellId: string): Promise<void> {
  await setSellAllocation(repos, portfolioId, ticker, sellId, []);
}

export interface FifoProposalLine {
  buyLotId: string;
  buyLotExecutionDate: string;
  shares: number;
}

/**
 * Auto Allocate's FIFO suggestion: an allocation ASSISTANT only, never
 * committed automatically (see this module's doc comment and the Auto
 * Allocate workflow in the spec — Generate Proposal -> Preview -> User
 * Review -> User Edit -> Confirm -> setSellAllocation). Proposes the
 * sell's REMAINING unallocated shares (so calling this again after a
 * partial confirm — "Continue FIFO" — naturally resumes from the oldest
 * lot that still has capacity, never restarting from the very first lot),
 * oldest Buy lot first, skipping any lot dated after the sell (temporal
 * validation) and any lot with nothing left.
 */
export function proposeFifoAllocation(snapshot: LotManagerSnapshot, sellId: string): FifoProposalLine[] {
  const sell = snapshot.sells.find((s) => s.id === sellId);
  if (!sell) return [];
  let remaining = sell.remainingShares;
  if (remaining <= 0) return [];

  const alreadyAllocated = new Map(sell.allocations.map((a) => [a.buyLotId, a.shares]));
  const eligibleLots = [...snapshot.buyLots]
    .filter((lot) => isTemporallyValid(lot, sell) && lot.remainingShares > 0)
    .sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.id.localeCompare(b.id));

  const proposal: FifoProposalLine[] = [];
  for (const lot of eligibleLots) {
    if (remaining <= 0) break;
    // A lot already (partially) allocated to THIS sell is proposed as its
    // existing amount PLUS whatever more it can still take — the caller
    // merges this with the sell's existing lines to get the final "continue" set.
    const take = Math.min(lot.remainingShares, remaining);
    proposal.push({ buyLotId: lot.id, buyLotExecutionDate: lot.executionDate, shares: take + (alreadyAllocated.get(lot.id) ?? 0) });
    remaining -= take;
  }
  return proposal;
}

/**
 * Builds the full ticker-scoped read model: every Buy lot (never hidden,
 * always sorted oldest -> newest, per the spec), every Sell independently
 * with its own status, current position, timeline, and detected validation
 * issues. Recomputed fresh every call — see this module's doc comment.
 */
export async function getLotManagerSnapshot(repos: LotManagerRepos, portfolioId: string, ticker: string): Promise<LotManagerSnapshot> {
  const normalized = normalizeTicker(ticker);
  const { events, allocations } = await computeLedger(repos, portfolioId, normalized);

  const lotEvents = events.filter((e) => e.type === "LotOpened");
  const sellEvents = events.filter((e) => e.type === "SellRecorded");

  const allocatedByLot = new Map<string, number>();
  const allocatedBySell = new Map<string, number>();
  const closedByLot = new Map<string, LotClosingLine[]>();
  const allocationsBySell = new Map<string, AllocationLine[]>();
  const sellDateByEventId = new Map(sellEvents.map((e) => [e.eventId, e.executionDate]));
  const lotDateByEventId = new Map(lotEvents.map((e) => [e.eventId, e.executionDate]));

  for (const a of allocations) {
    allocatedByLot.set(a.lotEventId, (allocatedByLot.get(a.lotEventId) ?? 0) + a.shares);
    allocatedBySell.set(a.sellEventId, (allocatedBySell.get(a.sellEventId) ?? 0) + a.shares);
    const lotList = closedByLot.get(a.lotEventId) ?? [];
    lotList.push({ sellId: a.sellEventId, sellExecutionDate: sellDateByEventId.get(a.sellEventId) ?? a.executionDate, shares: a.shares });
    closedByLot.set(a.lotEventId, lotList);
    const sellList = allocationsBySell.get(a.sellEventId) ?? [];
    sellList.push({ buyLotId: a.lotEventId, buyLotExecutionDate: lotDateByEventId.get(a.lotEventId) ?? a.executionDate, shares: a.shares });
    allocationsBySell.set(a.sellEventId, sellList);
  }

  const buyLots: BuyLot[] = lotEvents
    .map((e) => {
      const allocatedShares = allocatedByLot.get(e.eventId) ?? 0;
      const remainingShares = e.shares - allocatedShares;
      const costBasis = e.shares * e.price + (e.fees ?? 0) + (e.taxes ?? 0);
      return {
        id: e.eventId,
        ticker: normalized,
        executionDate: e.executionDate,
        executionTime: e.executionTime,
        shares: e.shares,
        entryPrice: e.price,
        fees: e.fees ?? 0,
        taxes: e.taxes ?? 0,
        costBasis,
        allocatedShares,
        remainingShares,
        status: remainingShares <= 0 ? "closed" : allocatedShares > 0 ? "partial" : "open",
        closedBy: closedByLot.get(e.eventId) ?? [],
      } satisfies BuyLot;
    })
    .sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.id.localeCompare(b.id));

  const sells: Sell[] = sellEvents
    .map((e) => {
      const allocatedShares = allocatedBySell.get(e.eventId) ?? 0;
      const remainingShares = e.shares - allocatedShares;
      return {
        id: e.eventId,
        ticker: normalized,
        executionDate: e.executionDate,
        executionTime: e.executionTime,
        shares: e.shares,
        price: e.price,
        fees: e.fees ?? 0,
        taxes: e.taxes ?? 0,
        allocations: allocationsBySell.get(e.eventId) ?? [],
        allocatedShares,
        remainingShares,
        status: remainingShares <= 0 ? "completed" : allocatedShares > 0 ? "partial" : "pending",
      } satisfies Sell;
    })
    .sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.id.localeCompare(b.id));

  const boughtShares = buyLots.reduce((sum, l) => sum + l.shares, 0);
  const allocatedShares = allocations.reduce((sum, a) => sum + a.shares, 0);
  const availableShares = buyLots.reduce((sum, l) => sum + l.remainingShares, 0);
  const pendingAllocationShares = sells.reduce((sum, s) => sum + s.remainingShares, 0);

  const timeline: TimelineEntry[] = [
    ...buyLots.map((l) => ({
      id: l.id,
      type: "BUY" as const,
      executionDate: l.executionDate,
      executionTime: l.executionTime,
      shares: l.shares,
      price: l.entryPrice,
      relatedAllocationIds: allocations.filter((a) => a.lotEventId === l.id).map((a) => a.id),
    })),
    ...sells.map((s) => ({
      id: s.id,
      type: "SELL" as const,
      executionDate: s.executionDate,
      executionTime: s.executionTime,
      shares: s.shares,
      price: s.price,
      relatedAllocationIds: allocations.filter((a) => a.sellEventId === s.id).map((a) => a.id),
    })),
  ].sort((a, b) => `${a.executionDate}T${a.executionTime ?? "00:00"}`.localeCompare(`${b.executionDate}T${b.executionTime ?? "00:00"}`));

  const issues: ValidationIssue[] = [];
  for (const lot of buyLots) {
    if (lot.remainingShares < 0) issues.push({ code: "negative-remaining", buyLotId: lot.id, message: `Buy lot ${lot.executionDate} is over-allocated: ${lot.allocatedShares} shares allocated against ${lot.shares} bought.` });
  }
  for (const sell of sells) {
    if (sell.remainingShares < 0) issues.push({ code: "over-allocation", sellId: sell.id, message: `Sell ${sell.executionDate} has ${sell.allocatedShares} shares allocated against only ${sell.shares} sold.` });
    if (sell.status === "pending") issues.push({ code: "missing-allocation", sellId: sell.id, message: `Sell ${sell.executionDate} has no allocation yet — ${sell.remainingShares} shares are unattributed to any Buy lot.` });
    const seen = new Set<string>();
    for (const line of sell.allocations) {
      if (seen.has(line.buyLotId)) issues.push({ code: "duplicate-allocation", sellId: sell.id, buyLotId: line.buyLotId, message: `Sell ${sell.executionDate} allocates the same Buy lot more than once.` });
      seen.add(line.buyLotId);
      const lot = buyLots.find((l) => l.id === line.buyLotId);
      if (lot && line.buyLotExecutionDate > sell.executionDate) {
        issues.push({
          code: "chronological-violation",
          sellId: sell.id,
          buyLotId: line.buyLotId,
          message: `This Buy transaction occurred after the selected Sell transaction and cannot be allocated.`,
        });
      }
    }
  }
  if (allocatedShares > boughtShares) {
    issues.push({ code: "inventory-mismatch", message: `Total allocated shares (${allocatedShares}) exceed total shares bought (${boughtShares}).` });
  }

  return {
    ticker: normalized,
    buyLots,
    sells,
    currentPosition: { boughtShares, availableShares, allocatedShares, pendingAllocationShares },
    timeline,
    issues,
  };
}

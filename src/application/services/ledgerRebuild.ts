
import type { Upload, ParsedTradeCandidate } from "@domain/entities/Upload";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { type GroupingSignature, toGroupingSignature } from "@domain/value-objects/identity";
import {
  findAggregateStatementMatches,
  completeCandidateFieldsFromSiblings,
  suggestDuplicatePendingCandidateKeysToDelete,
  pendingCandidateSignature,
  findDuplicateBuyMatch,
  findDuplicateSellMatch,
  groupSellAllocationsByOrder,
  pricesWithinOcrNoise,
  timesConflict,
  type SellOrderGroup,
} from "./duplicateDetection";
import { latestByTicker } from "./reconciliation";
import { buildInventoryFacts, evaluateInventoryConstraint, type InventoryContradiction } from "./constraintValidation";
import { checkTickerMatch } from "./importVerification";
import { recordBuy, deleteTrade } from "./TradeService";
import type { AppRepositories } from "./types";

/**
 * Ledger Rebuild Engine.
 *
 * Reconstructs what the ledger's Trades and sell orders SHOULD be, computed
 * exclusively from verified source documents (every parsed Upload â€”
 * Statements, Invoices, Orders-screen reads, CSV exports â€” plus Holdings
 * verification screenshots). The current Trade/TradeAllocation ledger is
 * NEVER read as an input to this reconstruction â€” only compared against
 * afterward, as the "before" side of a diff. This is the inverse of
 * checkTickerMatch's role (which reconciles one Import batch against the
 * ledger as it stands); this instead re-derives the ledger's own contents
 * from scratch and reports where the two disagree.
 *
 * Reuses the existing reconciliation toolbox rather than re-implementing it:
 * findAggregateStatementMatches (Statement-aggregates-never-splits),
 * completeCandidateFieldsFromSiblings + suggestDuplicatePendingCandidateKeysToDelete
 * (collapsing repeated reads of the same real execution across documents),
 * findDuplicateBuyMatch/findDuplicateSellMatch (matching a canonical fact
 * against the existing ledger), and â€” critically â€” checkTickerMatch itself
 * (importVerification.ts) for the Holdings/verification decision
 * (diffHoldings), the SAME function Import calls. There is exactly one trust
 * policy in this codebase: a ticker whose complete canonical history is
 * official-broker-excel-sourced (or invoice-sourced) is never required to
 * reconcile against a "My Position" screenshot, and Rebuild must reach that
 * same verdict for the same reason Import does â€” never its own,
 * independently-derived approximation of it. `CanonicalTrade.source`
 * (preserved from each surviving candidate) is what makes this possible:
 * without it, Rebuild had no provenance to feed the trust policy at all and
 * silently fell back to a naive calculated-vs-Holdings comparison with no
 * concept of source, reintroducing exactly the "needs corroboration" verdict
 * the trust policy exists to eliminate (see docs/ROADMAP.md's "Rebuild Ledger
 * pipeline" entry for the bug this fixed).
 *
 * Allocation-level rebuilding (WHICH buy lot a sell closed) is out of scope
 * by design: a source document records that N shares of TICKER were sold on
 * a date at a price, never which specific lot(s) absorbed it â€” that's a
 * human decision this app already always asks for (ADR-002, SellAllocationForm),
 * never inferred by FIFO/average-cost. So sells are reconstructed and diffed
 * only as aggregate per-order facts; applyLedgerRebuild never creates or
 * deletes a TradeAllocation.
 */

export interface CanonicalTrade {
  key: string;
  side: "BUY" | "SELL";
  ticker: string;
  companyName?: string;
  shares: number;
  price: number;
  fees?: number;
  taxes?: number;
  executionDate: string;
  executionTime?: string;
  transactionNumber?: string;
  /** Every Upload whose candidate corroborates this same real execution (after dedup/aggregation) â€” not just the one survivor row's own file. */
  sourceUploadIds: string[];
  /** This specific entry's own stable identity (the `key`/`uploadId` it entered canonicalization with) â€” unlike `key`, this is NEVER shared by two distinct surviving entries, even when their observable fields coincide. See `disambiguateCollidingKeys`. */
  entryId: string;
  /**
   * Which document type this specific real execution was read from â€” the
   * surviving entry's own `ParsedTradeCandidate.source`, untouched by
   * `completeCandidateFieldsFromSiblings` (which only ever borrows
   * fees/taxes/time/transactionNumber from a sibling, never source itself).
   * This is what lets `diffHoldings` feed the SAME trust-policy decision
   * (`checkTickerMatch`, `importVerification.ts`) that Import already makes
   * for the identical ticker/source combination â€” see this module's own doc
   * comment on why Rebuild must never re-derive a second, independent
   * verification/trust judgment.
   */
  source: ParsedTradeCandidate["source"];
}

/** Exported so a caller with a canonicalization-worthy entry pool that isn't shaped like Upload[] (e.g. the Ledger Engine, over RawTransactions) can derive the same deterministic identity for "one real execution" without re-deriving the formula. */
export function canonicalKey(c: { side: "BUY" | "SELL"; ticker: string; date: string; shares: number; price: number }): GroupingSignature {
  return toGroupingSignature(`${normalizeTicker(c.ticker)}|${c.side}|${c.date}|${c.shares}|${c.price}`);
}

/**
 * The reusable core of buildCanonicalTrades, split out so a caller whose
 * entries didn't come from Upload.candidates (e.g. the Ledger Engine, over
 * RawTransactions) can still reuse this exact dedup/aggregation pipeline.
 * `uploadId` on each entry is "whatever backing document/fact this candidate
 * traces back to" â€” an Upload id for buildCanonicalTrades' own callers, but
 * just as validly a RawTransaction's own id when there's no separate Upload
 * concept at the caller's layer.
 */
export function canonicalizeTradeEntries(
  allEntries: { key: string; candidate: ParsedTradeCandidate; uploadId: string }[]
): { buys: CanonicalTrade[]; sells: CanonicalTrade[] } {
  if (allEntries.length === 0) return { buys: [], sells: [] };

  // Statement rows that aggregate several other-source executions are
  // confirmations, not separate real trades â€” exclude them from
  // canonicalization entirely; their shares are already covered by the
  // execution group they summarize.
  const aggregateMatches = findAggregateStatementMatches(allEntries);
  const aggregatedStatementKeys = new Set(aggregateMatches.keys());
  const aggregatingUploadIdByExecutionKey = new Map<string, string[]>();
  for (const [statementKey, executionKeys] of aggregateMatches) {
    const statementEntry = allEntries.find((e) => e.key === statementKey);
    if (!statementEntry) continue;
    for (const execKey of executionKeys) {
      const list = aggregatingUploadIdByExecutionKey.get(execKey) ?? [];
      list.push(statementEntry.uploadId);
      aggregatingUploadIdByExecutionKey.set(execKey, list);
    }
  }

  const remainingEntries = allEntries.filter((e) => !aggregatedStatementKeys.has(e.key));

  const patches = completeCandidateFieldsFromSiblings(remainingEntries);
  const enrichedEntries = remainingEntries.map((e) => {
    const patch = patches.get(e.key);
    return patch ? { ...e, candidate: { ...e.candidate, ...patch } } : e;
  });

  const deleteKeys = new Set(suggestDuplicatePendingCandidateKeysToDelete(enrichedEntries));

  // Every upload that corroborates the same real execution (its signature
  // siblings) â€” but pendingCandidateSignature is deliberately time-blind
  // (ticker|side|date|shares only), so two genuinely distinct real
  // executions sharing that signature (e.g. two same-price fills minutes
  // apart â€” a real, reported case: two 49-share ABUK buys at EÂ£42.40,
  // 10:32AM and 10:34AM) used to be unioned into the SAME sourceUploadIds
  // set regardless of time. That shared set became each lot's
  // LedgerEvent.sourceTransactionIds (ledgerEngine.ts), which
  // allocationEngine.indexEventsByReference then indexes as an alias map
  // from "any corroborating real id" to "this one lot" â€” the union meant
  // BOTH lots' real ids resolved to whichever lot was indexed first,
  // silently misattributing a Sell's allocation to the wrong lot of the
  // pair even though resolveLotRef (ledgerProjection.ts) had already
  // written the CORRECT real id into the decision. Time-gated the same way
  // sameCandidateExecution/suggestDuplicatePendingCandidateKeysToDelete
  // already gate this exact signature elsewhere: a sibling only corroborates
  // this entry when neither side's time conflicts with the other's (an
  // absent time on either side is "unknown," never treated as a conflict â€”
  // preserving the routine statement+invoice/orders-screen corroboration
  // case, where one side often carries no time at all).
  const entriesBySignature = new Map<string, { uploadId: string; time?: string }[]>();
  for (const e of enrichedEntries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = entriesBySignature.get(sig) ?? [];
    list.push({ uploadId: e.uploadId, time: e.candidate.time });
    entriesBySignature.set(sig, list);
  }

  const buys: CanonicalTrade[] = [];
  const sells: CanonicalTrade[] = [];
  for (const e of enrichedEntries) {
    if (deleteKeys.has(e.key)) continue;
    const sig = pendingCandidateSignature(e.candidate);
    const signatureSiblings = entriesBySignature.get(sig) ?? [{ uploadId: e.uploadId, time: e.candidate.time }];
    const sourceUploadIds = new Set(
      signatureSiblings.filter((s) => !timesConflict(e.candidate.time, s.time)).map((s) => s.uploadId)
    );
    for (const uploadId of aggregatingUploadIdByExecutionKey.get(e.key) ?? []) sourceUploadIds.add(uploadId);
    const canonical: CanonicalTrade = {
      key: canonicalKey({ side: e.candidate.side, ticker: e.candidate.ticker, date: e.candidate.date, shares: e.candidate.shares, price: e.candidate.price }),
      side: e.candidate.side,
      ticker: normalizeTicker(e.candidate.ticker),
      companyName: e.candidate.companyName,
      shares: e.candidate.shares,
      price: e.candidate.price,
      fees: e.candidate.fees,
      taxes: e.candidate.taxes,
      executionDate: e.candidate.date,
      executionTime: e.candidate.time,
      transactionNumber: e.candidate.transactionNumber,
      sourceUploadIds: [...sourceUploadIds],
      entryId: e.key,
      source: e.candidate.source,
    };
    (canonical.side === "BUY" ? buys : sells).push(canonical);
  }
  disambiguateCollidingKeys(buys);
  disambiguateCollidingKeys(sells);
  return { buys, sells };
}

/**
 * Two genuinely distinct real executions (different trades, different
 * RawTransactions) can legitimately share the same observable fields â€”
 * same ticker/side/date/shares/price, e.g. two separate same-price limit
 * orders filled the same day. Before this pass they'd carry the identical
 * `key`, and every downstream consumer that treats `key` as "one real
 * execution" (the Ledger Engine's `eventId`, the Allocation Engine's
 * lot/sell identity) would silently conflate them: one buy lot's shares
 * absorbing another's, one sell's allocation decision replaying against
 * the wrong sell. Disambiguates every collision by suffixing every member
 * but the lexicographically-first (by `entryId`, so the pick is
 * deterministic and reproducible on every rebuild â€” never by array/seq
 * order, which callers aren't guaranteed to supply consistently) with its
 * own `entryId` â€” unique, so no second collision is possible.
 */
function disambiguateCollidingKeys(trades: CanonicalTrade[]): void {
  const groups = new Map<string, CanonicalTrade[]>();
  for (const t of trades) {
    const list = groups.get(t.key) ?? [];
    list.push(t);
    groups.set(t.key, list);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => a.entryId.localeCompare(b.entryId));
    for (let i = 1; i < sorted.length; i++) {
      sorted[i].key = `${sorted[i].key}#${sorted[i].entryId}`;
    }
  }
}

/**
 * Collapses every parsed candidate across every Upload into the set of
 * canonical facts that should exist: one entry per real execution, whether
 * it was read once or corroborated by several documents. See the module
 * doc comment for which existing functions this reuses and why.
 */
export function buildCanonicalTrades(uploads: Upload[]): { buys: CanonicalTrade[]; sells: CanonicalTrade[] } {
  const allEntries: { key: string; candidate: ParsedTradeCandidate; uploadId: string }[] = [];
  for (const upload of uploads) {
    if (upload.status !== "parsed") continue;
    upload.candidates.forEach((candidate, i) => {
      allEntries.push({ key: `${upload.id}#${i}`, candidate, uploadId: upload.id });
    });
  }
  return canonicalizeTradeEntries(allEntries);
}

export interface TradeFieldChange {
  field: "price" | "fees" | "taxes" | "executionTime" | "companyName" | "transactionNumber";
  existing: string | number | undefined;
  canonical: string | number | undefined;
}

function diffTradeFields(trade: Trade, canonical: CanonicalTrade): TradeFieldChange[] {
  const changes: TradeFieldChange[] = [];
  if (Math.round(trade.entryPrice * 10_000) !== Math.round(canonical.price * 10_000))
    changes.push({ field: "price", existing: trade.entryPrice, canonical: canonical.price });
  if ((canonical.fees ?? 0) !== trade.fees) changes.push({ field: "fees", existing: trade.fees, canonical: canonical.fees ?? 0 });
  if ((canonical.taxes ?? 0) !== trade.taxes) changes.push({ field: "taxes", existing: trade.taxes, canonical: canonical.taxes ?? 0 });
  if (canonical.executionTime !== undefined && canonical.executionTime !== trade.executionTime)
    changes.push({ field: "executionTime", existing: trade.executionTime, canonical: canonical.executionTime });
  if (canonical.companyName !== undefined && canonical.companyName !== trade.companyName)
    changes.push({ field: "companyName", existing: trade.companyName, canonical: canonical.companyName });
  if (canonical.transactionNumber !== undefined && canonical.transactionNumber !== trade.transactionNumber)
    changes.push({ field: "transactionNumber", existing: trade.transactionNumber, canonical: canonical.transactionNumber });
  return changes;
}

/** companyName/transactionNumber carry no cash implication â€” safe to correct in place. price/fees/taxes affect cost basis (and therefore cash already debited) and executionTime has a matching timeline event to keep in sync â€” never auto-applied; surfaced for a manual delete+re-add instead. */
const CASH_SAFE_FIELDS = new Set<TradeFieldChange["field"]>(["companyName", "transactionNumber"]);

export interface TradeToAdd {
  canonical: CanonicalTrade;
}
export interface TradeToRemove {
  trade: Trade;
  /** Mirrors deleteTrade's own guard â€” a trade with shares already sold against it can't be auto-removed without corrupting that history. */
  blockedByAllocations: boolean;
}
export interface TradeToModify {
  trade: Trade;
  canonical: CanonicalTrade;
  changes: TradeFieldChange[];
  /** True only when every changed field is cash-safe (see CASH_SAFE_FIELDS) â€” the only case applyLedgerRebuild will act on. */
  autoApplicable: boolean;
}

export interface SellToAdd {
  canonical: CanonicalTrade;
}
export interface SellExtraneous {
  group: SellOrderGroup;
  ticker: string;
}
export interface SellModified {
  group: SellOrderGroup;
  ticker: string;
  canonical: CanonicalTrade;
}

export interface HoldingsMismatch {
  ticker: string;
  calculatedRemaining: number;
  verifiedUnits?: number;
  verificationCapturedAt?: string;
  contradiction: InventoryContradiction | undefined;
}

export interface LedgerRebuildReport {
  generatedAt: string;
  tradesToAdd: TradeToAdd[];
  tradesToRemove: TradeToRemove[];
  tradesToModify: TradeToModify[];
  sellsToAdd: SellToAdd[];
  sellsExtraneous: SellExtraneous[];
  sellsModified: SellModified[];
  holdingsMismatches: HoldingsMismatch[];
}

/** Buy-side diff: matches every canonical Buy against the existing ledger (searched across every portfolio, exactly like duplicateDetection's existing cross-portfolio checks), one-to-one â€” an existing trade already claimed by one canonical match is never matched again. */
function diffBuys(canonicalBuys: CanonicalTrade[], existingTrades: Trade[]): { toAdd: TradeToAdd[]; toModify: TradeToModify[]; matchedTradeIds: Set<string> } {
  const toAdd: TradeToAdd[] = [];
  const toModify: TradeToModify[] = [];
  const matchedTradeIds = new Set<string>();

  // Transaction-number-bearing canonical trades resolve unambiguously â€”
  // process them first so a shared ticker/date/share-count coincidence never
  // steals a match away from the row with decisive proof.
  const ordered = [...canonicalBuys].sort((a, b) => Number(b.transactionNumber !== undefined) - Number(a.transactionNumber !== undefined));

  for (const canonical of ordered) {
    const candidatePool = existingTrades.filter((t) => !matchedTradeIds.has(t.id));
    const match = findDuplicateBuyMatch(
      { ticker: canonical.ticker, side: "BUY", shares: canonical.shares, price: canonical.price, date: canonical.executionDate, time: canonical.executionTime, transactionNumber: canonical.transactionNumber } as ParsedTradeCandidate,
      candidatePool,
    );
    if (!match) {
      toAdd.push({ canonical });
      continue;
    }
    matchedTradeIds.add(match.matchedId);
    const trade = candidatePool.find((t) => t.id === match.matchedId)!;
    const changes = diffTradeFields(trade, canonical);
    if (changes.length > 0) {
      toModify.push({ trade, canonical, changes, autoApplicable: changes.every((c) => CASH_SAFE_FIELDS.has(c.field)) });
    }
  }
  return { toAdd, toModify, matchedTradeIds };
}

function diffSells(
  canonicalSells: CanonicalTrade[],
  existingAllocations: TradeAllocation[],
): { toAdd: SellToAdd[]; modified: SellModified[]; extraneous: SellExtraneous[] } {
  const toAdd: SellToAdd[] = [];
  const modified: SellModified[] = [];
  const matchedGroupIds = new Set<string>();

  const ordered = [...canonicalSells].sort((a, b) => Number(b.transactionNumber !== undefined) - Number(a.transactionNumber !== undefined));
  for (const canonical of ordered) {
    const match = findDuplicateSellMatch(
      { ticker: canonical.ticker, side: "SELL", shares: canonical.shares, price: canonical.price, date: canonical.executionDate, time: canonical.executionTime, transactionNumber: canonical.transactionNumber } as ParsedTradeCandidate,
      existingAllocations.filter((a) => normalizeTicker(a.ticker) === canonical.ticker),
    );
    if (!match) {
      toAdd.push({ canonical });
      continue;
    }
    matchedGroupIds.add(match.matchedId);
    if (!pricesWithinOcrNoise(match.matchedPrice, canonical.price)) {
      const group = [...groupSellAllocationsByOrder(existingAllocations, canonical.ticker).values()].find((g) => g.id === match.matchedId);
      if (group) modified.push({ group, ticker: canonical.ticker, canonical });
    }
  }

  const extraneous: SellExtraneous[] = [];
  const tickers = new Set(existingAllocations.map((a) => normalizeTicker(a.ticker)));
  for (const ticker of tickers) {
    for (const [, group] of groupSellAllocationsByOrder(existingAllocations, ticker)) {
      if (!matchedGroupIds.has(group.id)) extraneous.push({ group, ticker });
    }
  }
  return { toAdd, modified, extraneous };
}

/**
 * Holdings/verification decision: calls checkTickerMatch â€” the exact same
 * function Import calls for this same decision â€” rather than comparing
 * calculated-vs-Holdings directly. This is what makes Rebuild produce the
 * same verdict Import would for an identical ticker: a ticker whose complete
 * canonical Buy/Sell history is entirely official-broker-excel (or entirely
 * invoice) sourced is exempted from Holdings reconciliation exactly the way
 * Import already exempts it, via the same `reason` field threaded into
 * buildInventoryFacts/evaluateInventoryConstraint (constraintValidation.ts).
 * No second trust policy is implemented here â€” every one of these tickers'
 * verification outcomes is a single function call shared with Import.
 */
function diffHoldings(canonicalBuys: CanonicalTrade[], canonicalSells: CanonicalTrade[], verifications: PositionVerification[]): HoldingsMismatch[] {
  const buySharesByTicker = new Map<string, number>();
  const sellSharesByTicker = new Map<string, number>();
  const rowsByTicker = new Map<string, CanonicalTrade[]>();
  const addRow = (row: CanonicalTrade) => {
    const list = rowsByTicker.get(row.ticker);
    if (list) list.push(row);
    else rowsByTicker.set(row.ticker, [row]);
  };
  for (const b of canonicalBuys) {
    buySharesByTicker.set(b.ticker, (buySharesByTicker.get(b.ticker) ?? 0) + b.shares);
    addRow(b);
  }
  for (const s of canonicalSells) {
    sellSharesByTicker.set(s.ticker, (sellSharesByTicker.get(s.ticker) ?? 0) + s.shares);
    addRow(s);
  }
  const latestVerification = latestByTicker(verifications);

  const tickers = new Set([...buySharesByTicker.keys(), ...sellSharesByTicker.keys(), ...latestVerification.keys()]);
  const results: HoldingsMismatch[] = [];
  for (const ticker of tickers) {
    const buyShares = buySharesByTicker.get(ticker) ?? 0;
    const sellShares = sellSharesByTicker.get(ticker) ?? 0;
    const verification = latestVerification.get(ticker);
    const rows = rowsByTicker.get(ticker) ?? [];
    const allPendingFromOfficialBrokerExcel = rows.length > 0 && rows.every((r) => r.source === "official-broker-excel");
    const allPendingFromInvoice = rows.length > 0 && rows.every((r) => r.source === "invoice");

    const status = checkTickerMatch({
      hasShares: buyShares + sellShares > 0,
      pendingBuyShares: buyShares,
      pendingSellShares: sellShares,
      existingRemainingShares: 0,
      verifiedUnits: verification?.units,
      allPendingFromOfficialBrokerExcel,
      allPendingFromInvoice,
    });
    const facts = buildInventoryFacts(ticker, status);
    const contradictions = evaluateInventoryConstraint(facts);
    if (contradictions.length === 0) continue; // satisfied â€” closed position, exact holdings match, broker-excel/invoice-verified, or no verification to compare against
    results.push({
      ticker,
      calculatedRemaining: facts.calculatedRemaining,
      verifiedUnits: facts.holdingsRemaining,
      verificationCapturedAt: verification?.capturedAt,
      contradiction: contradictions[0],
    });
  }
  return results.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/**
 * Dry run: reads every Upload, the full ledger, and every Holdings
 * verification, and returns the full diff. Never writes anything.
 */
export async function dryRunLedgerRebuild(repos: AppRepositories): Promise<LedgerRebuildReport> {
  const [uploads, existingTrades, existingAllocations, existingVerifications] = await Promise.all([
    repos.uploads.getAll(),
    repos.trades.getAll(),
    repos.allocations.getAll(),
    repos.verifications.getAll(),
  ]);

  const { buys: canonicalBuys, sells: canonicalSells } = buildCanonicalTrades(uploads);
  const { toAdd: tradesToAdd, toModify: tradesToModify, matchedTradeIds } = diffBuys(canonicalBuys, existingTrades);
  const { toAdd: sellsToAdd, modified: sellsModified, extraneous: sellsExtraneous } = diffSells(canonicalSells, existingAllocations);

  const tradesToRemove: TradeToRemove[] = existingTrades
    .filter((t) => !matchedTradeIds.has(t.id))
    .map((trade) => ({ trade, blockedByAllocations: trade.remainingShares !== trade.shares }));

  const holdingsMismatches = diffHoldings(canonicalBuys, canonicalSells, existingVerifications);

  return {
    generatedAt: new Date().toISOString(),
    tradesToAdd,
    tradesToRemove,
    tradesToModify,
    sellsToAdd,
    sellsExtraneous,
    sellsModified,
    holdingsMismatches,
  };
}

export interface ApplyLedgerRebuildDecisions {
  /** CanonicalTrade.key -> portfolio to create it in. A trade left out here is skipped â€” portfolio placement is never guessed. */
  addToPortfolioByKey: Record<string, string>;
  /** Trade.id values from tradesToRemove the caller has confirmed removing. Refused (via deleteTrade's own guard) if shares were sold against it. */
  removeTradeIds: string[];
  /** Trade.id values from tradesToModify the caller has confirmed correcting. Only ever applies a change whose fields are ALL cash-safe (see CASH_SAFE_FIELDS) â€” anything else is silently skipped even if listed here. */
  modifyTradeIds: string[];
}

export interface ApplyLedgerRebuildResult {
  added: number;
  removed: number;
  modified: number;
  skipped: { tradeId: string; reason: string }[];
}

/**
 * Applies only the subset of a dry run's diff that's safe to automate:
 * creating a missing Buy (once the caller supplies a portfolio â€” never
 * inferred), deleting an extraneous Buy with nothing sold against it (via
 * the existing, cash-safe deleteTrade), and correcting cash-neutral metadata
 * (companyName/transactionNumber) on a matched Buy. Never creates, deletes,
 * or edits a TradeAllocation, and never corrects a cash-affecting field
 * (price/fees/taxes) in place â€” both require a human decision this app
 * already always asks for elsewhere (ADR-002; the sell allocation UI; a
 * manual delete + re-add for a cash-affecting correction).
 */
export async function applyLedgerRebuild(
  repos: AppRepositories,
  report: LedgerRebuildReport,
  decisions: ApplyLedgerRebuildDecisions,
): Promise<ApplyLedgerRebuildResult> {
  const skipped: { tradeId: string; reason: string }[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const { canonical } of report.tradesToAdd) {
    const portfolioId = decisions.addToPortfolioByKey[canonical.key];
    if (!portfolioId) continue;
    await recordBuy(repos, {
      portfolioId,
      ticker: canonical.ticker,
      companyName: canonical.companyName,
      shares: canonical.shares,
      entryPrice: canonical.price,
      fees: canonical.fees,
      taxes: canonical.taxes,
      executionDate: canonical.executionDate,
      executionTime: canonical.executionTime ?? "00:00",
      transactionNumber: canonical.transactionNumber,
      source: canonical.source,
    });
    added++;
  }

  for (const tradeId of decisions.removeTradeIds) {
    const entry = report.tradesToRemove.find((r) => r.trade.id === tradeId);
    if (!entry || entry.blockedByAllocations) {
      skipped.push({ tradeId, reason: "Has shares sold against it â€” can't be auto-removed." });
      continue;
    }
    await deleteTrade(repos, tradeId);
    removed++;
  }

  for (const tradeId of decisions.modifyTradeIds) {
    const entry = report.tradesToModify.find((m) => m.trade.id === tradeId);
    if (!entry || !entry.autoApplicable) {
      skipped.push({ tradeId, reason: "Change touches price/fees/taxes/time â€” requires a manual delete + re-add, never auto-applied." });
      continue;
    }
    const updated: Trade = { ...entry.trade };
    for (const change of entry.changes) {
      if (change.field === "companyName") updated.companyName = entry.canonical.companyName;
      if (change.field === "transactionNumber") updated.transactionNumber = entry.canonical.transactionNumber;
    }
    await repos.trades.save(updated);
    modified++;
  }

  return { added, removed, modified, skipped };
}


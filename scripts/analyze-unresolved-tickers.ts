/**
 * Standalone, read-only analysis tool. NOT part of the shipped app, not
 * wired into any route or build output — run it manually with real exported
 * data to turn "produce a root-cause report for every unresolved ticker"
 * into actual numbers instead of a code-only taxonomy.
 *
 * It re-derives every unresolved ticker's match status/diagnosis by calling
 * the exact same functions ImportPage.tsx calls (checkTickerMatch,
 * findCrossSourceVerifiedKeys, findAggregateStatementMatches,
 * findOrderConfirmedKeys, suggestRemovalsToReconcile, findLastBalancedDate,
 * buildTickerConstraintReport, ...) — no reconciliation logic is
 * reimplemented here, only replayed against real data outside the browser.
 *
 * Inputs (two JSON files, both optional but the first is what makes this
 * useful at all):
 *
 *   1. The Import page's pending pool — in the browser, open DevTools on
 *      the Import page and run:
 *        copy(localStorage.getItem("portfolio-os:import-session"))
 *      then paste the clipboard contents into a file, e.g. session.json.
 *
 *   2. A ledger backup — Settings -> Export backup (BackupService.exportLedger)
 *      gives committed trades/allocations/verifications, needed to compute
 *      existingRemainingShares for tickers that already have ledger history.
 *      Without it, every ticker is scored as if its ledger were empty.
 *
 * Usage:
 *   npx tsx scripts/analyze-unresolved-tickers.ts session.json [ledger.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { Money } from "@domain/value-objects/Money";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { CandidateEntry, VerificationEntry, DividendEntry, OrderEvidenceEntry } from "@presentation/lib/importSession";
import { checkTickerMatch, type TickerMatchStatus } from "@application/services/importVerification";
import {
  findCrossSourceVerifiedKeys,
  findAggregateStatementMatches,
  findWrongTickerCandidateKeys,
  findDateMisreadDuplicateHints,
} from "@application/services/duplicateDetection";
import { findOrderConfirmedKeys, findOrphanedFulfilledEvidence } from "@application/services/orderEvidence";
import { suggestRemovalsToReconcile } from "@application/services/mismatchResolver";
import { findLastBalancedDate } from "@application/services/netShareTimeline";
import { buildTickerConstraintReport } from "@application/services/constraintValidation";

interface ImportSessionFile {
  pendingCandidates: CandidateEntry[];
  pendingVerifications: VerificationEntry[];
  pendingDividends: DividendEntry[];
  pendingOrderEvidences: OrderEvidenceEntry[];
  discardedCandidates?: CandidateEntry[];
  addedKeys?: string[];
  acceptedKeys?: string[];
  skippedKeys?: string[];
  dismissedKeys?: string[];
}

interface LedgerFile {
  trades?: Trade[];
  allocations?: TradeAllocation[];
  verifications?: PositionVerification[];
}

type Bucket =
  | "NV-1 sell-side (missing historical Buy)"
  | "NV-2 buy-side surplus already on ledger"
  | "NV-3 buy-side surplus among pending rows"
  | "MM-1 already fully recorded (bulk re-upload)"
  | "MM-2 exact duplicate/misread row identified"
  | "MM-3 no exact subset found"
  | "matched (not actually unresolved)";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  const [sessionPath, ledgerPath] = process.argv.slice(2);
  if (!sessionPath) {
    console.error("Usage: npx tsx scripts/analyze-unresolved-tickers.ts session.json [ledger.json]");
    process.exit(1);
  }

  const session = readJson<ImportSessionFile>(sessionPath);
  const ledger = ledgerPath ? readJson<LedgerFile>(ledgerPath) : {};

  const existingTrades = ledger.trades ?? [];
  const existingAllocations = ledger.allocations ?? [];
  const existingVerifications = ledger.verifications ?? [];

  const addedKeys = new Set(session.addedKeys ?? []);
  const skippedKeys = new Set(session.skippedKeys ?? []);
  const dismissedKeys = new Set(session.dismissedKeys ?? []);
  const discardedCandidates = session.discardedCandidates ?? [];
  const pendingCandidates = session.pendingCandidates ?? [];
  const pendingVerifications = session.pendingVerifications ?? [];
  const pendingDividends = session.pendingDividends ?? [];
  const pendingOrderEvidences = session.pendingOrderEvidences ?? [];

  // --- Reproduce ImportPage.tsx's tickerGroups grouping exactly. ---
  const tickerGroups = new Map<
    string,
    { buys: CandidateEntry[]; sells: CandidateEntry[]; verifications: VerificationEntry[]; dividends: DividendEntry[]; orderEvidences: OrderEvidenceEntry[] }
  >();
  const group = (ticker: string) => {
    const t = normalizeTicker(ticker);
    const g = tickerGroups.get(t) ?? { buys: [], sells: [], verifications: [], dividends: [], orderEvidences: [] };
    tickerGroups.set(t, g);
    return g;
  };
  for (const entry of pendingCandidates) (entry.candidate.side === "BUY" ? group(entry.candidate.ticker).buys : group(entry.candidate.ticker).sells).push(entry);
  for (const entry of pendingVerifications) group(entry.verification.ticker).verifications.push(entry);
  for (const entry of pendingDividends) group(entry.dividend.ticker).dividends.push(entry);
  for (const entry of pendingOrderEvidences) group(entry.evidence.ticker).orderEvidences.push(entry);

  const stillPendingAll = pendingCandidates.filter((e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key));

  const crossVerifiedKeys = findCrossSourceVerifiedKeys([...stillPendingAll, ...discardedCandidates]);
  const aggregateStatementMatches = findAggregateStatementMatches(stillPendingAll, crossVerifiedKeys);
  const aggregateConfirmedKeys = new Set<string>();
  for (const keys of aggregateStatementMatches.values()) for (const k of keys) aggregateConfirmedKeys.add(k);
  const orderConfirmedKeys =
    pendingOrderEvidences.length > 0 ? findOrderConfirmedKeys(stillPendingAll, pendingOrderEvidences.map((e) => e.evidence)) : new Set<string>();
  const wrongTickerHints = findWrongTickerCandidateKeys(stillPendingAll, existingTrades, existingAllocations);
  const dateMisreadHints = findDateMisreadDuplicateHints(stillPendingAll, existingTrades, existingAllocations);
  const orphanedEvidenceByTicker =
    pendingOrderEvidences.length > 0 ? findOrphanedFulfilledEvidence(stillPendingAll, pendingOrderEvidences.map((e) => e.evidence)) : new Map();

  const bucketCounts = new Map<Bucket, string[]>();
  const addToBucket = (bucket: Bucket, ticker: string) => {
    const list = bucketCounts.get(bucket) ?? [];
    list.push(ticker);
    bucketCounts.set(bucket, list);
  };

  let noVerificationInputAtAllCount = 0;
  let ordersUploadedButIncompleteCount = 0;
  let orphanedOrdersEvidenceCount = 0;
  let hasWrongTickerHintCount = 0;
  let hasDateMisreadHintCount = 0;
  let hasReconcileSuggestionCount = 0;
  let hasLastBalancedDateCount = 0;

  const rows: { ticker: string; status: TickerMatchStatus; bucket: Bucket; factsLine: string }[] = [];

  for (const [ticker, g] of [...tickerGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const remainingBuys = g.buys.filter((e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key));
    const remainingSells = g.sells.filter((e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key));
    const pendingBuyShares = remainingBuys.reduce((s, e) => s + e.candidate.shares, 0);
    const pendingSellShares = remainingSells.reduce((s, e) => s + e.candidate.shares, 0);
    const remainingBuysAndSells = [...remainingBuys, ...remainingSells];
    const allPendingFromInvoice = remainingBuysAndSells.length > 0 && remainingBuysAndSells.every((e) => e.candidate.source === "invoice");
    const allPendingSelfVerified =
      remainingBuysAndSells.length > 0 &&
      remainingBuysAndSells.every((e) => e.candidate.source === "invoice" || crossVerifiedKeys.has(e.key) || aggregateConfirmedKeys.has(e.key));
    const allPendingOrderConfirmed =
      remainingBuysAndSells.length > 0 &&
      remainingBuysAndSells.every(
        (e) => e.candidate.source === "invoice" || crossVerifiedKeys.has(e.key) || aggregateConfirmedKeys.has(e.key) || orderConfirmedKeys.has(e.key),
      );
    const existingRemainingShares = existingTrades.filter((t) => normalizeTicker(t.ticker) === ticker).reduce((s, t) => s + t.remainingShares, 0);
    const verificationCandidates = [...existingVerifications.filter((v) => normalizeTicker(v.ticker) === ticker), ...g.verifications.map((e) => e.verification)];
    const latestVerification = verificationCandidates.length ? verificationCandidates.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b)) : undefined;

    const status = checkTickerMatch({
      hasShares: g.buys.length + g.sells.length > 0,
      pendingBuyShares,
      pendingSellShares,
      existingRemainingShares,
      verifiedUnits: latestVerification?.units,
      verifiedAvgCost: latestVerification?.avgCost,
      allPendingFromInvoice,
      allPendingSelfVerified,
      allPendingOrderConfirmed,
    });

    if (status.matched) continue; // only reporting unresolved tickers

    let bucket: Bucket;
    if (status.reason === "mismatch") {
      if (status.alreadyFullyRecorded) {
        bucket = "MM-1 already fully recorded (bulk re-upload)";
      } else {
        const existingForTicker = existingTrades.filter((t) => normalizeTicker(t.ticker) === ticker);
        const suggestion = suggestRemovalsToReconcile({
          rows: remainingBuysAndSells.map((e) => ({ key: e.key, side: e.candidate.side, shares: e.candidate.shares, price: e.candidate.price, confidence: e.candidate.confidence })),
          existingRemainingShares,
          existingCostBasis: Money.sum(existingForTicker.map((t) => Money.from(t.entryPrice).multiply(t.remainingShares))).toNumber(),
          verifiedUnits: status.verifiedUnits!,
          verifiedAvgCost: status.verifiedAvgCost,
        });
        bucket = suggestion ? "MM-2 exact duplicate/misread row identified" : "MM-3 no exact subset found";
        if (suggestion) hasReconcileSuggestionCount++;
      }
    } else {
      // "no-verification"
      if (status.discrepancySide === "sell") {
        bucket = "NV-1 sell-side (missing historical Buy)";
      } else if (pendingBuyShares < 1e-6) {
        bucket = "NV-2 buy-side surplus already on ledger";
      } else {
        bucket = "NV-3 buy-side surplus among pending rows";
      }
      if (verificationCandidates.length === 0 && g.orderEvidences.length === 0 && !allPendingFromInvoice) noVerificationInputAtAllCount++;
      if (g.orderEvidences.some((e) => e.evidence.status === "fulfilled")) ordersUploadedButIncompleteCount++;
      const lastBalanced = findLastBalancedDate({
        rows: remainingBuysAndSells.map((e) => ({ key: e.key, side: e.candidate.side, shares: e.candidate.shares, date: e.candidate.date })),
        existingRemainingShares,
      });
      if (lastBalanced) hasLastBalancedDateCount++;
    }

    orphanedOrdersEvidenceCount += orphanedEvidenceByTicker.get(ticker)?.length ?? 0;
    if (remainingBuysAndSells.some((e) => wrongTickerHints.has(e.key))) hasWrongTickerHintCount++;
    if (remainingBuysAndSells.some((e) => dateMisreadHints.has(e.key))) hasDateMisreadHintCount++;

    const report = buildTickerConstraintReport(ticker, status, {});
    const factsLine = `Opening ${report.facts.openingShares} + Buy ${report.facts.buyShares} − Sell ${report.facts.sellShares} = Calculated ${report.facts.calculatedRemaining}${report.facts.holdingsRemaining !== undefined ? ` · Holdings ${report.facts.holdingsRemaining}` : ""}`;

    addToBucket(bucket, ticker);
    rows.push({ ticker, status, bucket, factsLine });
  }

  const totalUnresolved = rows.length;
  const lines: string[] = [];
  lines.push(`# Unresolved ticker root-cause report`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} from ${sessionPath}${ledgerPath ? ` + ${ledgerPath}` : " (no ledger backup supplied — existingRemainingShares treated as 0 for every ticker)"}.`);
  lines.push("");
  lines.push(`**Total unresolved tickers: ${totalUnresolved}**`);
  lines.push("");
  lines.push(`## By root cause`);
  lines.push("");
  const sortedBuckets = [...bucketCounts.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [bucket, tickers] of sortedBuckets) {
    const pct = totalUnresolved ? ((tickers.length / totalUnresolved) * 100).toFixed(0) : "0";
    lines.push(`- **${bucket}** — ${tickers.length} ticker(s) (${pct}%): ${tickers.join(", ")}`);
  }
  lines.push("");
  lines.push(`## Per-ticker facts`);
  lines.push("");
  for (const r of rows) {
    lines.push(`- **${r.ticker}** (${r.bucket}): ${r.factsLine}`);
  }
  lines.push("");
  lines.push(`## Cross-cutting signals (may overlap with any bucket above)`);
  lines.push("");
  lines.push(`- No verification input of any kind uploaded (no Position screenshot, no Orders history, no Invoice): ${noVerificationInputAtAllCount}`);
  lines.push(`- Orders/Transactions history uploaded but doesn't corroborate every row: ${ordersUploadedButIncompleteCount}`);
  lines.push(`- Orphaned Orders-history evidence (broker shows a fulfilled order no pending row explains): ${orphanedOrdersEvidenceCount}`);
  lines.push(`- A duplicate/misread row was pinpointed by the exact-subset solver: ${hasReconcileSuggestionCount}`);
  lines.push(`- A last-balanced-date narrowing found (gap starts after a specific date): ${hasLastBalancedDateCount}`);
  lines.push(`- Wrong-ticker hint on at least one row: ${hasWrongTickerHintCount}`);
  lines.push(`- Date-misread hint on at least one row: ${hasDateMisreadHintCount}`);
  lines.push("");
  if (sortedBuckets.length > 0) {
    const [topBucket, topTickers] = sortedBuckets[0];
    lines.push(`## Single highest-leverage change`);
    lines.push("");
    lines.push(`**${topBucket}** accounts for ${topTickers.length} of ${totalUnresolved} unresolved tickers (${((topTickers.length / totalUnresolved) * 100).toFixed(0)}%) — the largest single bucket in this dataset. Affected: ${topTickers.join(", ")}.`);
  }

  const report = lines.join("\n");
  console.log(report);
  writeFileSync("unresolved-tickers-report.md", report + "\n");
  console.error(`\nWrote unresolved-tickers-report.md`);
}

main();

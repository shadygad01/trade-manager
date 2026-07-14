import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { Trade } from "@domain/entities/Trade";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { isRetracted, resolveCurrentTicker } from "../rawTransactionFolds";
import { resolveCurrentPortfolioId } from "../commitEngine";
import { canonicalKey } from "../ledgerRebuild";
import { authorityRank } from "../evidenceAuthority";
import { timesConflict } from "../duplicateDetection";

/**
 * Evidence-only. Never called by, and never calls into, reconciliation.ts,
 * commitEngine.ts's `reconcileDuplicateAuthority`/`commitTicker`, or
 * reconciliationSweep.ts — this module makes no retract/keep/commit
 * decision and writes nothing. It exists purely to make the exact same
 * canonicalKey grouping those functions act on (and the same twin-lot/tie
 * guards `reconcileDuplicateAuthority` applies before acting) VISIBLE,
 * because none of them expose it today. Where it mirrors a check from
 * `reconcileDuplicateAuthority` (commitEngine.ts) — the twin-lot guard, the
 * tie rule — it is a deliberate read-only replica, not a shared import,
 * since this module must not import anything that could ever be mistaken
 * for touching the real decision path; the mirrored logic is called out at
 * each site below so it stays traceable back to its source of truth.
 *
 * `resolveCurrentPortfolioId` is the one real import from commitEngine.ts —
 * an already-exported, pure, read-only fold (no different from
 * `isRetracted`/`resolveCurrentTicker`, which every reconciliation surface
 * already shares), reused rather than duplicated for the one place this
 * module needs it: telling whether a ticker would even reach the sweep's
 * per-ticker loop.
 */

export interface CanonicalGroupFactEvidence {
  id: string;
  kind: "BuyExecution" | "SellExecution";
  source: string;
  authorityRank: number;
  retracted: boolean;
  executionDate: string;
  executionTime?: string;
  shares: number;
  price: number;
  portfolioId: string | undefined;
}

export type CanonicalGroupLabel =
  | "singleton group"
  | "orphaned backfill"
  | "duplicate-authority group"
  | "skipped: tie"
  | "skipped: multiple live Trades"
  | "skipped: conflicting execution time"
  | "matching retracted higher-authority fact";

export interface CanonicalGroupEvidence {
  canonicalKey: string;
  facts: CanonicalGroupFactEvidence[];
  liveCount: number;
  retractedCount: number;
  labels: CanonicalGroupLabel[];
}

export interface TickerReconciliationEvidence {
  ticker: string;
  groups: CanonicalGroupEvidence[];
  /**
   * Mirrors exactly the predicate reconciliationSweep.ts's
   * `enumerateLiveTickerPortfolioPairs` uses to decide whether a ticker
   * gets a `commitTicker` call at all: at least one live Buy/Sell fact
   * whose resolved ticker matches AND whose portfolio resolves. Computed
   * fresh against the CURRENT fact log, not read from any persisted record
   * of a past sweep run (none exists) — so this answers "would a sweep run
   * right now include this ticker", which is the only thing knowable from
   * the fact log itself.
   */
  wouldEnterSweepPipeline: boolean;
}

function toFactEvidence(all: RawTransaction[], t: RawTransaction): CanonicalGroupFactEvidence {
  const p = t.payload as BuyExecutionPayload | SellExecutionPayload;
  return {
    id: t.id,
    kind: t.kind as "BuyExecution" | "SellExecution",
    source: t.source,
    authorityRank: authorityRank(t.source),
    retracted: isRetracted(all, t.id),
    executionDate: p.executionDate,
    executionTime: p.executionTime,
    shares: p.shares,
    price: p.price,
    portfolioId: resolveCurrentPortfolioId(all, t),
  };
}

/** Every ticker any live or retracted Buy/Sell fact currently resolves to — the full population a per-ticker summary must cover so none can be silently absent from it. */
export function listAllTickers(all: RawTransaction[]): string[] {
  const tickers = new Set<string>();
  for (const t of all) {
    if (t.kind !== "BuyExecution" && t.kind !== "SellExecution") continue;
    const resolved = resolveCurrentTicker(all, t);
    if (resolved !== undefined) tickers.add(normalizeTicker(resolved));
  }
  return [...tickers].sort();
}

export function buildTickerReconciliationEvidence(
  all: RawTransaction[],
  trades: Trade[],
  rawTicker: string,
): TickerReconciliationEvidence {
  const ticker = normalizeTicker(rawTicker);

  // Live AND retracted — a strict superset of what either reconciliation
  // surface's own "live" set contains, so a retracted fact (needed to
  // answer "was there ever a higher-authority match?") is never dropped.
  const candidates = all.filter((t) => {
    if (t.kind !== "BuyExecution" && t.kind !== "SellExecution") return false;
    const resolved = resolveCurrentTicker(all, t);
    return resolved !== undefined && normalizeTicker(resolved) === ticker;
  });

  const byKey = new Map<string, RawTransaction[]>();
  for (const t of candidates) {
    const p = t.payload as BuyExecutionPayload | SellExecutionPayload;
    const key = canonicalKey({
      side: t.kind === "BuyExecution" ? "BUY" : "SELL",
      ticker,
      date: p.executionDate,
      shares: p.shares,
      price: p.price,
    });
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }

  // Read-only replica of reconcileDuplicateAuthority's own twin-lot guard
  // (commitEngine.ts: "a canonicalKey legitimately claimed by 2+ live Trade
  // rows is twin-lot-eligible by definition") — display only, decides
  // nothing.
  const tradeCountByKey = new Map<string, number>();
  for (const trade of trades) {
    if (normalizeTicker(trade.ticker) !== ticker) continue;
    const key = canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice });
    tradeCountByKey.set(key, (tradeCountByKey.get(key) ?? 0) + 1);
  }
  const buyKeysWithMultipleTrades = new Set([...tradeCountByKey.entries()].filter(([, count]) => count >= 2).map(([key]) => key));

  const groups: CanonicalGroupEvidence[] = [];
  for (const [key, facts] of byKey.entries()) {
    const factEvidence = facts.map((t) => toFactEvidence(all, t));
    const live = factEvidence.filter((f) => !f.retracted);
    const retracted = factEvidence.filter((f) => f.retracted);
    const labels: CanonicalGroupLabel[] = [];

    if (live.length <= 1) {
      labels.push("singleton group");
      if (live.length === 1 && live[0].source === "backfill") labels.push("orphaned backfill");
    } else {
      const maxRank = Math.max(...live.map((f) => f.authorityRank));
      if (live.some((f) => f.authorityRank < maxRank)) labels.push("duplicate-authority group");
      if (live.filter((f) => f.authorityRank === maxRank).length > 1) labels.push("skipped: tie");

      // Same-kind guard as reconcileDuplicateAuthority: the twin-lot check
      // only ever applies to the BuyExecution side.
      if (facts[0].kind === "BuyExecution" && buyKeysWithMultipleTrades.has(key)) {
        labels.push("skipped: multiple live Trades");
      }

      const timeOf = (t: RawTransaction) => (t.payload as BuyExecutionPayload | SellExecutionPayload).executionTime;
      const hasConflictingTwin = facts.some((a, i) => facts.some((b, j) => i < j && timesConflict(timeOf(a), timeOf(b))));
      if (hasConflictingTwin) labels.push("skipped: conflicting execution time");
    }

    if (live.length > 0 && retracted.length > 0) {
      const maxLiveRank = Math.max(...live.map((f) => f.authorityRank));
      if (retracted.some((f) => f.authorityRank > maxLiveRank)) labels.push("matching retracted higher-authority fact");
    }

    groups.push({ canonicalKey: key, facts: factEvidence, liveCount: live.length, retractedCount: retracted.length, labels });
  }
  groups.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));

  const wouldEnterSweepPipeline = candidates.some(
    (t) => !isRetracted(all, t.id) && resolveCurrentPortfolioId(all, t) !== undefined,
  );

  return { ticker, groups, wouldEnterSweepPipeline };
}

export interface TickerSummaryEvidence {
  ticker: string;
  wouldEnterSweepPipeline: boolean;
  liveFactCount: number;
  retractedFactCount: number;
  groupCount: number;
  singletonGroupCount: number;
  duplicateAuthorityGroupCount: number;
  orphanedBackfillGroupCount: number;
  matchingRetractedHigherAuthorityGroupCount: number;
}

export function summarizeTicker(evidence: TickerReconciliationEvidence): TickerSummaryEvidence {
  let liveFactCount = 0;
  let retractedFactCount = 0;
  let singletonGroupCount = 0;
  let duplicateAuthorityGroupCount = 0;
  let orphanedBackfillGroupCount = 0;
  let matchingRetractedHigherAuthorityGroupCount = 0;

  for (const group of evidence.groups) {
    liveFactCount += group.liveCount;
    retractedFactCount += group.retractedCount;
    if (group.labels.includes("singleton group")) singletonGroupCount += 1;
    if (group.labels.includes("duplicate-authority group")) duplicateAuthorityGroupCount += 1;
    if (group.labels.includes("orphaned backfill")) orphanedBackfillGroupCount += 1;
    if (group.labels.includes("matching retracted higher-authority fact")) matchingRetractedHigherAuthorityGroupCount += 1;
  }

  return {
    ticker: evidence.ticker,
    wouldEnterSweepPipeline: evidence.wouldEnterSweepPipeline,
    liveFactCount,
    retractedFactCount,
    groupCount: evidence.groups.length,
    singletonGroupCount,
    duplicateAuthorityGroupCount,
    orphanedBackfillGroupCount,
    matchingRetractedHigherAuthorityGroupCount,
  };
}

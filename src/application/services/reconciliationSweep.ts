import type { DiagnosticsRecorder } from "@domain/repositories";
import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload } from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { commitTicker, resolveCurrentPortfolioId, type CommitEngineRepos } from "./commitEngine";
import { isRetracted, resolveCurrentTicker } from "./rawTransactionFolds";
import { canonicalKey } from "./ledgerRebuild";
import type { LegacyLedgerRepos } from "./ledgerProjection";

/**
 * Manual maintenance operation for the gap this codebase's investigation
 * found (docs/ROADMAP.md): `reconcileDuplicateAuthority` only ever runs
 * reactively, inside `commitTicker`, on a NEW write for that ticker — it has
 * no path back to a duplicate-authority pair that was already sitting in the
 * database before the fix shipped (e.g. every `source: "backfill"` fact
 * written by the one-time silent boot backfill, which never triggers a
 * commit). This is that missing retroactive pass, deliberately shaped as a
 * user-initiated, one-shot sweep rather than anything automatic — no
 * startup hook, no background job — per the same "no unattended
 * full-portfolio rewrite" boundary `reconcileDuplicateAuthority`'s own doc
 * comment already established for itself.
 *
 * Reuses `commitTicker` — the same production entry point every real Buy/
 * Sell/Correction/Retraction write already goes through — for every ticker
 * with live Buy/Sell facts, one ticker at a time, exactly as
 * `appendAndMaybeCommit` would. There is no second reconciliation algorithm
 * here: the actual retract/keep decision is made entirely by
 * `reconcileDuplicateAuthority` as invoked from inside `commitTicker`. This
 * module only adds read-only, before/after bookkeeping — grouping live facts
 * by the same `canonicalKey` reconciliation itself groups by, then diffing
 * which of those fact ids got retracted — purely to produce the report the
 * user reads; it never decides which fact survives.
 *
 * Idempotent by construction: a ticker with nothing left to converge reports
 * zero duplicate groups, zero retracted, zero skipped, and `commitTicker`
 * itself is already a full delete-and-regenerate rebuild — safe to run
 * again at any time, including immediately after a prior run.
 */

export type ReconciliationSweepRepos = CommitEngineRepos & LegacyLedgerRepos;

export interface ReconciliationSweepTickerResult {
  portfolioId: string;
  ticker: string;
  duplicateGroupsFound: number;
  factsRetracted: number;
  factsSkipped: number;
  error?: string;
  /** `err.name`/`err.stack`/`err.cause`, captured only on failure — surfaced directly in the panel so pinning down a real browser-only failure (e.g. Dexie's own "Transaction committed too early") doesn't require the user to dig through DevTools themselves. */
  errorDetail?: string;
}

export interface ReconciliationSweepReport {
  tickersScanned: number;
  duplicateGroupsFound: number;
  factsRetracted: number;
  factsSkipped: number;
  errors: { portfolioId: string; ticker: string; message: string }[];
  perTicker: ReconciliationSweepTickerResult[];
}

/** `err.stack` (call chain) plus `err.cause`'s own message, when present — the two things most likely to reveal exactly which Dexie call a generic-message browser error (e.g. PrematureCommitError) actually originated from. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.stack ?? `${err.name}: ${err.message}`];
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) parts.push(`Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`);
  else if (cause !== undefined) parts.push(`Caused by: ${String(cause)}`);
  return parts.join("\n");
}

function liveBuySellFacts(all: RawTransaction[], ticker: string): RawTransaction[] {
  return all.filter((t) => {
    if (t.kind !== "BuyExecution" && t.kind !== "SellExecution") return false;
    if (isRetracted(all, t.id)) return false;
    const resolved = resolveCurrentTicker(all, t);
    return resolved !== undefined && normalizeTicker(resolved) === ticker;
  });
}

/** Same grouping key `reconcileDuplicateAuthority` (commitEngine.ts) itself groups by — reused, not reimplemented, so a "duplicate group" here always means exactly what reconciliation would act on. */
function groupByCanonicalKey(ticker: string, facts: RawTransaction[]): Map<string, RawTransaction[]> {
  const byKey = new Map<string, RawTransaction[]>();
  for (const t of facts) {
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
  return byKey;
}

/** Read-only tally for the report only — makes no retract/keep decision. Every canonicalKey group with more than one live member, the "before" state the caller diffs against post-commit state per GROUP (not just a flat fact count) to tell a clean resolution (exactly one survivor left live — the intended, expected outcome) apart from a group still left ambiguous (a tie, a twin lot, or a genuinely conflicting execution time — see reconcileDuplicateAuthority's own doc comment for why those are never auto-resolved). */
function duplicateGroups(all: RawTransaction[], ticker: string): RawTransaction[][] {
  const byKey = groupByCanonicalKey(ticker, liveBuySellFacts(all, ticker));
  return [...byKey.values()].filter((facts) => facts.length > 1);
}

/** Every (portfolioId, ticker) pair with at least one live, portfolio-assigned Buy/Sell fact — the full set `commitTicker` needs to be called for, one pair at a time. A fact with no resolved portfolio yet (freshly imported, not yet assigned) has nothing to commit and is left out, same as `relevantTradeTransactions` would leave it out of any real commit today. */
async function enumerateLiveTickerPortfolioPairs(
  repos: ReconciliationSweepRepos,
): Promise<{ portfolioId: string; ticker: string }[]> {
  const all = await repos.rawTransactions.getAll();
  const pairs = new Map<string, { portfolioId: string; ticker: string }>();
  for (const t of all) {
    if (t.kind !== "BuyExecution" && t.kind !== "SellExecution") continue;
    if (isRetracted(all, t.id)) continue;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined) continue;
    const resolvedPortfolioId = resolveCurrentPortfolioId(all, t);
    if (resolvedPortfolioId === undefined) continue;
    const ticker = normalizeTicker(resolvedTicker);
    pairs.set(`${resolvedPortfolioId}|${ticker}`, { portfolioId: resolvedPortfolioId, ticker });
  }
  return [...pairs.values()];
}

/**
 * `commitTicker` opens its own Dexie `db.transaction()` for the cache/legacy
 * write (commitEngine.ts's `writeProjection`) after already having awaited
 * `projectInWorker` — a real cross-thread `postMessage` round trip in the
 * browser. That's a genuine async gap outside Dexie's own promise zone, and
 * under concurrent commits (many tickers converging in one sweep pass, or
 * two commits for the same ticker landing close together) it can race
 * IndexedDB's native auto-commit and surface as Dexie's own
 * "PrematureCommitError: Transaction committed too early" — a transient
 * timing failure, not a data problem (confirmed by user reports: the same
 * ticker fails on one sweep run and succeeds cleanly on the next). A fresh
 * `commitTicker` call starts its own worker round trip and its own
 * transaction from scratch, so retrying is a real second chance, not a
 * no-op — narrowly scoped to this exact Dexie error message so any other
 * failure (a genuine data/read error, e.g. the isolation test below) still
 * surfaces immediately with no retry delay.
 */
function isTransientDexieCommitRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /transaction/i.test(message) && /(too early|committed too early|premature)/i.test(message);
}

async function commitTickerWithRetry(
  repos: ReconciliationSweepRepos,
  portfolioId: string,
  ticker: string,
  diagnostics?: DiagnosticsRecorder,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await commitTicker(repos, portfolioId, ticker, diagnostics, { repairOfficialBrokerAllocations: true });
      return;
    } catch (err) {
      if (attempt === maxAttempts || !isTransientDexieCommitRace(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export async function runReconciliationSweep(
  repos: ReconciliationSweepRepos,
  diagnostics?: DiagnosticsRecorder,
): Promise<ReconciliationSweepReport> {
  const pairs = await enumerateLiveTickerPortfolioPairs(repos);
  const perTicker: ReconciliationSweepTickerResult[] = [];
  const errors: ReconciliationSweepReport["errors"] = [];

  for (const { portfolioId, ticker } of pairs) {
    try {
      const before = await repos.rawTransactions.getAll();
      const groupsBefore = duplicateGroups(before, ticker);

      // The real production choke point — identical to what a fresh Buy/Sell
      // write for this ticker would trigger via appendAndMaybeCommit, which
      // is what actually runs reconcileDuplicateAuthority (with full
      // trades/allocations access, so its twin-lot guard applies exactly as
      // it would in normal operation). Wrapped with a narrow, same-error-only
      // retry — see commitTickerWithRetry's doc comment.
      await commitTickerWithRetry(repos, portfolioId, ticker, diagnostics);

      const after = await repos.rawTransactions.getAll();
      let factsRetracted = 0;
      let factsSkipped = 0;
      for (const group of groupsBefore) {
        const stillLive = group.filter((f) => !isRetracted(after, f.id));
        factsRetracted += group.length - stillLive.length;
        // Exactly one fact left live is the expected, clean outcome (the
        // survivor) — not a skip. More than one still live means the group
        // stayed ambiguous (tie/twin-lot/conflicting-time guard), which IS
        // worth flagging back to the user for manual investigation.
        if (stillLive.length > 1) factsSkipped += stillLive.length;
      }

      perTicker.push({ portfolioId, ticker, duplicateGroupsFound: groupsBefore.length, factsRetracted, factsSkipped });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ portfolioId, ticker, message });
      perTicker.push({
        portfolioId,
        ticker,
        duplicateGroupsFound: 0,
        factsRetracted: 0,
        factsSkipped: 0,
        error: message,
        errorDetail: describeError(err),
      });
    }
  }

  return {
    tickersScanned: new Set(pairs.map((p) => p.ticker)).size,
    duplicateGroupsFound: perTicker.reduce((sum, r) => sum + r.duplicateGroupsFound, 0),
    factsRetracted: perTicker.reduce((sum, r) => sum + r.factsRetracted, 0),
    factsSkipped: perTicker.reduce((sum, r) => sum + r.factsSkipped, 0),
    errors,
    perTicker,
  };
}

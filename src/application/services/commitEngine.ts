import type { RawTransactionRepository, CommittedLedgerRepository } from "@domain/repositories";
import {
  createRawTransaction,
  type RawTransaction,
  type PortfolioAssignmentPayload,
  type CorrectionPayload,
  type RetractionPayload,
} from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { verifyAll } from "./verificationEngine";
import { generateLedgerEvents } from "./ledgerEngine";
import { generateAllocations } from "./allocationEngine";
import { isRetracted } from "./rawTransactionFolds";
import { ensureLegacyFactsExist, projectLegacyTicker, type LegacyLedgerRepos } from "./ledgerProjection";

/**
 * Commit Engine: the only code path that ever writes to ledgerCache /
 * allocationsCache. There is no separate "rebuild" command — `commitTicker`
 * IS the rebuild, and it always runs in full: delete every cached row for
 * (portfolioId, ticker) and regenerate from scratch, never an incremental
 * patch. `shouldCommit` is the trigger condition a caller evaluates after
 * appending any RawTransaction that touches a ticker: commit only once
 * every Buy/Sell transaction for that ticker has reached a terminal
 * verdict (Verified or Rejected) — a "Needs Review" transaction blocks the
 * whole ticker's commit until it's resolved.
 *
 * Scope note: this reads the CURRENT raw-transaction set as-is except for
 * PortfolioAssignment (see resolveCurrentPortfolioId), a Correction's
 * `ticker` patch (see resolveCurrentTicker), and any Retraction (see
 * isRetracted) — those three are resolved/folded before a transaction is
 * ever considered relevant to a ticker's commit. Folding the REST of the
 * Correction vocabulary (date/price/fees/etc.) into "the current view of a
 * fact" is a later increment, not yet wired in here. Documented rather than
 * silently assumed correct.
 */

export interface CommitEngineRepos {
  rawTransactions: RawTransactionRepository;
  committedLedger: CommittedLedgerRepository;
}

const NON_SUBJECT_KINDS = new Set(["PortfolioAssignment", "Correction", "Retraction"]);

/**
 * A raw transaction's own `portfolioId` field is set once, at write time,
 * and never changes (immutability) — a LATER portfolio assignment (e.g.
 * Import picking a portfolio for a ticker after the fact) is its own
 * separate PortfolioAssignment raw transaction referencing the original by
 * id, not an edit to it. This resolves "what portfolio does this
 * transaction currently belong to", folding in the latest (highest `seq`)
 * PortfolioAssignment targeting it, if any — falling back to the
 * transaction's own field when none exists.
 */
function resolveCurrentPortfolioId(all: RawTransaction[], transaction: RawTransaction): string | undefined {
  const assignments = all.filter(
    (t) => t.kind === "PortfolioAssignment" && (t.payload as PortfolioAssignmentPayload).targetId === transaction.id
  );
  if (assignments.length === 0) return transaction.portfolioId;
  const latest = assignments.reduce((a, b) => (b.seq > a.seq ? b : a));
  return (latest.payload as PortfolioAssignmentPayload).portfolioId;
}

/**
 * Same fold rule as resolveCurrentPortfolioId, generalized to a second
 * field: a transaction's own `ticker` is set once at write time and never
 * changes (immutability) — a later correction (e.g. fixing an OCR-garbled
 * ticker) is its own separate Correction raw transaction referencing the
 * original by id, not an edit to it. `excludeCorrectionId` resolves what the
 * ticker was immediately BEFORE one specific correction landed, so a caller
 * reacting to that correction's arrival can tell which two tickers' caches
 * need re-deriving (see appendAndMaybeCommit's Correction branch).
 */
function resolveCurrentTicker(all: RawTransaction[], transaction: RawTransaction, excludeCorrectionId?: string): string | undefined {
  const corrections = all.filter(
    (t) =>
      t.kind === "Correction" &&
      t.id !== excludeCorrectionId &&
      (t.payload as CorrectionPayload).targetId === transaction.id &&
      (t.payload as CorrectionPayload).patch.ticker !== undefined
  );
  if (corrections.length === 0) return transaction.ticker;
  const latest = corrections.reduce((a, b) => (b.seq > a.seq ? b : a));
  return (latest.payload as CorrectionPayload).patch.ticker;
}

/** Exported for lotManager.ts, which needs the identical "what facts currently belong to this ticker" resolution (portfolio/ticker folds, retraction exclusion) but reads ALL of them regardless of import-verification verdict — a Lot Manager action is the user's own direct, deliberate statement, not an OCR read awaiting corroboration. */
export async function relevantTradeTransactions(repos: CommitEngineRepos, portfolioId: string, ticker: string) {
  const normalizedTicker = normalizeTicker(ticker);
  // Can't use getByPortfolio here: a transaction's OWN portfolioId field may
  // still be undefined even though it's now effectively assigned via a
  // PortfolioAssignment — resolution has to run over the full set. Bounded
  // by the same small-N assumption the rest of this system already accepts.
  const all = await repos.rawTransactions.getAll();
  return all.filter((t) => {
    if (NON_SUBJECT_KINDS.has(t.kind)) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== normalizedTicker) return false;
    return resolveCurrentPortfolioId(all, t) === portfolioId;
  });
}

/**
 * `commitTicker`/`shouldCommit` always verify the COMPLETE relevant
 * transaction set for a ticker together, as one batch — never an
 * incremental "just this new row" check against a prior baseline. So unlike
 * a caller that's verifying one new pending transaction against already-
 * settled history, there is no "shares already on the ledger before this
 * batch" here: the batch already covers everything. Reading the cache's
 * current holdings as that baseline would double-count (the cache reflects
 * a PRIOR commit computed from a subset of these same transactions), which
 * is exactly what caused a full-history wipe on re-commit before this was
 * fixed — caught by commitEngine.test.ts's re-commit test, not by review.
 */
const NO_EXISTING_POSITIONS: never[] = [];

export async function shouldCommit(repos: CommitEngineRepos, portfolioId: string, ticker: string): Promise<boolean> {
  const relevant = await relevantTradeTransactions(repos, portfolioId, ticker);
  if (!relevant.some((t) => t.kind === "BuyExecution" || t.kind === "SellExecution")) return false;

  // The FULL relevant set goes to verifyAll, not just Buy/Sell: the engine
  // itself only ever produces verdicts for Buy/Sell rows, but it reads
  // PositionVerificationCapture/OrderEvidenceCapture facts as corroboration
  // — without them here, a broker screenshot that reconciles a ticker
  // exactly could never terminal-ize its commit (Phase 9.8 fix; before it,
  // only closed-position/invoice/cross-verified paths ever fired here).
  const verdicts = verifyAll({ transactions: relevant, positions: NO_EXISTING_POSITIONS });
  return [...verdicts.values()].every((v) => v.verdict !== "Needs Review");
}

export async function commitTicker(repos: CommitEngineRepos & Partial<LegacyLedgerRepos>, portfolioId: string, ticker: string): Promise<void> {
  const normalizedTicker = normalizeTicker(ticker);

  // Phase 9.8: when the caller's repos bundle carries the legacy tables (the
  // app's real singleton always does; bare CommitEngineRepos test bundles
  // don't), the commit ALSO projects its output onto Trade/TradeAllocation —
  // the tables the UI reads — making the legacy ledger a derived view that
  // auto-corrects whenever better historical facts reach a terminal verdict.
  // Gap-backfill runs FIRST so any legacy row that predates its fact writer
  // gets a fact before projection could ever mistake it for stale data; if
  // that step fails, projection is skipped entirely (never run against a
  // possibly-incomplete fact set), while the cache commit proceeds as always.
  let projection: (CommitEngineRepos & LegacyLedgerRepos) | undefined =
    repos.trades !== undefined && repos.allocations !== undefined ? (repos as CommitEngineRepos & LegacyLedgerRepos) : undefined;
  if (projection) {
    try {
      await ensureLegacyFactsExist(projection, portfolioId, normalizedTicker);
    } catch (err) {
      console.error("ensureLegacyFactsExist failed — skipping legacy projection for this commit:", err);
      projection = undefined;
    }
  }

  const relevant = await relevantTradeTransactions(repos, portfolioId, normalizedTicker);
  const tradeTransactions = relevant.filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution");
  const decisionTransactions = relevant.filter((t) => t.kind === "SellAllocationDecision");

  // Full relevant set, same reason as shouldCommit: capture facts are
  // corroboration inputs; verdicts still only ever cover Buy/Sell rows.
  const verdicts = verifyAll({ transactions: relevant, positions: NO_EXISTING_POSITIONS });
  const verifiedTransactions = tradeTransactions.filter((t) => verdicts.get(t.id)?.verdict === "Verified");

  const events = generateLedgerEvents(verifiedTransactions);
  const allocations = generateAllocations(events, decisionTransactions);

  await repos.committedLedger.commitTicker({ portfolioId, ticker: normalizedTicker, events, allocations });

  // Projection only ever runs on a TERMINAL verdict set. commitTicker is
  // also force-called on Retraction/Correction regardless of shouldCommit
  // (to clear a stale cache), and in that path a still-Needs-Review fact
  // produces no lot — projecting then would delete a legitimate legacy row
  // merely because its corroboration hasn't arrived yet. An empty set is
  // terminal (everything retracted IS a settled state); an undecided one is
  // not.
  const terminal = [...verdicts.values()].every((v) => v.verdict !== "Needs Review");
  if (projection && terminal) {
    try {
      await projectLegacyTicker(projection, portfolioId, normalizedTicker, events, allocations);
    } catch (err) {
      console.error("projectLegacyTicker failed (cache commit already applied, legacy rows unchanged):", err);
    }
  }
}

/**
 * The reactive trigger: append a raw transaction, then commit its ticker if
 * that just made the whole ticker's verification state terminal. This is
 * the ONLY place a commit is ever triggered — no scheduled job, no manual
 * "rebuild" button, matching the Ledger rewrite's "no rebuild command"
 * rule. Every writer should call this instead of `rawTransactions.append`
 * directly once it's ready to participate in the new architecture.
 *
 * A PortfolioAssignment's own envelope carries no portfolioId/ticker (it
 * targets another row by id) — its trigger check has to look up what it
 * just assigned instead. Any other transaction with no portfolioId (e.g.
 * everything Import writes today, before an assignment exists) or no
 * ticker has nothing to commit yet: a correct, expected no-op, not a gap.
 */
export async function appendAndMaybeCommit(repos: CommitEngineRepos, transaction: Omit<RawTransaction, "seq">): Promise<RawTransaction> {
  const appended = await repos.rawTransactions.append(transaction);

  if (appended.kind === "PortfolioAssignment") {
    const { targetId, portfolioId } = appended.payload as PortfolioAssignmentPayload;
    const target = await repos.rawTransactions.getById(targetId);
    if (target?.ticker !== undefined && (await shouldCommit(repos, portfolioId, target.ticker))) {
      await commitTicker(repos, portfolioId, target.ticker);
    }
  } else if (appended.kind === "Correction") {
    // A ticker correction moves its target between two tickers' relevant
    // sets — unlike the shouldCommit-gated branches below, both the ticker
    // it just left and the ticker it just joined must re-derive their cache
    // immediately (never left stale), regardless of whether every other
    // pending row on either ticker has reached a terminal verdict yet.
    const { targetId, patch } = appended.payload as CorrectionPayload;
    if (patch.ticker !== undefined) {
      const target = await repos.rawTransactions.getById(targetId);
      if (target) {
        const all = await repos.rawTransactions.getAll();
        const resolvedPortfolioId = resolveCurrentPortfolioId(all, target);
        if (resolvedPortfolioId !== undefined) {
          const priorTicker = resolveCurrentTicker(all, target, appended.id);
          const currentTicker = resolveCurrentTicker(all, target);
          const affectedTickers = new Set([priorTicker, currentTicker].filter((t): t is string => t !== undefined));
          for (const affectedTicker of affectedTickers) {
            await commitTicker(repos, resolvedPortfolioId, affectedTicker);
          }
        }
      }
    }
  } else if (appended.kind === "Retraction") {
    // Same reasoning as Correction above: a retraction must force its
    // ticker's cache to drop the retracted row right away, even if the rest
    // of the ticker's batch isn't otherwise terminal.
    const { targetId } = appended.payload as RetractionPayload;
    const target = await repos.rawTransactions.getById(targetId);
    if (target?.ticker !== undefined) {
      const all = await repos.rawTransactions.getAll();
      const resolvedPortfolioId = resolveCurrentPortfolioId(all, target);
      const resolvedTicker = resolveCurrentTicker(all, target);
      if (resolvedPortfolioId !== undefined && resolvedTicker !== undefined) {
        await commitTicker(repos, resolvedPortfolioId, resolvedTicker);
      }
    }
  } else if (appended.portfolioId !== undefined && appended.ticker !== undefined) {
    if (await shouldCommit(repos, appended.portfolioId, appended.ticker)) {
      await commitTicker(repos, appended.portfolioId, appended.ticker);
    }
  }
  return appended;
}

/**
 * Assigns every still-unassigned raw transaction for `ticker` to
 * `portfolioId` — one PortfolioAssignment fact per target, never a batch
 * edit, so each stays independently traceable. This is what Import's
 * existing per-ticker portfolio picker calls once the user resolves which
 * portfolio a ticker's extracted rows belong to; it's the only place a
 * freshly-imported (portfolioId-less) raw transaction ever gets one.
 */
export async function assignPortfolio(repos: CommitEngineRepos, ticker: string, portfolioId: string): Promise<void> {
  const normalizedTicker = normalizeTicker(ticker);
  const all = await repos.rawTransactions.getAll();
  const unassigned = all.filter((t) => {
    if (NON_SUBJECT_KINDS.has(t.kind)) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== normalizedTicker) return false;
    return resolveCurrentPortfolioId(all, t) === undefined;
  });

  for (const target of unassigned) {
    const payload: PortfolioAssignmentPayload = { targetId: target.id, portfolioId };
    await appendAndMaybeCommit(repos, createRawTransaction({ kind: "PortfolioAssignment", source: "manual", payload }));
  }
}

/**
 * Retracts one raw transaction — used when the pre-migration UI deletes or
 * voids a fact directly (e.g. TradeService.deleteTrade), so the new
 * architecture's next commit for that ticker can't resurrect something the
 * user just removed. `targetId` must be the RawTransaction's own id, not a
 * derived LedgerEvent id.
 */
export async function retractRawTransaction(repos: CommitEngineRepos, targetId: string, reason?: string): Promise<void> {
  const payload: RetractionPayload = { targetId, reason };
  await appendAndMaybeCommit(repos, createRawTransaction({ kind: "Retraction", source: "manual", payload }));
}

/**
 * Corrects every still-live raw transaction currently resolving to
 * `oldTicker` (Buy/Sell executions, evidence, verifications, dividends —
 * anything ticker-bearing) over to `newTicker` — the raw-transaction twin of
 * TradeService.renameTickerEverywhere, so a ticker rename in the
 * pre-migration UI doesn't leave this architecture's copy permanently
 * orphaned under the old, now-corrected-away ticker.
 */
export async function renameRawTransactionsTicker(repos: CommitEngineRepos, oldTicker: string, newTicker: string): Promise<number> {
  const normalizedOld = normalizeTicker(oldTicker);
  const normalizedNew = normalizeTicker(newTicker);
  if (!normalizedNew || normalizedNew === normalizedOld) return 0;

  const all = await repos.rawTransactions.getAll();
  const targets = all.filter((t) => {
    if (t.ticker === undefined) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    return resolvedTicker !== undefined && normalizeTicker(resolvedTicker) === normalizedOld;
  });

  for (const target of targets) {
    const payload: CorrectionPayload = { targetId: target.id, patch: { ticker: normalizedNew } };
    await appendAndMaybeCommit(repos, createRawTransaction({ kind: "Correction", source: "manual", payload }));
  }
  return targets.length;
}

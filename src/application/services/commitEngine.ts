import type { RawTransactionRepository, CommittedLedgerRepository } from "@domain/repositories";
import { createRawTransaction, type RawTransaction, type PortfolioAssignmentPayload } from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { verifyAll } from "./verificationEngine";
import { generateLedgerEvents } from "./ledgerEngine";
import { generateAllocations } from "./allocationEngine";

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
 * PortfolioAssignment, which IS resolved (see resolveCurrentPortfolioId) —
 * folding the rest of the Correction/Retraction vocabulary into "the
 * current view of a fact" is a later increment, not yet wired in here.
 * Documented rather than silently assumed correct.
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

async function relevantTradeTransactions(repos: CommitEngineRepos, portfolioId: string, ticker: string) {
  const normalizedTicker = normalizeTicker(ticker);
  // Can't use getByPortfolio here: a transaction's OWN portfolioId field may
  // still be undefined even though it's now effectively assigned via a
  // PortfolioAssignment — resolution has to run over the full set. Bounded
  // by the same small-N assumption the rest of this system already accepts.
  const all = await repos.rawTransactions.getAll();
  return all.filter((t) => {
    if (NON_SUBJECT_KINDS.has(t.kind)) return false;
    if (t.ticker === undefined || normalizeTicker(t.ticker) !== normalizedTicker) return false;
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
  const transactions = (await relevantTradeTransactions(repos, portfolioId, ticker)).filter(
    (t) => t.kind === "BuyExecution" || t.kind === "SellExecution"
  );
  if (transactions.length === 0) return false;

  const verdicts = verifyAll({ transactions, positions: NO_EXISTING_POSITIONS });
  return [...verdicts.values()].every((v) => v.verdict !== "Needs Review");
}

export async function commitTicker(repos: CommitEngineRepos, portfolioId: string, ticker: string): Promise<void> {
  const normalizedTicker = normalizeTicker(ticker);
  const relevant = await relevantTradeTransactions(repos, portfolioId, normalizedTicker);
  const tradeTransactions = relevant.filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution");
  const decisionTransactions = relevant.filter((t) => t.kind === "SellAllocationDecision");

  const verdicts = verifyAll({ transactions: tradeTransactions, positions: NO_EXISTING_POSITIONS });
  const verifiedTransactions = tradeTransactions.filter((t) => verdicts.get(t.id)?.verdict === "Verified");

  const events = generateLedgerEvents(verifiedTransactions);
  const allocations = generateAllocations(events, decisionTransactions);

  await repos.committedLedger.commitTicker({ portfolioId, ticker: normalizedTicker, events, allocations });
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
  const unassigned = all.filter(
    (t) =>
      !NON_SUBJECT_KINDS.has(t.kind) &&
      t.ticker !== undefined &&
      normalizeTicker(t.ticker) === normalizedTicker &&
      resolveCurrentPortfolioId(all, t) === undefined
  );

  for (const target of unassigned) {
    const payload: PortfolioAssignmentPayload = { targetId: target.id, portfolioId };
    await appendAndMaybeCommit(repos, createRawTransaction({ kind: "PortfolioAssignment", source: "manual", payload }));
  }
}

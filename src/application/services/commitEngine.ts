import type { RawTransactionRepository, CommittedLedgerRepository } from "@domain/repositories";
import type { RawTransaction } from "@domain/entities/RawTransaction";
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
 * Scope note: this reads the CURRENT raw-transaction set as-is. Folding
 * Correction/Retraction chains into "the current view of a fact" (so a
 * corrected/retracted row is excluded before verification and replay) is a
 * later increment, not yet wired in here — every raw transaction present is
 * treated as live. Documented rather than silently assumed correct.
 */

export interface CommitEngineRepos {
  rawTransactions: RawTransactionRepository;
  committedLedger: CommittedLedgerRepository;
}

async function relevantTradeTransactions(repos: CommitEngineRepos, portfolioId: string, ticker: string) {
  const normalizedTicker = normalizeTicker(ticker);
  const all = await repos.rawTransactions.getByPortfolio(portfolioId);
  return all.filter((t) => t.ticker !== undefined && normalizeTicker(t.ticker) === normalizedTicker);
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
 * A transaction with no `portfolioId` (e.g. everything Import writes today
 * — portfolio assignment is a deliberately separate, later step, never
 * inferred at import time) or no `ticker` has nothing to commit yet: this
 * is a correct, expected no-op for those rows, not a gap. It becomes live
 * for a given raw transaction the moment something assigns it a portfolio.
 */
export async function appendAndMaybeCommit(repos: CommitEngineRepos, transaction: Omit<RawTransaction, "seq">): Promise<RawTransaction> {
  const appended = await repos.rawTransactions.append(transaction);
  if (appended.portfolioId !== undefined && appended.ticker !== undefined) {
    if (await shouldCommit(repos, appended.portfolioId, appended.ticker)) {
      await commitTicker(repos, appended.portfolioId, appended.ticker);
    }
  }
  return appended;
}

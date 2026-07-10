import type { RawTransaction, BuyExecutionPayload, SellExecutionPayload, DividendPaymentPayload, CashAdjustmentPayload, DepositWithdrawalPayload, CashResetPayload } from "@domain/entities/RawTransaction";
import { isRetracted } from "./rawTransactionFolds";

/**
 * Cash as a pure projection from cash-affecting RawTransaction facts —
 * mirrors PortfolioService's own imperative cash arithmetic (recordBuy
 * subtracts cost, recordSell adds proceeds, recordDividend/
 * recordCashAdjustment/setCash each apply their own delta) but replayed
 * from the fact log instead of accumulated as mutable state, exactly the
 * same relationship generateLedgerEvents already has to the legacy Trade
 * table.
 *
 * `CashReset` (written by PortfolioService.setCash) is the one fold rule
 * that isn't a simple sum-everything: it's an explicit checkpoint asserting
 * the correct balance as of a point in time — see CashResetPayload's own
 * doc comment. Replay starts from the LATEST non-retracted CashReset's own
 * asserted amount (or 0 if none exists at all) and sums every other
 * cash-affecting fact recorded strictly after it, chronologically by `seq`
 * (the only ordering this app's append-only log ever trusts — never a
 * payload-level date, which is a real-world time that can arrive out of
 * order relative to when it was recorded).
 *
 * NOT wired into any live UI read yet — see docs/EVIDENCE_ARCHITECTURE.md's
 * "Cash projection" section for exactly why: recordDividend/setCash/
 * recordCashAdjustment only started writing these facts this sprint, and
 * backfillRawTransactions's new dividend/cash-adjustment coverage has not
 * yet been RUN against any real, existing portfolio's actual history — only
 * against fake test fixtures. Until that one-time backfill actually
 * executes against the real production database (an operational step this
 * sandboxed session has no access to perform), this projection would
 * under-count every pre-existing portfolio's true cash balance by every
 * dividend/adjustment recorded before this sprint. This function exists,
 * is tested, and is ready — flipping the live read is the one remaining
 * step, gated on that backfill run, not on more code.
 */
export function computeCashProjection(facts: RawTransaction[], portfolioId: string): number {
  const live = facts.filter((f) => f.portfolioId === portfolioId && !isRetracted(facts, f.id));
  const sorted = [...live].sort((a, b) => a.seq - b.seq);

  const lastReset = [...sorted].reverse().find((f) => f.kind === "CashReset");
  const baseline = lastReset ? (lastReset.payload as CashResetPayload).amount : 0;
  const afterReset = lastReset ? sorted.filter((f) => f.seq > lastReset.seq) : sorted;

  let cash = baseline;
  for (const fact of afterReset) {
    switch (fact.kind) {
      case "BuyExecution": {
        const p = fact.payload as BuyExecutionPayload;
        cash -= p.shares * p.price + (p.fees ?? 0) + (p.taxes ?? 0);
        break;
      }
      case "SellExecution": {
        const p = fact.payload as SellExecutionPayload;
        cash += p.shares * p.price - (p.fees ?? 0) - (p.taxes ?? 0);
        break;
      }
      case "DividendPayment":
        cash += (fact.payload as DividendPaymentPayload).amount;
        break;
      case "CashAdjustment":
        cash += (fact.payload as CashAdjustmentPayload).amount;
        break;
      case "Deposit":
        cash += (fact.payload as DepositWithdrawalPayload).amount;
        break;
      case "Withdrawal":
        cash -= (fact.payload as DepositWithdrawalPayload).amount;
        break;
      default:
        break;
    }
  }
  return cash;
}

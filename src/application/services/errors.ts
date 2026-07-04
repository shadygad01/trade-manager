/**
 * Thrown by any service guard that rejects an action because a portfolio's
 * cash balance can't cover it (recordBuy, withdraw, ...). Carries the
 * structured numbers alongside the human-readable message so a caller can
 * offer a real recovery action (e.g. "deposit the shortfall and retry")
 * instead of just displaying the message — this matters most for imported
 * historical trades, where a portfolio's recorded cash often hasn't caught
 * up with everything being backfilled yet.
 */
export class InsufficientCashError extends Error {
  constructor(
    public readonly portfolioId: string,
    public readonly required: number,
    public readonly available: number,
    message: string
  ) {
    super(message);
    this.name = "InsufficientCashError";
  }
}

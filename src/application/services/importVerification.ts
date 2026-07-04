export type TickerMatchReason = "matched" | "no-shares-to-verify" | "no-verification" | "mismatch";

export interface TickerMatchStatus {
  matched: boolean;
  reason: TickerMatchReason;
  netShares: number;
  verifiedUnits?: number;
}

/**
 * Gate for Import's two-phase workflow: nothing gets allocated to a
 * portfolio for a ticker until its extracted share count reconciles exactly
 * against a broker "My Position" screenshot. A ticker with no pending
 * buy/sell candidates at all (a dividend-only or a stray verification-only
 * read) has no share count to reconcile, so it's trivially matched rather
 * than blocked on a screenshot that will never exist for it.
 */
export function checkTickerMatch(params: {
  hasShares: boolean;
  pendingBuyShares: number;
  pendingSellShares: number;
  existingRemainingShares: number;
  verifiedUnits?: number;
}): TickerMatchStatus {
  const netShares = params.existingRemainingShares + params.pendingBuyShares - params.pendingSellShares;

  if (!params.hasShares) {
    return { matched: true, reason: "no-shares-to-verify", netShares, verifiedUnits: params.verifiedUnits };
  }
  if (params.verifiedUnits === undefined) {
    return { matched: false, reason: "no-verification", netShares };
  }
  const matched = Math.abs(netShares - params.verifiedUnits) < 1e-6;
  return { matched, reason: matched ? "matched" : "mismatch", netShares, verifiedUnits: params.verifiedUnits };
}

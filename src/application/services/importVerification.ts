export type TickerMatchReason =
  | "matched"
  | "no-shares-to-verify"
  | "closed-position"
  | "invoice-verified"
  | "no-verification"
  | "mismatch";

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
 *
 * A fully sold-out ticker (net shares reconcile to exactly zero) has the
 * same problem for a different reason: a broker "My Position" screenshot
 * never lists a position with zero units, so one will never be uploaded for
 * it. The buy/sell invoices already extracted (each carrying its own
 * date/price/shares) are the confirmation in that case — there's no current
 * position left to verify against a screenshot.
 *
 * A ticker whose every still-pending Buy/Sell candidate came from a
 * standardized per-trade Invoice (see ThndrParser's Invoice format,
 * `ParsedTradeCandidate.source`) rather than an OCR'd screenshot has a third
 * way out of the same problem: an invoice is a labeled, fixed-layout
 * document trusted as sufficient proof of its own transaction, so it never
 * needs a separate "My Position" recount just to confirm one new buy/sell —
 * requiring one anyway would mean re-screenshotting the whole position on
 * every single invoice import. Only applies when no broker verification
 * exists at all; a screenshot that's actually present and mismatches still
 * blocks, since a real discrepancy (e.g. a duplicate invoice) shouldn't be
 * silently overridden just because this batch happens to be invoice-sourced.
 */
export function checkTickerMatch(params: {
  hasShares: boolean;
  pendingBuyShares: number;
  pendingSellShares: number;
  existingRemainingShares: number;
  verifiedUnits?: number;
  allPendingFromInvoice?: boolean;
}): TickerMatchStatus {
  const netShares = params.existingRemainingShares + params.pendingBuyShares - params.pendingSellShares;

  if (!params.hasShares) {
    return { matched: true, reason: "no-shares-to-verify", netShares, verifiedUnits: params.verifiedUnits };
  }
  if (params.verifiedUnits === undefined) {
    if (Math.abs(netShares) < 1e-6) {
      return { matched: true, reason: "closed-position", netShares };
    }
    if (params.allPendingFromInvoice) {
      return { matched: true, reason: "invoice-verified", netShares };
    }
    return { matched: false, reason: "no-verification", netShares };
  }
  const matched = Math.abs(netShares - params.verifiedUnits) < 1e-6;
  return { matched, reason: matched ? "matched" : "mismatch", netShares, verifiedUnits: params.verifiedUnits };
}

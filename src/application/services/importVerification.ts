export type TickerMatchReason =
  | "matched"
  | "no-shares-to-verify"
  | "closed-position"
  | "invoice-verified"
  | "cross-verified"
  | "orders-verified"
  | "no-verification"
  | "mismatch";

export interface TickerMatchStatus {
  matched: boolean;
  reason: TickerMatchReason;
  netShares: number;
  /**
   * Shares this ticker already had on the ledger before this batch —
   * included in netShares. Surfaced so the UI can show the reconciliation
   * arithmetic ("20 already recorded + 54 in this batch = 74"): a verified
   * count that includes invisible existing shares otherwise looks like it
   * doesn't add up against the rows on screen.
   */
  existingRemainingShares?: number;
  verifiedUnits?: number;
  /**
   * True on a "mismatch" whose already-committed shares alone (before this
   * batch's pending candidates) already reconcile exactly against the
   * broker's verified count — i.e. the broker independently confirms the
   * ledger was already correct, and every pending candidate for this ticker
   * is re-describing shares already accounted for (a bulk re-upload of an
   * already-fully-imported ticker), not a genuinely new transaction. See
   * ImportPage's "Discard all pending for {ticker}" action, which this
   * flag enables — distinct from the row-level duplicate checks, which
   * require an individual candidate to match a specific existing trade or
   * sibling by date+shares and miss this case whenever the existing lots
   * were recorded with a different date/shares split than this new read.
   */
  alreadyFullyRecorded?: boolean;
  /**
   * Which side of the transaction list is the likely source of the
   * discrepancy — surfaced in the mismatch/no-verification banners so the
   * user knows where to look first.
   *
   * "buy"  → net shares exceed the expected count, or buys outweigh sells
   *          — look for a duplicate or misread buy transaction.
   * "sell" → net shares fall short of the expected count, or sells outweigh
   *          buys — look for a duplicate or misread sell transaction, or a
   *          missing buy.
   */
  discrepancySide?: "buy" | "sell";
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
 *
 * A fourth way, one level broader — the dual-source rule: a ticker whose
 * every still-pending candidate is *either* invoice-sourced *or*
 * cross-verified by a second, DIFFERENT document type describing the same
 * transaction (see `findCrossSourceVerifiedKeys` — statement + invoice,
 * statement + orders screenshot, invoice + orders screenshot, CSV +
 * anything; which pair doesn't matter, that they're two independent
 * document types does). Two independent sources agreeing is at least as
 * trustworthy as an invoice alone, and resolves exactly the case a broker
 * "My Position" total can't: an OCR-only ticker whose extracted total
 * won't reconcile no matter how the rows are grouped, because the
 * mismatch is hiding inside a row nothing else ever corroborated.
 *
 * A fifth way, same shape again: a ticker whose every still-pending
 * candidate is corroborated one way or another — invoice-sourced,
 * cross-verified, or matched against a fulfilled order on the broker's own
 * account-wide "Orders" timeline screenshot (see
 * orderEvidence.findOrderConfirmedKeys: same ticker/side/share count, price
 * within tolerance). The Orders screen is broker-authored ground truth for
 * WHICH transactions happened (though not for the current position count),
 * so a batch it fully confirms doesn't additionally need a "My Position"
 * recount. Exactly like the invoice/cross-verified rules, this only ever
 * substitutes for a MISSING position screenshot — an actual mismatch against
 * a real one still blocks.
 */
export function checkTickerMatch(params: {
  hasShares: boolean;
  pendingBuyShares: number;
  pendingSellShares: number;
  existingRemainingShares: number;
  verifiedUnits?: number;
  allPendingFromInvoice?: boolean;
  allPendingSelfVerified?: boolean;
  allPendingOrderConfirmed?: boolean;
}): TickerMatchStatus {
  const existingRemainingShares = params.existingRemainingShares;
  const netShares = existingRemainingShares + params.pendingBuyShares - params.pendingSellShares;

  if (!params.hasShares) {
    return { matched: true, reason: "no-shares-to-verify", netShares, existingRemainingShares, verifiedUnits: params.verifiedUnits };
  }
  if (params.verifiedUnits === undefined) {
    if (Math.abs(netShares) < 1e-6) {
      return { matched: true, reason: "closed-position", netShares, existingRemainingShares };
    }
    if (params.allPendingFromInvoice) {
      return { matched: true, reason: "invoice-verified", netShares, existingRemainingShares };
    }
    if (params.allPendingSelfVerified) {
      return { matched: true, reason: "cross-verified", netShares, existingRemainingShares };
    }
    if (params.allPendingOrderConfirmed) {
      return { matched: true, reason: "orders-verified", netShares, existingRemainingShares };
    }
    // No broker screenshot and no alternative verification — indicate which
    // side the surplus/shortage sits on so the user knows where to look.
    // Sign of the NET (which includes already-recorded ledger shares), not a
    // pending-rows comparison: a batch of only Sells against a too-large
    // recorded position has its problem on the Buy side (an extra/duplicate
    // buy already committed), even though Sells are the only pending rows.
    const discrepancySide: "buy" | "sell" = netShares >= 0 ? "buy" : "sell";
    return { matched: false, reason: "no-verification", netShares, existingRemainingShares, discrepancySide };
  }
  const matched = Math.abs(netShares - params.verifiedUnits) < 1e-6;
  if (matched) {
    return { matched: true, reason: "matched", netShares, existingRemainingShares, verifiedUnits: params.verifiedUnits };
  }
  const alreadyFullyRecorded = Math.abs(existingRemainingShares - params.verifiedUnits) < 1e-6;
  // netShares > verifiedUnits → too many shares → excess likely on buy side.
  // netShares < verifiedUnits → too few shares → shortage likely on sell side (extra sell or missing buy).
  const discrepancySide: "buy" | "sell" = netShares > params.verifiedUnits ? "buy" : "sell";
  return { matched: false, reason: "mismatch", netShares, existingRemainingShares, verifiedUnits: params.verifiedUnits, alreadyFullyRecorded, discrepancySide };
}

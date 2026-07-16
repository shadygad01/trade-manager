import type { DiagnosticsRecorder } from "@domain/repositories";

export type TickerMatchReason =
  | "matched"
  | "no-shares-to-verify"
  | "closed-position"
  | "invoice-verified"
  | "broker-excel-verified"
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
  /**
   * Echoes checkTickerMatch's own inputs back on the result — the single
   * canonical figures every "Pending Buy/Sell for TICKER total N shares"
   * display in the UI must read from, instead of re-deriving them with a
   * second filter that can silently drift from the one the match/mismatch
   * decision itself was actually computed against (a real, found-and-fixed
   * bug: TickerGroupCard's own local pendingSellShares once omitted the
   * skippedKeys/dismissedKeys exclusion this field's source already applies).
   */
  pendingBuyShares?: number;
  pendingSellShares?: number;
  verifiedUnits?: number;
  /**
   * Echoed straight from the same latest-verification record `verifiedUnits`
   * came from — lets a "mismatch" ticker's avg-cost-based reconcile
   * suggestion (mismatchResolver.suggestRemovalsToReconcile) read it here
   * instead of re-selecting "the latest PositionVerification for this
   * ticker" a second time with a separately maintained copy of the same
   * capturedAt-max reduce.
   */
  verifiedAvgCost?: number;
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
  /**
   * True only on `reason === "broker-excel-verified"`, when a "My Position"
   * screenshot (or other secondary source) exists but disagrees with the
   * net share count. Per the broker-record trust policy this never blocks,
   * downgrades, or invalidates the Excel-sourced transaction — `matched`
   * stays true regardless — it exists purely so the UI can flag the
   * disagreement for the user to look at, without treating it as a real
   * discrepancy the way a `"mismatch"` reason does for every other source.
   */
  secondaryMismatch?: boolean;
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
 * A ticker whose every still-pending candidate came from the broker's own
 * native "Your Orders" Excel export (`source: "official-broker-excel"`, see
 * ThndrOrdersWorkbookParser.ts) is verified for the same reason — every
 * field is printed verbatim by the broker's own system, no OCR or AI
 * extraction involved — but goes one step further than invoice: it is
 * authoritative even against a DISAGREEING "My Position" screenshot, not
 * just a missing one (checked before the verifiedUnits branch entirely, see
 * the code below). Per the broker-record trust policy, only the Excel
 * no secondary document or locally reconstructed inventory can withhold
 * verification from an Excel-sourced batch; a disagreeing screenshot is surfaced via
 * `secondaryMismatch` for the user to review, never as a block.
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
 *
 * `reason === "closed-position"` alone is deliberately NOT sufficient to set
 * `matched: true` (see the corroboration check below) — net-zero (buys
 * exactly cancel sells) is indistinguishable, by arithmetic alone, from a
 * batch that's missing an equal, canceling buy+sell pair before or after it.
 * completenessEngine.ts documents the same rule from the historical-
 * completeness side (real cases: JUFO, SKPC — a ticker whose visible history
 * happened to net to zero, verified as "matched" on that arithmetic alone,
 * while an actual missing Buy/Sell sat just outside the imported window).
 * `checkTickerMatch` used to auto-match this case unconditionally; the fix is
 * to require the SAME independent corroboration signals (invoice/cross/
 * orders-verified) it already requires for a NON-zero net position — never a
 * broker "My Position" recount here, since a closed ticker never appears on
 * one (see the reason ordering below: closed-position is checked only after
 * the three corroboration branches, not before them).
 */
/**
 * The exact wording checkTickerMatch's own MatchBadge renderer (ImportPage.tsx)
 * shows for each reason — reused here verbatim so a Diagnostics Center
 * "Verification" decision names literally the same banner text the user sees,
 * not a paraphrase that could drift from it.
 */
function describeMatchDecision(result: TickerMatchStatus): string {
  switch (result.reason) {
    case "no-shares-to-verify":
      return "No shares to verify";
    case "broker-excel-verified":
      return result.secondaryMismatch ? "Verified (broker Excel) — secondary mismatch vs screenshot" : "Verified (broker Excel)";
    case "invoice-verified":
      return "Verified (invoice)";
    case "cross-verified":
      return "Verified (cross-source)";
    case "orders-verified":
      return "Verified (orders history)";
    case "closed-position":
      return "Closed — sold out";
    case "no-verification":
      return result.netShares < -1e-6 ? "Missing buy history" : "Needs broker screenshot";
    case "matched":
      return "Verified (matches broker holdings)";
    case "mismatch":
      return "Mismatch";
  }
}

export function checkTickerMatch(params: {
  hasShares: boolean;
  pendingBuyShares: number;
  pendingSellShares: number;
  existingRemainingShares: number;
  verifiedUnits?: number;
  verifiedAvgCost?: number;
  allPendingFromInvoice?: boolean;
  allPendingFromOfficialBrokerExcel?: boolean;
  allPendingSelfVerified?: boolean;
  allPendingOrderConfirmed?: boolean;
  /** Diagnostics tagging only — never read by the decision logic itself. */
  ticker?: string;
  diagnostics?: DiagnosticsRecorder;
}): TickerMatchStatus {
  const existingRemainingShares = params.existingRemainingShares;
  const pendingBuyShares = params.pendingBuyShares;
  const pendingSellShares = params.pendingSellShares;
  const netShares = existingRemainingShares + pendingBuyShares - pendingSellShares;
  const common = { existingRemainingShares, pendingBuyShares, pendingSellShares };

  // This is the terminal decision function behind every "Needs broker
  // screenshot"/"Mismatch"/"Closed — needs corroborating evidence" banner in
  // the Import UI (ImportPage.tsx's MatchBadge only maps `.reason` to text —
  // it decides nothing). Constraint Evaluation (constraintValidation.ts)
  // checks a DIFFERENT question — whether already-known facts arithmetically
  // reconcile — and can report "Satisfied" for a ticker this function still
  // blocks, because reconciling arithmetic and having independent
  // corroboration for it are separate requirements. Every return path funnels
  // through `decide` below so exactly one decision is recorded per call,
  // naming the same reason/wording the UI itself renders.
  function decide(result: TickerMatchStatus): TickerMatchStatus {
    params.diagnostics?.recordDecision({
      decisionType: "Verification",
      ticker: params.ticker,
      reader: "importVerification.ts",
      function: "checkTickerMatch",
      decision: describeMatchDecision(result),
      inputSummary: `opening ${existingRemainingShares} + buy ${pendingBuyShares} - sell ${pendingSellShares} = ${netShares}${
        params.verifiedUnits !== undefined ? `, broker holdings ${params.verifiedUnits}` : ", no broker holdings on file"
      }`,
      outputSummary: `${result.reason}, matched=${result.matched}${
        result.discrepancySide ? `, discrepancy on ${result.discrepancySide} side` : ""
      }${result.secondaryMismatch ? ", secondary mismatch vs screenshot" : ""}${
        result.alreadyFullyRecorded ? ", already fully recorded" : ""
      }`,
    });
    return result;
  }

  if (!params.hasShares) {
    return decide({
      matched: true,
      reason: "no-shares-to-verify",
      netShares,
      ...common,
      verifiedUnits: params.verifiedUnits,
      verifiedAvgCost: params.verifiedAvgCost,
    });
  }
  // The official broker Excel export is authoritative even against a
  // DISAGREEING secondary source — checked before the verifiedUnits/screenshot
  // branch below (unlike every other corroboration signal, which only ever
  // substitutes for a MISSING screenshot and still blocks on a real,
  // present mismatch). It also remains authoritative when the selected
  // export window begins after the opening Buy, making the visible net
  // inventory negative: that is a limitation of the imported date range,
  // not a reason to demand another document. A "My Position" screenshot
  // that disagrees is surfaced as a
  // non-blocking `secondaryMismatch` for the user to review, never as a
  // reason to withhold verification from the Excel-sourced transaction.
  if (params.allPendingFromOfficialBrokerExcel) {
    const secondaryMismatch = params.verifiedUnits !== undefined && Math.abs(netShares - params.verifiedUnits) >= 1e-6;
    return decide({
      matched: true,
      reason: "broker-excel-verified",
      netShares,
      ...common,
      verifiedUnits: params.verifiedUnits,
      verifiedAvgCost: params.verifiedAvgCost,
      secondaryMismatch,
    });
  }
  // For every non-authoritative source, a negative result means this sell
  // has no sufficient earlier buy history in the ledger. Stop it before any
  // weaker screenshot/invoice shortcut can mark an impossible inventory as
  // verified. The official broker Excel path above is the sole exception.
  if (netShares < -1e-6) {
    return decide({ matched: false, reason: "no-verification", netShares, ...common, discrepancySide: "sell" });
  }
  if (params.verifiedUnits === undefined) {
    // Corroboration checked BEFORE the closed-position shortcut, and applies
    // equally whether netShares is zero or not — these three signals are
    // independent, per-transaction evidence, always strictly stronger than
    // "the arithmetic happens to cancel."
    if (params.allPendingFromInvoice) {
      return decide({ matched: true, reason: "invoice-verified", netShares, ...common });
    }
    if (params.allPendingSelfVerified) {
      return decide({ matched: true, reason: "cross-verified", netShares, ...common });
    }
    if (params.allPendingOrderConfirmed) {
      return decide({ matched: true, reason: "orders-verified", netShares, ...common });
    }
    // Net-zero is not independent evidence: an invented Buy and invented
    // Sell can cancel perfectly. A closed position therefore remains under
    // review until an execution-detail source corroborates it.
    if (Math.abs(netShares) < 1e-6) {
      // Net-zero with NO independent corroboration: never auto-matched (see
      // the doc comment above). Never a "get a My Position screenshot" ask
      // either — a closed position can't prove itself via a document that
      // only ever lists open holdings; the caller's evidence-recommendation
      // step (completenessEngine.recoveryPlan) is what names the actual next
      // document to request.
      return decide({ matched: false, reason: "closed-position", netShares, ...common });
    }
    // No broker screenshot and no alternative verification — indicate which
    // side the surplus/shortage sits on so the user knows where to look.
    // Sign of the NET (which includes already-recorded ledger shares), not a
    // pending-rows comparison: a batch of only Sells against a too-large
    // recorded position has its problem on the Buy side (an extra/duplicate
    // buy already committed), even though Sells are the only pending rows.
    const discrepancySide: "buy" | "sell" = netShares >= 0 ? "buy" : "sell";
    return decide({ matched: false, reason: "no-verification", netShares, ...common, discrepancySide });
  }
  const matched = Math.abs(netShares - params.verifiedUnits) < 1e-6;
  if (matched) {
    return decide({
      matched: true,
      reason: "matched",
      netShares,
      ...common,
      verifiedUnits: params.verifiedUnits,
      verifiedAvgCost: params.verifiedAvgCost,
    });
  }
  const alreadyFullyRecorded = Math.abs(existingRemainingShares - params.verifiedUnits) < 1e-6;
  // netShares > verifiedUnits → too many shares → excess likely on buy side.
  // netShares < verifiedUnits → too few shares → shortage likely on sell side (extra sell or missing buy).
  const discrepancySide: "buy" | "sell" = netShares > params.verifiedUnits ? "buy" : "sell";
  return decide({
    matched: false,
    reason: "mismatch",
    netShares,
    ...common,
    verifiedUnits: params.verifiedUnits,
    verifiedAvgCost: params.verifiedAvgCost,
    alreadyFullyRecorded,
    discrepancySide,
  });
}

/**
 * A ticker is "fully matched" once every buy/sell/dividend/verification row
 * extracted for it has reached a terminal state (committed, skipped as an
 * exact duplicate, or manually dismissed) and none is stuck on a row error —
 * i.e. there's nothing left for the user to look at. ImportPage uses this to
 * move a resolved ticker's card out of the active working list into a
 * collapsed "Fully matched" summary, so the active list only ever shows
 * tickers that still need a decision (an unmatched share count, an
 * unallocated sell, a failed commit).
 *
 * A ticker with zero buy/sell rows (dividend/verification-only) never
 * resolves this way — there's no "sell = buy" question to answer for it, so
 * it stays visible like any other still-open card rather than silently
 * vanishing.
 */
export function isTickerFullyResolved(params: {
  matched: boolean;
  transactionKeys: readonly string[];
  dividendKeys: readonly string[];
  verificationKeys: readonly string[];
  addedKeys: ReadonlySet<string>;
  skippedKeys: ReadonlySet<string>;
  dismissedKeys: ReadonlySet<string>;
  acceptedKeys: ReadonlySet<string>;
  rowErrorKeys: ReadonlySet<string>;
}): boolean {
  if (!params.matched || params.transactionKeys.length === 0) return false;
  const transactionsResolved = params.transactionKeys.every(
    (k) => params.addedKeys.has(k) || params.skippedKeys.has(k) || params.dismissedKeys.has(k),
  );
  if (!transactionsResolved) return false;
  const dividendsResolved = params.dividendKeys.every((k) => params.addedKeys.has(k));
  if (!dividendsResolved) return false;
  const verificationsResolved = params.verificationKeys.every((k) => params.acceptedKeys.has(k));
  if (!verificationsResolved) return false;
  return [...params.transactionKeys, ...params.dividendKeys, ...params.verificationKeys].every(
    (k) => !params.rowErrorKeys.has(k),
  );
}

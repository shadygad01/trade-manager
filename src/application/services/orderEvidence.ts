import type { ParsedOrderEvidence, ParsedTradeCandidate } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";

/**
 * An account-wide "Orders" timeline screenshot (see ParsedOrderEvidence) is
 * the broker's own record of every order — but its rows are undated, so they
 * can never become trades themselves. What they CAN do is corroborate: a
 * pending candidate whose ticker/side/share count matches a fulfilled order
 * (at a near-identical price) is confirmed by the broker's order history, and
 * a candidate whose numbers instead match another ticker's fulfilled order is
 * very likely the same execution misfiled under a wrong OCR ticker guess.
 * Both checks below are hints/verification inputs only — nothing here writes
 * or discards anything.
 */

/**
 * Wider than the statement-vs-statement duplicate check's exact-price rule
 * but tighter than the wrong-ticker phantom detector's 10%: a candidate's
 * price may be commission-inclusive (derived from a statement's Value
 * column) while the timeline shows the raw order price, so a small relative
 * gap is expected for the same real execution — a gap past a few percent is
 * a different transaction, not a fee.
 */
const ORDER_MATCH_PRICE_TOLERANCE = 0.05;

function pricesClose(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * tolerance;
}

/**
 * Content identity for cross-file dedup of timeline rows: consecutive
 * scrolled screenshots of the same Orders screen overlap by a few rows, and
 * without dates this signature is all a row has. Deliberately used to dedup
 * only ACROSS files, never within one file — two identical rows visible in
 * one screenshot are genuinely two separate orders, while the same signature
 * appearing in two files is almost always the scroll overlap.
 */
export function orderEvidenceContentKey(e: ParsedOrderEvidence): string {
  return `${normalizeTicker(e.ticker)}|${e.side}|${e.orderType}|${e.price}|${e.totalValue}|${e.status}`;
}

/**
 * Matches still-pending Buy/Sell candidates against fulfilled timeline
 * orders: same ticker, same side, same share count, price within tolerance.
 * Each order corroborates at most ONE pending row — an evidence row consumed
 * by one candidate is not reused for its duplicate sibling, so a
 * double-extracted transaction can never be double-confirmed by a single
 * real order (the un-corroborated copy stays flagged for the sibling
 * duplicate check to clean up).
 */
export function findOrderConfirmedKeys(
  pendingEntries: { key: string; candidate: ParsedTradeCandidate }[],
  evidences: ParsedOrderEvidence[],
): Set<string> {
  const confirmed = new Set<string>();
  const available = evidences.filter((e) => e.status === "fulfilled").map((e) => ({ evidence: e, used: false }));

  for (const entry of pendingEntries) {
    const c = entry.candidate;
    const match = available.find(
      (a) =>
        !a.used &&
        normalizeTicker(a.evidence.ticker) === normalizeTicker(c.ticker) &&
        a.evidence.side === c.side &&
        a.evidence.shares === c.shares &&
        pricesClose(a.evidence.price, c.price, ORDER_MATCH_PRICE_TOLERANCE),
    );
    if (match) {
      match.used = true;
      confirmed.add(entry.key);
    }
  }
  return confirmed;
}

/**
 * The wrong-ticker signal the timeline is uniquely positioned to give: its
 * rows print the REAL ticker code, so a pending candidate whose own ticker
 * has no matching fulfilled order, while exactly one OTHER ticker's
 * fulfilled order matches its side/shares/price, is very likely that other
 * ticker's execution filed under a wrong OCR guess. Skips high-confidence
 * candidates (an anchored ticker read outranks this heuristic) and stays
 * silent when more than one ticker's orders match (no basis to pick).
 * Returns pending key -> the ticker the row most likely belongs to — a badge
 * hint only, same contract as findWrongTickerCandidateKeys.
 */
export function findWrongTickerHintsFromOrders(
  pendingEntries: { key: string; candidate: ParsedTradeCandidate }[],
  evidences: ParsedOrderEvidence[],
): Map<string, string> {
  const hints = new Map<string, string>();
  const fulfilled = evidences.filter((e) => e.status === "fulfilled");

  for (const entry of pendingEntries) {
    const c = entry.candidate;
    if (c.confidence === "high") continue;
    const ticker = normalizeTicker(c.ticker);

    const matchesNumbers = (e: ParsedOrderEvidence) =>
      e.side === c.side && e.shares === c.shares && pricesClose(e.price, c.price, ORDER_MATCH_PRICE_TOLERANCE);

    const ownTickerMatch = fulfilled.some((e) => normalizeTicker(e.ticker) === ticker && matchesNumbers(e));
    if (ownTickerMatch) continue;

    const otherTickers = new Set(
      fulfilled.filter((e) => normalizeTicker(e.ticker) !== ticker && matchesNumbers(e)).map((e) => normalizeTicker(e.ticker)),
    );
    if (otherTickers.size === 1) hints.set(entry.key, [...otherTickers][0]);
  }
  return hints;
}

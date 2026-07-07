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
 * Content identity for cross-file dedup of order-history rows: consecutive
 * scrolled screenshots of the same screen overlap by a few rows. The
 * undated "Orders" timeline shape has nothing but its own numbers to key on;
 * the dated "Transactions" list shape includes date/time, which is folded in
 * too so two different days' rows for the same ticker/side/total are never
 * mistaken for the same overlapping row. Deliberately used to dedup only
 * ACROSS files, never within one file — two identical rows visible in one
 * screenshot are genuinely two separate orders, while the same signature
 * appearing in two files is almost always the scroll overlap.
 */
export function orderEvidenceContentKey(e: ParsedOrderEvidence): string {
  return `${normalizeTicker(e.ticker)}|${e.side}|${e.orderType ?? ""}|${e.date ?? ""}|${e.time ?? ""}|${e.price ?? ""}|${e.totalValue}|${e.status}`;
}

/**
 * Whether a fulfilled order-history row's side/shares/price (or side/date/
 * total, for the dated shape) match a candidate's — ticker-agnostic, so it
 * doubles as both the same-ticker confirmation check and the
 * other-ticker-misfiled hint check below. The undated "Orders" timeline
 * shape matches on side/share count/price (its only fields); the dated
 * "Transactions" list shape carries no share count or per-share price at
 * all, so it matches on side/date instead, with the row's total value
 * checked against shares × price — that's genuinely everything it prints.
 * `evidence.date` is what distinguishes which shape this row came from (see
 * ParsedOrderEvidence).
 */
function evidenceNumbersMatch(evidence: ParsedOrderEvidence, candidate: ParsedTradeCandidate): boolean {
  if (evidence.side !== candidate.side) return false;
  if (evidence.date) {
    return evidence.date === candidate.date && pricesClose(evidence.totalValue, candidate.shares * candidate.price, ORDER_MATCH_PRICE_TOLERANCE);
  }
  return (
    evidence.shares === candidate.shares &&
    evidence.price !== undefined &&
    pricesClose(evidence.price, candidate.price, ORDER_MATCH_PRICE_TOLERANCE)
  );
}

function evidenceMatchesCandidate(evidence: ParsedOrderEvidence, candidate: ParsedTradeCandidate): boolean {
  return normalizeTicker(evidence.ticker) === normalizeTicker(candidate.ticker) && evidenceNumbersMatch(evidence, candidate);
}

/**
 * Matches still-pending Buy/Sell candidates against fulfilled order-history
 * rows (see evidenceMatchesCandidate for the two shapes this covers). Each
 * order corroborates at most ONE pending row — an evidence row consumed by
 * one candidate is not reused for its duplicate sibling, so a
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
    const match = available.find((a) => !a.used && evidenceMatchesCandidate(a.evidence, c));
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

    const ownTickerMatch = fulfilled.some((e) => normalizeTicker(e.ticker) === ticker && evidenceNumbersMatch(e, c));
    if (ownTickerMatch) continue;

    const otherTickers = new Set(
      fulfilled.filter((e) => normalizeTicker(e.ticker) !== ticker && evidenceNumbersMatch(e, c)).map((e) => normalizeTicker(e.ticker)),
    );
    if (otherTickers.size === 1) hints.set(entry.key, [...otherTickers][0]);
  }
  return hints;
}

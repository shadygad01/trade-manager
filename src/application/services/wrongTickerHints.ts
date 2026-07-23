import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { pricesWithinOcrNoise } from "./duplicateDetection";

/**
 * The same physical execution read under two different guessed tickers keeps
 * its side, date, share count and (roughly) its price — only the ticker
 * differs. This is the one duplicate shape none of the checks above can see:
 * they all group within a ticker, so a low-confidence OCR read filed under
 * the wrong ticker (an unmapped company-name fallback, a fuzzy guess) shows
 * up as a phantom row inflating the wrong ticker's total while the real
 * transaction sits, committed or pending, under another name.
 *
 * The price-proximity requirement is the discriminator against coincidence:
 * two genuinely different stocks trading the same share count on the same
 * day would carry unrelated prices, while two OCR reads of the same
 * execution land within OCR noise of each other. A pending row is flagged
 * when a close-priced copy exists under a different ticker and that copy
 * outranks it — already committed to the ledger (and the pending read isn't
 * a high-confidence anchored match), or still pending but with strictly
 * higher OCR confidence. Returns pending key -> the ticker the row most
 * likely belongs to. Only ever a hint driving a badge + the existing manual
 * remove button — nothing is discarded without the user's click.
 */
const WRONG_TICKER_PRICE_TOLERANCE = 0.1;

function wrongTickerConfidenceRank(c?: ParsedTradeCandidate["confidence"]): number {
  if (c === "low") return 0;
  if (c === "medium") return 1;
  return 2;
}

export function findWrongTickerCandidateKeys(
  pendingEntries: { key: string; candidate: ParsedTradeCandidate }[],
  committedTrades: { ticker: string; executionDate: string; shares: number; entryPrice: number }[],
  committedAllocations: { ticker: string; executionDate: string; sharesClosed: number; exitPrice: number }[],
): Map<string, string> {
  const hints = new Map<string, string>();
  const pricesClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * WRONG_TICKER_PRICE_TOLERANCE;

  for (const e of pendingEntries) {
    const ticker = normalizeTicker(e.candidate.ticker);
    const c = e.candidate;

    if (wrongTickerConfidenceRank(c.confidence) < 2) {
      const committed =
        c.side === "BUY"
          ? committedTrades.find(
              (t) =>
                normalizeTicker(t.ticker) !== ticker &&
                t.executionDate === c.date &&
                t.shares === c.shares &&
                pricesClose(t.entryPrice, c.price),
            )
          : committedAllocations.find(
              (a) =>
                normalizeTicker(a.ticker) !== ticker &&
                a.executionDate === c.date &&
                a.sharesClosed === c.shares &&
                pricesClose(a.exitPrice, c.price),
            );
      if (committed) {
        hints.set(e.key, normalizeTicker(committed.ticker));
        continue;
      }
    }

    const betterPendingCopy = pendingEntries.find(
      (o) =>
        o.key !== e.key &&
        normalizeTicker(o.candidate.ticker) !== ticker &&
        o.candidate.side === c.side &&
        o.candidate.date === c.date &&
        o.candidate.shares === c.shares &&
        pricesClose(o.candidate.price, c.price) &&
        wrongTickerConfidenceRank(o.candidate.confidence) > wrongTickerConfidenceRank(c.confidence),
    );
    if (betterPendingCopy) hints.set(e.key, normalizeTicker(betterPendingCopy.candidate.ticker));
  }
  return hints;
}

/**
 * Two dates plausibly the same real day, misread by a single OCR digit
 * substitution in the day component (same year+month, the two-digit day
 * strings differ in exactly one character position) — e.g. "2023-01-11" vs
 * "2023-01-01" (a real observed failure: the same execution, scroll-overlap
 * duplicated across two screenshots, read once with the day intact and once
 * with it misread). Deliberately narrow: a blanket "nearby date" tolerance
 * would be unsafe here — two genuinely different real trades of the same
 * share count at a similar price, a week or two apart, are an entirely
 * ordinary trading pattern (accumulating a position over several weeks), so
 * this only fires for the specific single-digit-substitution shape OCR
 * actually produces, not any date that happens to be "close".
 */
function datesLikelyOcrMisread(a: string, b: string): boolean {
  if (a === b) return false;
  const [ay, am, ad] = a.split("-");
  const [by, bm, bd] = b.split("-");
  if (ay !== by || am !== bm || ad === undefined || bd === undefined || ad.length !== bd.length) return false;
  let differing = 0;
  for (let i = 0; i < ad.length; i++) {
    if (ad[i] !== bd[i]) differing++;
  }
  return differing === 1;
}

/**
 * Advisory-only hint for a pending Buy/Sell whose ticker+side+shares+price
 * match a trade already on the ledger closely enough to be the same real
 * execution, except its date differs by exactly the single-digit OCR
 * substitution datesLikelyOcrMisread targets. Real observed failure (RMDA):
 * a 500-share buy appearing in the scroll overlap of two screenshots landed
 * as two separate committed trades — "11 Jan" in one read, "01 Jan" in the
 * other — because the exact-date signature every other duplicate check
 * relies on never recognized them as the same row. This never auto-skips or
 * auto-merges anything, same contract as findWrongTickerCandidateKeys: a
 * badge plus the existing manual discard/delete action, since silently
 * collapsing two nearby-date trades that could genuinely be different real
 * orders would be an unacceptable risk to take automatically.
 */
export function findDateMisreadDuplicateHints(
  pendingEntries: { key: string; candidate: ParsedTradeCandidate }[],
  committedTrades: { ticker: string; executionDate: string; shares: number; entryPrice: number }[],
  committedAllocations: { ticker: string; executionDate: string; sharesClosed: number; exitPrice: number }[],
): Map<string, string> {
  const hints = new Map<string, string>();
  for (const e of pendingEntries) {
    const ticker = normalizeTicker(e.candidate.ticker);
    const c = e.candidate;
    // This heuristic exists solely for OCR's one-digit date mistakes. A
    // native broker Excel export supplies the execution date directly, so a
    // similar-looking order on another day is evidence of a real separate
    // fill, not a reason to show a misleading duplicate warning.
    if (c.source === "official-broker-excel") continue;
    const matched =
      c.side === "BUY"
        ? committedTrades.find(
            (t) =>
              normalizeTicker(t.ticker) === ticker &&
              t.shares === c.shares &&
              pricesWithinOcrNoise(t.entryPrice, c.price) &&
              datesLikelyOcrMisread(t.executionDate, c.date),
          )
        : committedAllocations.find(
            (a) =>
              normalizeTicker(a.ticker) === ticker &&
              a.sharesClosed === c.shares &&
              pricesWithinOcrNoise(a.exitPrice, c.price) &&
              datesLikelyOcrMisread(a.executionDate, c.date),
          );
    if (matched) hints.set(e.key, matched.executionDate);
  }
  return hints;
}

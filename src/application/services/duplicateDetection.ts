import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { type GroupingSignature, toGroupingSignature } from "@domain/value-objects/identity";

export type DuplicateMatchType = "exact" | "possible";

export interface DuplicateMatch {
  matchType: DuplicateMatchType;
  matchedId: string;
  /** The already-recorded price this candidate matched against — lets callers judge how far apart a "possible" match's prices really are (see pricesWithinOcrNoise). */
  matchedPrice: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Two reads of the same real execution rarely carry bit-identical prices:
 * one document derives price from total value (commission-inclusive), the
 * other prints the raw execution price, or OCR drops a trailing decimal.
 * Both reads still land within a hair of each other — while two genuinely
 * different same-day trades of the same share count would normally differ
 * more. 1% relative tolerance is the discriminator the wrong-ticker check
 * already trusts at 10%; kept much tighter here because this one gates
 * silent auto-skips, not just a badge.
 */
export function pricesWithinOcrNoise(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * 0.01;
}

/**
 * When both sides carry a broker-assigned transaction number (currently only
 * Thndr's Invoice format prints one — see ParsedTradeCandidate.transactionNumber),
 * it settles "same real execution?" decisively, without relying on
 * date/shares/price ever having been read consistently: an exact string
 * match is certainly the same order, and a defined mismatch is certainly a
 * DIFFERENT one — even if every other field happens to coincide (e.g. two
 * genuinely separate same-day, same-share-count buys of the same stock at a
 * similar price, which the heuristic-only checks below can't tell apart).
 * Returns undefined — "inconclusive, fall back to the heuristic" — whenever
 * either side lacks one.
 */
export function sameExecution(a?: string, b?: string): boolean | undefined {
  if (!a || !b) return undefined;
  return a === b;
}

// Trade.executionTime/TradeAllocation.executionTime are non-optional fields
// that fall back to this placeholder when OCR never captured a real time
// (see ImportPage's `entry.candidate.time ?? "00:00"`) — never a genuine
// midnight execution in this domain, so it must never be treated as "the
// same time" or "a conflicting time," only as "unknown."
const UNKNOWN_TIME = "00:00";

// A manually-recorded Trade/TradeAllocation's executionTime comes from an
// `<input type="time">` field, always 24-hour "HH:MM" (e.g. "12:51"). Every
// parser's candidate.time (ThndrParser's normalizeTime, ThndrOrdersWorkbookParser's
// parseOrderDateTime) instead prints 12-hour with an AM/PM suffix and no
// space (e.g. "12:51PM"). Both describe the same real-world clock time, but
// as raw strings they never compare equal — a real, reproduced bug: a
// manually-entered historical trade later corroborated by an authoritative
// document (the broker's own Excel export) never got recognized as a
// duplicate purely because of this format mismatch, leaving BOTH the
// low-authority manual fact and the new authoritative one live side by side
// (double-counting the position, and permanently blocking
// isTickerFullyOfficialBrokerExcelSourced). Parsed to minutes-since-midnight
// so either format compares correctly against the other; an unrecognized
// format falls back to raw string equality rather than silently treating it
// as unknown.
export function parseTimeToMinutes(raw: string): number | undefined {
  const ampm = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(raw.trim());
  if (ampm) {
    let hours = parseInt(ampm[1], 10) % 12;
    if (ampm[3].toUpperCase() === "PM") hours += 12;
    return hours * 60 + parseInt(ampm[2], 10);
  }
  const plain = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (plain) return parseInt(plain[1], 10) * 60 + parseInt(plain[2], 10);
  return undefined;
}

/**
 * Two rows that BOTH carry a real, differing execution time are provably two
 * different real orders — the same signal sameCandidateExecution already
 * applies within one import batch, extended here to matching against
 * already-committed ledger rows. Without this, a genuinely new same-day
 * trade of the same ticker/shares/price as one already recorded (an
 * ordinary accumulation pattern, not a re-import) would be misjudged as an
 * exact duplicate and silently auto-skipped during commit.
 *
 * Exported for reuse by every other place a "same real execution?" identity
 * question comes down to value alone (ticker/side/date/shares/price) and
 * needs execution time as the tiebreaker between two candidates sharing that
 * exact value — TradeService.ensureBuyFact's liveMatch search,
 * ledgerProjection.ts's resolveExistingTradeForLot fallback, and
 * rawTransactionFolds.ts's findUnclaimedSellExecutionFact/findLiveExecutionFact
 * — all of which used to pick whichever same-value candidate came first in
 * array order, with no regard for time. A real, reproduced bug: two genuine
 * same-day, same-price, same-share-count Buy orders (a common pattern —
 * splitting a large order into smaller fills at an identical limit price)
 * placed minutes apart got cross-linked to the wrong RawTransaction fact
 * during commit, spawning a phantom extra Trade row for one execution and
 * leaving the other's row wrongly flagged "Duplicate" in the Import UI.
 */
export function timesConflict(a?: string, b?: string): boolean {
  if (!a || !b || a === UNKNOWN_TIME || b === UNKNOWN_TIME) return false;
  const minutesA = parseTimeToMinutes(a);
  const minutesB = parseTimeToMinutes(b);
  if (minutesA === undefined || minutesB === undefined) return a !== b;
  return minutesA !== minutesB;
}

/**
 * A parsed candidate can look like a duplicate of a trade already on the
 * ledger in two ways: an "exact" match (same ticker/date/shares/price — the
 * same file or an overlapping statement re-imported), or a "possible" match
 * (same ticker/date/shares but a different price — the same real trade
 * parsed from two different document formats, one commission-inclusive, one
 * not; see ThndrParser's price-from-value derivation). Never auto-skip
 * either case — this only flags it for the user to decide.
 *
 * A candidate/existing-row transaction-number match short-circuits straight
 * to "exact" regardless of date/shares/price (see sameExecution); a
 * transaction-number MISMATCH removes that row from consideration entirely,
 * even when its date/shares/price would otherwise look like a match. A
 * conflicting execution time (see timesConflict) does the same.
 */
/** Exported so callers with a comparison pool that isn't shaped like Trade[]/TradeAllocation[] (e.g. the Verification Engine, comparing raw transactions against each other) can reuse this exact matching rule instead of re-deriving it. */
export function findMatch(
  candidate: { ticker: string; date: string; shares: number; time?: string; transactionNumber?: string },
  candidatePrice: number,
  existing: { id: string; ticker: string; date: string; shares: number; price: number; executionTime?: string; transactionNumber?: string }[]
): DuplicateMatch | undefined {
  const ticker = normalizeTicker(candidate.ticker);
  const sameTicker = existing.filter((e) => normalizeTicker(e.ticker) === ticker);

  if (candidate.transactionNumber) {
    const byId = sameTicker.find((e) => sameExecution(e.transactionNumber, candidate.transactionNumber));
    if (byId) return { matchType: "exact", matchedId: byId.id, matchedPrice: byId.price };
  }

  const looseMatches = sameTicker.filter(
    (e) => e.date === candidate.date && e.shares === candidate.shares && !timesConflict(candidate.time, e.executionTime)
  );
  const eligible = candidate.transactionNumber
    ? looseMatches.filter((e) => sameExecution(e.transactionNumber, candidate.transactionNumber) !== false)
    : looseMatches;
  if (eligible.length === 0) return undefined;

  const exact = eligible.find((e) => round4(e.price) === round4(candidatePrice));
  if (exact) return { matchType: "exact", matchedId: exact.id, matchedPrice: exact.price };

  // Report the closest-priced loose match, not whichever row happens to come
  // first — callers judge "same real trade?" by how far the prices sit apart
  // (pricesWithinOcrNoise), so the decision must be deterministic and made
  // against the best candidate, independent of DB row order.
  const closest = [...eligible].sort(
    (a, b) => Math.abs(a.price - candidatePrice) - Math.abs(b.price - candidatePrice)
  )[0];
  return { matchType: "possible", matchedId: closest.id, matchedPrice: closest.price };
}

export function findDuplicateBuyMatch(candidate: ParsedTradeCandidate, existingTrades: Trade[]): DuplicateMatch | undefined {
  return findMatch(
    {
      ticker: candidate.ticker,
      date: candidate.date,
      shares: candidate.shares,
      time: candidate.time,
      transactionNumber: candidate.transactionNumber,
    },
    candidate.price,
    existingTrades.map((t) => ({
      id: t.id,
      ticker: t.ticker,
      date: t.executionDate,
      shares: t.shares,
      price: t.entryPrice,
      executionTime: t.executionTime,
      transactionNumber: t.transactionNumber,
    }))
  );
}

export interface SellOrderGroup {
  id: string;
  price: number;
  totalShares: number;
  date: string;
  executionTime?: string;
  transactionNumber?: string;
}

/**
 * One real sell order allocated across several buy lots is stored as several
 * TradeAllocation rows (e.g. a 45-share sell closed against a 30-lot and a
 * 15-lot) that share one `sellGroupId`. Aggregates rows by their sell order's
 * identity (sellGroupId, guarded by ticker+date for legacy rows recorded
 * before sellGroupId existed) so a 45-share sell split across two lots is
 * seen as one 45-share order, not two unrelated 30/15 fragments. Optionally
 * scoped to one ticker (normalizeTicker'd) — omit to group every ticker's
 * allocations at once (see ledgerRebuild.ts, which needs every existing sell
 * order across the whole ledger, not just one candidate's ticker).
 */
export function groupSellAllocationsByOrder(existingAllocations: TradeAllocation[], ticker?: string): Map<GroupingSignature, SellOrderGroup> {
  const normalizedTicker = ticker !== undefined ? normalizeTicker(ticker) : undefined;
  const groups = new Map<GroupingSignature, SellOrderGroup>();
  for (const a of existingAllocations) {
    if (normalizedTicker !== undefined && normalizeTicker(a.ticker) !== normalizedTicker) continue;
    // sellGroupId identifies one real sell order regardless of how many lots
    // it was allocated across. Legacy rows recorded before sellGroupId existed
    // must be re-unified by date+exact price, or a 39-share sell split 24+15
    // across two lots would never sum back to 39 and the re-imported candidate
    // would sit pending forever against a fully-consumed position. Time is
    // included too — date+price alone is deliberately coarse enough that two
    // genuinely different legacy sell orders on the same day at the same
    // price (routine) could otherwise merge into one phantom order; every
    // fragment of one real order was written with the identical executionTime
    // in one recordSell call, so this can never split a legitimate order,
    // only keep two distinct ones apart.
    const key = toGroupingSignature(a.sellGroupId || `legacy:${a.executionDate}|${round4(a.exitPrice)}|${a.executionTime}`);
    const g = groups.get(key);
    if (g) {
      g.totalShares += a.sharesClosed;
    } else {
      groups.set(key, {
        id: a.id,
        price: a.exitPrice,
        totalShares: a.sharesClosed,
        date: a.executionDate,
        executionTime: a.executionTime,
        transactionNumber: a.transactionNumber,
      });
    }
  }
  return groups;
}

/**
 * Matching the candidate against individual TradeAllocation rows would never
 * find a 45-share sell split across two lots — so the same sell re-imported
 * keeps looking "new" forever. Aggregates via groupSellAllocationsByOrder
 * (grouped by ticker only, not date — the transaction-number identity check
 * below must be able to find a match even if one side's date was misread;
 * the date requirement is applied afterward, only on the path that falls
 * back to the date/shares heuristic) and matches the candidate against each
 * order's total shares; two distinct sell orders that happen to share date
 * and price are never merged into a false duplicate.
 */
export function findDuplicateSellMatch(
  candidate: ParsedTradeCandidate,
  existingAllocations: TradeAllocation[]
): DuplicateMatch | undefined {
  const groups = groupSellAllocationsByOrder(existingAllocations, candidate.ticker);

  if (candidate.transactionNumber) {
    const byId = [...groups.values()].find((g) => sameExecution(g.transactionNumber, candidate.transactionNumber));
    if (byId) return { matchType: "exact", matchedId: byId.id, matchedPrice: byId.price };
  }

  const looseMatches = [...groups.values()].filter(
    (g) => g.date === candidate.date && g.totalShares === candidate.shares && !timesConflict(candidate.time, g.executionTime)
  );
  const matching = candidate.transactionNumber
    ? looseMatches.filter((g) => sameExecution(g.transactionNumber, candidate.transactionNumber) !== false)
    : looseMatches;
  if (matching.length === 0) return undefined;

  const exact = matching.find((g) => round4(g.price) === round4(candidate.price));
  if (exact) return { matchType: "exact", matchedId: exact.id, matchedPrice: exact.price };

  // Closest-priced sell order, for the same reason as findMatch above.
  const closest = [...matching].sort(
    (a, b) => Math.abs(a.price - candidate.price) - Math.abs(b.price - candidate.price)
  )[0];
  return { matchType: "possible", matchedId: closest.id, matchedPrice: closest.price };
}

/**
 * A dividend candidate has no in-app identity of its own to dedupe against
 * (unlike a Buy/Sell, whose ticker+date+shares+price already distinguishes
 * one execution from another) — the same broker statement re-uploaded
 * weeks later, with its dividend history overlapping what's already
 * recorded, would otherwise silently double-count real cash every time.
 * Global across portfolios, like findDuplicateBuyMatch — a real dividend
 * payment happened once regardless of which portfolio it's filed under.
 */
export function dividendContentKey(d: { ticker: string; date: string; amount: number }): string {
  return `${normalizeTicker(d.ticker)}|${d.date}|${d.amount}`;
}

export function buildExistingDividendKeys(events: TimelineEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type !== "Dividend" || !e.ticker || e.amount === undefined) continue;
    keys.add(dividendContentKey({ ticker: e.ticker, date: e.timestamp.slice(0, 10), amount: e.amount }));
  }
  return keys;
}

export function isDividendAlreadyRecorded(
  dividend: { ticker: string; date: string; amount: number },
  existingDividendKeys: Set<string>
): boolean {
  return existingDividendKeys.has(dividendContentKey(dividend));
}

/**
 * Within one Import batch, nothing dedupes a Buy/Sell candidate against its
 * own siblings the way processFiles already dedupes verifications and
 * dividends by content key — findDuplicateBuyMatch/findDuplicateSellMatch
 * only ever compare against trades already committed to the ledger. So the
 * same real transaction read more than once in one batch (an overlapping
 * multi-file drop, or a PDF page repeated) piles up as separate pending
 * rows, inflating the ticker's extracted share total past what the broker
 * screenshot shows — a mismatch with no candidate flagged as the cause and
 * no way to remove one before committing.
 *
 * Groups same-side candidates by ticker+date+shares (their scan of "how many
 * shares moved this day", independent of a possibly re-OCR'd price) and,
 * within each group of more than one, suggests keeping exactly one and
 * deleting the rest — applying the same price-priority rule the app already
 * uses for reconciling duplicate committed trades (suggestDuplicateTradeIds):
 * a Buy's higher-priced read is the more plausible one (commission-inclusive
 * OCR beats a rounded/partial read), so lower-priced Buy duplicates are
 * suggested for deletion; a Sell's lower-priced read is the more plausible
 * one, so higher-priced Sell duplicates are suggested instead.
 */
/** Same real transaction, independent of a possibly re-OCR'd price: same ticker+side+date+share count. Shared by the sibling-duplicate grouping below and the cross-source verification check in ImportPage. */
export function pendingCandidateSignature(candidate: { ticker: string; side: "BUY" | "SELL"; date: string; shares: number }): GroupingSignature {
  return toGroupingSignature(`${normalizeTicker(candidate.ticker)}|${candidate.side}|${candidate.date}|${candidate.shares}`);
}

/**
 * Two reads of the SAME real execution land within a couple of percent of
 * each other (commission-inclusive vs raw execution price, or minor OCR
 * noise) — while two genuinely different same-day trades of the same share
 * count normally sit further apart. Slightly wider than pricesWithinOcrNoise
 * because cross-format reads legitimately differ by the commission itself.
 */
const SIBLING_DUPLICATE_PRICE_TOLERANCE = 0.02;

export function siblingPricesClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * SIBLING_DUPLICATE_PRICE_TOLERANCE;
}

/**
 * The candidate-level counterpart to sameExecution: prefers a decisive
 * transaction-number verdict when both sides carry one, falling back to
 * price proximity only when that's inconclusive. This is what keeps two
 * genuinely DIFFERENT invoice-sourced trades that happen to share a
 * signature (same ticker+side+date+shares) and a similar price — a real,
 * if rare, scenario (two separate same-day orders) — from being silently
 * merged into one by the sibling/cross-document checks below.
 */
function sameCandidateExecution(a: ParsedTradeCandidate, b: ParsedTradeCandidate): boolean {
  const decisive = sameExecution(a.transactionNumber, b.transactionNumber);
  if (decisive !== undefined) return decisive;
  // Two rows that BOTH carry a real, differing execution time are provably
  // two different real orders — real observed failure (RMDA): two genuine
  // 500-share buys at the same price, 28 minutes apart, wrongly flagged as
  // duplicates of each other because the signature these checks group by
  // (ticker+side+date+shares) doesn't include time. Only fires when both
  // sides actually printed a time — a document that never carries one (a
  // statement row) must not be penalized for the comparison, since that's
  // the routine cross-document pairing case this same grouping exists to
  // support (a statement row and an orders-screen row of the same execution,
  // one of them time-less).
  if (a.time !== undefined && b.time !== undefined && a.time !== b.time) return false;
  return siblingPricesClose(a.price, b.price);
}

/** Invoices are labeled, standardized PDFs — the most trustworthy read of a transaction when one exists in a duplicate group. */
function isInvoiceSourced(c: ParsedTradeCandidate): boolean {
  return c.source === "invoice";
}

export function suggestDuplicatePendingCandidateKeysToDelete(
  entries: { key: string; candidate: ParsedTradeCandidate }[]
): string[] {
  const bySignature = new Map<string, { key: string; candidate: ParsedTradeCandidate }[]>();
  for (const e of entries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = bySignature.get(sig) ?? [];
    list.push(e);
    bySignature.set(sig, list);
  }

  const keysToDelete: string[] = [];
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    const side = group[0].candidate.side;
    const sorted = [...group].sort((a, b) => {
      // An invoice-sourced read wins the survivor slot outright: its price
      // and fees come from labeled fields on a standardized PDF, not from
      // positional OCR guessing — only between two non-invoice reads does
      // the price-plausibility heuristic decide.
      const invoiceRank = Number(isInvoiceSourced(b.candidate)) - Number(isInvoiceSourced(a.candidate));
      if (invoiceRank !== 0) return invoiceRank;
      return side === "BUY" ? b.candidate.price - a.candidate.price : a.candidate.price - b.candidate.price;
    });
    const survivor = sorted[0];
    for (const e of sorted.slice(1)) {
      // Uncertain-match guard: a same-signature sibling whose price sits
      // clearly apart from the survivor's may be a genuinely different
      // trade (two distinct same-day orders of the same share count), not
      // a re-read. A false merge silently loses a real transaction; an
      // extra pending row just waits for the user — so when in doubt,
      // leave it pending instead of suggesting deletion.
      if (!sameCandidateExecution(e.candidate, survivor.candidate)) continue;
      keysToDelete.push(e.key);
    }
  }
  return keysToDelete;
}

/**
 * Cross-document field completion: when the same real transaction (same
 * signature, price within sibling tolerance) was read from more than one
 * document and one read carries a field the other misses — fees/taxes from
 * an invoice, execution time from an orders screenshot — copy the missing
 * field onto the read that lacks it instead of leaving the eventual
 * committed trade with a default. Strictly additive: an already-present
 * value is NEVER overwritten, and nothing is merged across reads whose
 * prices disagree (they may be different real trades). Returns only the
 * keys that gain at least one field.
 *
 * Also backfills transactionNumber: a statement row never prints one, but
 * when the same execution is also read from an invoice in the same batch,
 * the resulting committed Trade should still carry the invoice's ID —
 * otherwise a LATER re-import of just the statement (without the invoice
 * alongside it again) has nothing to match against but the price/date/shares
 * heuristic, throwing away the stronger signal this batch already had.
 *
 * Also raises confidence to "high" whenever a target has at least one
 * different-source, same-execution donor — the same corroboration
 * findCrossSourceVerifiedKeys uses to badge a row "confirmed by two
 * documents," applied here to the field mismatch/wrong-ticker heuristics
 * actually rank by (mismatchResolver's confidenceRank,
 * findWrongTickerCandidateKeys' wrongTickerConfidenceRank) so a row two
 * independent documents agree on stops being outranked by an uncorroborated
 * single-document read that merely happened to OCR cleanly. Confidence is
 * only ever raised, never lowered.
 */
export function completeCandidateFieldsFromSiblings(
  entries: { key: string; candidate: ParsedTradeCandidate }[]
): Map<string, Partial<Pick<ParsedTradeCandidate, "fees" | "taxes" | "time" | "transactionNumber" | "confidence">>> {
  const bySignature = new Map<string, { key: string; candidate: ParsedTradeCandidate }[]>();
  for (const e of entries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = bySignature.get(sig) ?? [];
    list.push(e);
    bySignature.set(sig, list);
  }

  const completions = new Map<
    string,
    Partial<Pick<ParsedTradeCandidate, "fees" | "taxes" | "time" | "transactionNumber" | "confidence">>
  >();
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    for (const target of group) {
      // A legacy untyped candidate (pre-source session) could be from any
      // document type — the same reason findCrossSourceVerifiedKeys never
      // pairs it with a typed non-invoice read. Don't auto-enrich it either.
      if (target.candidate.source === undefined) continue;
      const patch: Partial<Pick<ParsedTradeCandidate, "fees" | "taxes" | "time" | "transactionNumber" | "confidence">> = {};
      // Invoice-sourced donors first — labeled fields beat OCR-positional ones.
      const donors = group
        .filter(
          (d) =>
            d.key !== target.key &&
            d.candidate.source !== undefined &&
            d.candidate.source !== target.candidate.source &&
            sameCandidateExecution(d.candidate, target.candidate),
        )
        .sort((a, b) => Number(isInvoiceSourced(b.candidate)) - Number(isInvoiceSourced(a.candidate)));
      for (const donor of donors) {
        if (target.candidate.fees === undefined && donor.candidate.fees !== undefined && patch.fees === undefined)
          patch.fees = donor.candidate.fees;
        if (target.candidate.taxes === undefined && donor.candidate.taxes !== undefined && patch.taxes === undefined)
          patch.taxes = donor.candidate.taxes;
        if (target.candidate.time === undefined && donor.candidate.time !== undefined && patch.time === undefined)
          patch.time = donor.candidate.time;
        if (
          target.candidate.transactionNumber === undefined &&
          donor.candidate.transactionNumber !== undefined &&
          patch.transactionNumber === undefined
        )
          patch.transactionNumber = donor.candidate.transactionNumber;
      }
      if (donors.length > 0 && target.candidate.confidence !== "high") patch.confidence = "high";
      if (Object.keys(patch).length > 0) completions.set(target.key, patch);
    }
  }
  return completions;
}

/**
 * The dual-source verification rule: the same real transaction (same
 * ticker+side+date+share count, ignoring price the same way the
 * sibling-duplicate check above does) read from TWO DIFFERENT document
 * types — statement + invoice, statement + orders screenshot, invoice +
 * orders screenshot, CSV export + anything, and so on — is independently
 * corroborated, and every candidate in such a group is flagged verified.
 * Which pair of types doesn't matter; that they're two independent
 * documents does. Two reads from the SAME type never pair (two overlapping
 * statements, two re-takes of one orders screen — that's a re-upload of
 * the same information, not independent confirmation), which is also why
 * this can't be fooled by the duplicate-file case. Resolves exactly what a
 * broker "My Position" total can't: a ticker whose extracted total won't
 * reconcile no matter how the individual rows are read, because the
 * mismatch is hiding inside rows that never got a second, independent
 * document to confirm them.
 *
 * A candidate extracted before ParsedTradeCandidate.source existed
 * (undefined source, still sitting in an old session) could be from any
 * screenshot type, so undefined never pairs with another undefined or with
 * a typed non-invoice source — only the original invoice+anything rule
 * still applies to it, exactly the behavior it had when it was extracted.
 *
 * This never decides which of the pair to keep for commit — that's still
 * suggestDuplicatePendingCandidateKeysToDelete's job (same signature, same
 * price-priority rule). It only flags that the transaction itself is
 * corroborated, for checkTickerMatch to treat as self-verified without a
 * broker screenshot.
 */
export function findCrossSourceVerifiedKeys(entries: { key: string; candidate: ParsedTradeCandidate }[]): Set<string> {
  const bySignature = new Map<string, { key: string; candidate: ParsedTradeCandidate }[]>();
  for (const e of entries) {
    const sig = pendingCandidateSignature(e.candidate);
    const list = bySignature.get(sig) ?? [];
    list.push(e);
    bySignature.set(sig, list);
  }

  const verifiedKeys = new Set<string>();
  for (const group of bySignature.values()) {
    const definedSources = new Set(group.map((e) => e.candidate.source).filter((s): s is NonNullable<typeof s> => s !== undefined));
    const hasLegacyUntyped = group.some((e) => e.candidate.source === undefined);
    const dualSourced = definedSources.size >= 2 || (definedSources.has("invoice") && hasLegacyUntyped);
    if (!dualSourced) continue;
    // Uncertain-match guard: sharing a signature is not enough — the two
    // documents must also agree on price (within the same tolerance the
    // sibling-duplicate check trusts). Two genuinely different same-day
    // trades of the same share count would otherwise "verify" each other,
    // and a false verification badge is worse than a row that waits for a
    // real corroborating document.
    for (const e of group) {
      const corroborated = group.some(
        (o) =>
          o.key !== e.key &&
          o.candidate.source !== e.candidate.source &&
          sameCandidateExecution(o.candidate, e.candidate),
      );
      if (corroborated) verifiedKeys.add(e.key);
    }
  }
  return verifiedKeys;
}

/** Subset-sum search cap for findAggregateStatementMatches — bounds the pool of same-ticker/side/day executions a Statement row is searched against, mirroring mismatchResolver's MAX_RECONCILE_ROWS cap on combinatorial searches. */
export const MAX_AGGREGATE_MATCH_POOL = 30;

interface AggregatePoolItem {
  key: string;
  shares: number;
  price: number;
}

/**
 * Smallest-cardinality exact subset of `items` whose shares sum to `target`,
 * or undefined when none exists. A 0/1-knapsack subset-sum DP keyed by
 * reachable share totals (not by row combinations), so its cost is
 * polynomial in the target share count rather than exponential in the row
 * count — the "avoid exponential brute force" requirement for aggregate
 * reconciliation. Snapshots the reachable-sums map before each item so an
 * item is never used twice within one subset.
 */
function smallestExactSharesSubset(items: AggregatePoolItem[], target: number): string[] | undefined {
  if (target <= 0) return undefined;
  const bestByTotal = new Map<number, string[]>([[0, []]]);
  for (const item of items) {
    for (const [total, keys] of [...bestByTotal.entries()]) {
      const nextTotal = total + item.shares;
      if (nextTotal > target) continue;
      const existing = bestByTotal.get(nextTotal);
      if (!existing || keys.length + 1 < existing.length) {
        bestByTotal.set(nextTotal, [...keys, item.key]);
      }
    }
  }
  return bestByTotal.get(target);
}

function aggregateGroupKey(c: { ticker: string; side: "BUY" | "SELL"; date: string }): string {
  return `${normalizeTicker(c.ticker)}|${c.side}|${c.date}`;
}

/**
 * Statement Aggregate Reconciliation, Case 2: a broker Statement sometimes
 * prints one row summarizing several same-day executions from a
 * higher-detail source (an Orders/Transactions screen, an Invoice, a CSV
 * export — any typed, non-statement candidate) instead of one row per
 * execution. findCrossSourceVerifiedKeys already resolves Case 1 (one
 * Statement row confirming exactly one execution of the identical share
 * count) via plain signature matching; this only runs for a Statement row
 * that did NOT already resolve that way (see `alreadyVerifiedKeys`), and
 * searches for a GROUP of same ticker+side+day executions whose shares sum
 * EXACTLY to the Statement row's. A Statement never splits a real trade, only
 * aggregates several, so only Statement→group is searched, never a group of
 * Statement rows against one execution.
 *
 * Matching conditions, all required: same ticker, same side, same date
 * (a Statement's settlement qualifiers like "T+1"/"Same Day" are already
 * stripped to the execution date at parse time — see ThndrParser — so this
 * is a plain equality, no separate tolerance to add); the matched group's
 * shares-weighted average price within the same cross-document tolerance
 * `sameCandidateExecution` already trusts (`siblingPricesClose`) — a
 * Statement's printed price for an aggregate row is itself a commission-
 * inclusive blend across the underlying executions, so comparing against a
 * single raw execution price would be too strict; and exact quantity
 * equality after aggregation (the subset-sum search below only ever
 * considers a target it can hit exactly — no partial/approximate sums).
 *
 * Prefers the smallest exact matching group (fewest executions) via
 * `smallestExactSharesSubset`. Each execution is consumed by at most one
 * Statement row — rows are processed smallest-shares-first and matched keys
 * are removed from the pool before the next row searches — so the same real
 * execution can never back two different Statement rows' aggregates, and a
 * Statement row that finds no exact combination is left unmatched for the
 * user to review, exactly as today.
 *
 * Returns Statement candidate key -> the execution keys it aggregates.
 * Callers (ImportPage) treat a matched Statement row as confirmed by (not a
 * duplicate trade alongside) its execution group: the Statement row is
 * skipped from commit the same way an exact ledger duplicate already is,
 * while the execution group commits normally and is marked verified.
 */
export function findAggregateStatementMatches(
  entries: { key: string; candidate: ParsedTradeCandidate }[],
  alreadyVerifiedKeys: ReadonlySet<string> = new Set(),
): Map<string, string[]> {
  const statementEntries = entries.filter((e) => e.candidate.source === "statement" && !alreadyVerifiedKeys.has(e.key));
  if (statementEntries.length === 0) return new Map();

  const poolByGroup = new Map<string, AggregatePoolItem[]>();
  for (const e of entries) {
    if (e.candidate.source === undefined || e.candidate.source === "statement") continue;
    const key = aggregateGroupKey(e.candidate);
    const list = poolByGroup.get(key) ?? [];
    list.push({ key: e.key, shares: e.candidate.shares, price: e.candidate.price });
    poolByGroup.set(key, list);
  }

  const consumed = new Set<string>();
  const result = new Map<string, string[]>();
  const orderedStatementEntries = [...statementEntries].sort((a, b) => a.candidate.shares - b.candidate.shares);

  for (const stmt of orderedStatementEntries) {
    const groupKey = aggregateGroupKey(stmt.candidate);
    const available = (poolByGroup.get(groupKey) ?? []).filter((i) => !consumed.has(i.key));
    if (available.length === 0 || available.length > MAX_AGGREGATE_MATCH_POOL) continue;

    const matchedKeys = smallestExactSharesSubset(available, stmt.candidate.shares);
    if (!matchedKeys || matchedKeys.length === 0) continue;

    const matchedKeySet = new Set(matchedKeys);
    const matchedItems = available.filter((i) => matchedKeySet.has(i.key));
    const totalShares = matchedItems.reduce((sum, i) => sum + i.shares, 0);
    const weightedAvgPrice = matchedItems.reduce((sum, i) => sum + i.price * i.shares, 0) / totalShares;
    if (!siblingPricesClose(weightedAvgPrice, stmt.candidate.price)) continue;

    for (const key of matchedKeys) consumed.add(key);
    result.set(stmt.key, matchedKeys);
  }
  return result;
}

/**
 * Corroboration confidence bump, generalized and made LIVE: a still-pending
 * Buy/Sell independently confirmed by two different document types
 * (findCrossSourceVerifiedKeys) or by a Statement aggregate
 * (findAggregateStatementMatches) is at least as trustworthy as the exact
 * 1:1 same-signature cross-source pair completeCandidateFieldsFromSiblings
 * already raises to "high" confidence — same philosophy (corroboration
 * raises confidence, NEVER lowers it), applied to whatever `corroboratedKeys`
 * the caller currently considers confirmed rather than only the exact-
 * signature grouping completeCandidateFieldsFromSiblings can see. Unlike
 * that function (a one-shot patch applied only at upload/extraction time),
 * this is meant to be re-evaluated on every render against the live,
 * currently-computed verification sets — a corroboration that only
 * completes on a LATER upload (the second document arriving after the
 * first has sat pending a while), or a Statement aggregate match (which
 * never shares an exact signature with the group it summarizes, so
 * completeCandidateFieldsFromSiblings never sees it at all), still gets
 * reflected instead of staying frozen at its original low/medium read.
 *
 * Returns only the keys that actually need raising (current confidence
 * isn't already "high") — callers use this to skip a no-op state write.
 */
export function keysToRaiseToHighConfidence(
  entries: { key: string; candidate: ParsedTradeCandidate }[],
  corroboratedKeys: ReadonlySet<string>,
): string[] {
  return entries.filter((e) => e.candidate.confidence !== "high" && corroboratedKeys.has(e.key)).map((e) => e.key);
}

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

/**
 * Finds Dividend events already sitting on the ledger that duplicate each
 * other — the cross-session import dedup (isDividendAlreadyRecorded) only
 * stops *new* duplicates; this is for the ones recorded before that guard
 * existed, or from a manual double-entry. Unlike a duplicate buy/sell (where
 * a price difference between the two reads makes one the more plausible
 * real transaction), two dividend events with the same ticker/date/amount
 * are, for all practical purposes, the same real payment recorded twice —
 * so it's safe to suggest deleting every one but the first in each group.
 */
export function suggestDuplicateDividendIdsToDelete(events: TimelineEvent[]): string[] {
  const byKey = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    if (e.type !== "Dividend" || !e.ticker || e.amount === undefined) continue;
    const key = dividendContentKey({ ticker: e.ticker, date: e.timestamp.slice(0, 10), amount: e.amount });
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }

  const idsToDelete: string[] = [];
  for (const list of byKey.values()) {
    for (const e of list.slice(1)) idsToDelete.push(e.id);
  }
  return idsToDelete;
}

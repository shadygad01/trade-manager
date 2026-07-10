import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { UploadCloud, FileText, ShieldCheck, ShieldAlert, CheckCircle2, Loader2, RotateCcw, CircleDollarSign, History, Pencil, Trash2, XCircle, Eraser, ChevronDown } from "lucide-react";
import { repos, getImportOrchestrator, purgeTickerData } from "@presentation/lib/data";
import { recordBuy, deleteTrade, renameTickerEverywhere } from "@application/services/TradeService";
import { recordDividend } from "@application/services/PortfolioService";
import { recordImportedRawTransactions } from "@application/services/importRecording";
import { assignPortfolio, retractRawTransaction } from "@application/services/commitEngine";
import {
  findDuplicateBuyMatch,
  findDuplicateSellMatch,
  pricesWithinOcrNoise,
  dividendContentKey,
  buildExistingDividendKeys,
  suggestDuplicatePendingCandidateKeysToDelete,
  completeCandidateFieldsFromSiblings,
  findCrossSourceVerifiedKeys,
  findAggregateStatementMatches,
  keysToRaiseToHighConfidence,
  findWrongTickerCandidateKeys,
  findDateMisreadDuplicateHints,
} from "@application/services/duplicateDetection";
import { checkTickerMatch, isTickerFullyResolved, type TickerMatchStatus } from "@application/services/importVerification";
import {
  orderEvidenceContentKey,
  findOrderConfirmedKeys,
  findOrphanedFulfilledEvidence,
  findWrongTickerHintsFromOrders,
} from "@application/services/orderEvidence";
import { suggestRemovalsToReconcile, MAX_RECONCILE_ROWS, type ReconcileSuggestion } from "@application/services/mismatchResolver";
import { findLastBalancedDate } from "@application/services/netShareTimeline";
import { buildTickerConstraintReport, type TickerConstraintReport } from "@application/services/constraintValidation";
import { assessTickerCompleteness, type TickerCompletenessReport } from "@application/services/completenessEngine";
import type { TickerStatus } from "@application/services/verificationEngine";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { tickerForCompanyNameFallback } from "@domain/value-objects/knownTickers";
import { isBeforeTrackingStart } from "@domain/value-objects/trackingWindow";
import { useTrackingStartDate, trackingStartDateStore } from "@presentation/lib/trackingStartDateStore";
import type { ParsedTradeCandidate, ParsedOrderEvidence, Upload } from "@domain/entities/Upload";
import type { Trade } from "@domain/entities/Trade";
import {
  importSession,
  useImportSession,
  type CandidateEntry,
  type VerificationEntry,
  type DividendEntry,
  type OrderEvidenceEntry,
} from "@presentation/lib/importSession";
import { PageHeader } from "@presentation/components/PageHeader";
import { Modal } from "@presentation/components/Modal";
import { EmptyState } from "@presentation/components/EmptyState";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { STATUS } from "@presentation/lib/chartColors";
import { useT, type TFunction } from "@presentation/i18n/translations";

const CONFIDENCE_COLOR: Record<"high" | "medium" | "low", string> = {
  high: STATUS.good,
  medium: STATUS.warning,
  low: STATUS.critical,
};

function confidenceLabel(t: TFunction, confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return t("importPage.confidenceHigh");
  if (confidence === "medium") return t("importPage.confidenceMedium");
  return t("importPage.confidenceLow");
}

type Stage = "idle" | "reading" | "error";

/**
 * Position-verification and dividend candidates carry no per-transaction
 * identity of their own (unlike a Buy/Sell, which has a date+price+shares
 * to distinguish one execution from another) — re-uploading the same "My
 * Position" screenshot (a re-take, an accidental double-drop, or the same
 * PDF page appearing twice) re-extracts an identical reading every time.
 * These keys let processFiles() recognize "this is the same observation
 * already in the pool" and skip adding a redundant duplicate, rather than
 * piling up N identical "Accept as ground truth" rows for one real position.
 */
function verificationContentKey(v: { ticker: string; units: number; avgCost?: number }): string {
  return `${normalizeTicker(v.ticker)}|${v.units}|${v.avgCost ?? ""}`;
}

/**
 * Phase 9.7: every Skip/Dismiss/Discard action calls this so the canonical
 * RawTransaction history reflects the same intent the localStorage session
 * already records — a retracted row is permanently excluded from
 * VerificationEngine/CommitEngine (see rawTransactionFolds.isRetracted), the
 * same fold every other reader of the raw log already applies. Fire-and-
 * forget, isolated, non-fatal — same shadow-write discipline as every other
 * dual-write in this migration (assignPortfolio, recordImportedRawTransactions):
 * a failure here must never break today's working Import behavior, which
 * still reads only from the localStorage pending pool. Each `key` here is
 * expected to equal the RawTransaction id recordImportedRawTransactions wrote
 * for it (see importRecording.ts) — a key from before that change shipped
 * simply retracts nothing (no RawTransaction has that id), which is inert,
 * not harmful.
 */
function retractRawTransactionKeys(keys: Iterable<string>) {
  for (const key of keys) {
    retractRawTransaction(repos, key).catch((err) => {
      console.error("retractRawTransaction failed (shadow write, non-fatal):", err);
    });
  }
}

/**
 * Guards the batch commit against a genuine race: two triggers (e.g. a
 * duplicate Confirm click, or a rename firing while a commit is already in
 * flight) could otherwise both see the same entry as "not yet added" and
 * call recordBuy/recordDividend/acceptVerification on it twice, since the
 * check-then-act happens across an await. Module-level (not React state,
 * which only updates asynchronously) so the guard is synchronous: an entry
 * is marked in-flight before its first await and cleared in a finally,
 * regardless of how many times commitTickerGroup gets invoked concurrently.
 */
const inFlightKeys = new Set<string>();

/**
 * Import runs as a strict two-phase workflow: (1) extract — drop as many
 * files as needed; every candidate/verification accumulates into one pool,
 * confirmed complete by the running "N transactions from M files" count —
 * then (2) verify & distribute — group everything by ticker, assign ONE
 * portfolio per ticker (so a stock's sells automatically travel with its
 * buys), and reconcile each ticker's extracted share count against a broker
 * "My Position" screenshot. Nothing is written to a portfolio until every
 * ticker's count matches its screenshot exactly and the user explicitly
 * clicks "Confirm — Distribute to Portfolios" — see tickerMatchStatuses and
 * confirmAndDistributeAll. A Sell always still opens its own allocation
 * modal (ADR-002 — this app never auto-picks which lot a sell closes).
 *
 * The pool itself lives in `importSession` (module-level, localStorage-backed),
 * not component state — a user often needs to leave this page mid-import to
 * create a portfolio to distribute into, and plain useState would have thrown
 * away everything extracted so far the moment the page unmounted.
 */
export function ImportPage() {
  const t = useT();
  const trackingStartDate = useTrackingStartDate();
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [queueProgress, setQueueProgress] = useState<{ index: number; total: number; fileName: string } | null>(null);
  const [recentFileResults, setRecentFileResults] = useState<{ fileName: string; warnings: string[]; duplicate: boolean }[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [sellCandidate, setSellCandidate] = useState<{ key: string; ticker: string; portfolioId: string; candidate: ParsedTradeCandidate } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [distributing, setDistributing] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);

  const session = useImportSession();
  const { pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences, tickerPortfolio, filesProcessed } = session;

  /**
   * Every extraction path already filters a Buy/Sell candidate dated before
   * the configured tracking start date at parse time (see
   * trackedDateRange.ts) — but ThndrParser's dividend extraction didn't,
   * until a real out-of-range dividend reached this pool, sat there looking
   * normal, and only surfaced as a thrown error the moment the user tried to
   * confirm it. Silently dropping any out-of-range candidate/dividend still
   * sitting in the pool — regardless of which extraction path let it
   * through, including ones already stuck in a session from before this fix
   * — means there's never a row that can only ever fail to commit. Also
   * re-runs whenever the user lowers/raises the start date on this page, so
   * rows that fall outside the newly-picked range are dropped immediately
   * rather than surviving until the next file is imported.
   */
  useEffect(() => {
    const hasStaleCandidates = pendingCandidates.some((e) => isBeforeTrackingStart(e.candidate.date));
    const hasStaleDividends = pendingDividends.some((e) => isBeforeTrackingStart(e.dividend.date));
    if (!hasStaleCandidates && !hasStaleDividends) return;
    importSession.update((prev) => ({
      ...prev,
      pendingCandidates: prev.pendingCandidates.filter((e) => !isBeforeTrackingStart(e.candidate.date)),
      pendingDividends: prev.pendingDividends.filter((e) => !isBeforeTrackingStart(e.dividend.date)),
    }));
  }, [pendingCandidates, pendingDividends, trackingStartDate]);

  const addedKeys = useMemo(() => new Set(session.addedKeys), [session.addedKeys]);
  const acceptedKeys = useMemo(() => new Set(session.acceptedKeys), [session.acceptedKeys]);
  const skippedKeys = useMemo(() => new Set(session.skippedKeys), [session.skippedKeys]);
  const dismissedKeys = useMemo(() => new Set(session.dismissedKeys), [session.dismissedKeys]);

  const portfoliosRaw = useLiveQuery(() => repos.portfolios.getAll(), []);
  const portfolios = portfoliosRaw ?? [];

  // Loaded across every portfolio so a candidate is flagged as a possible
  // duplicate regardless of which portfolio it's ultimately assigned to.
  const existingTradesRaw = useLiveQuery(() => repos.trades.getAll(), []);
  const existingTrades = existingTradesRaw ?? [];
  const existingAllocationsRaw = useLiveQuery(() => repos.allocations.getAll(), []);
  const existingAllocations = existingAllocationsRaw ?? [];
  // Ground truth for the verification gate below — a broker "My Position"
  // screenshot accepted in an earlier session still counts as this ticker's
  // reference even if this batch re-extracts more buys/sells for it.
  const existingVerificationsRaw = useLiveQuery(() => repos.verifications.getAll(), []);
  const existingVerifications = existingVerificationsRaw ?? [];
  // A dividend already recorded in an earlier import session is otherwise
  // invisible to the in-session dedup below (seenDividendKeys), which only
  // ever sees the current batch's pending pool — the same broker statement
  // re-uploaded weeks later (its dividend history overlapping what's already
  // recorded) would silently double-count real cash. Global like existingTrades:
  // a real dividend payment happened once regardless of which portfolio it's filed under.
  const existingTimelineRaw = useLiveQuery(() => repos.timeline.getAll(), []);
  const existingDividendKeys = useMemo(() => buildExistingDividendKeys(existingTimelineRaw ?? []), [existingTimelineRaw]);

  /**
   * useLiveQuery returns undefined until its first read resolves, then an
   * array from then on — including a genuinely empty one. The verification
   * gate and commit logic must tell those apart: firing while any of these
   * is still undefined would decide duplicate/portfolio-resolution/match
   * status off of default-empty data (e.g. missing an already-recorded
   * exact-duplicate trade because existingTrades briefly reads as [] before
   * its first real load), and by the time the real data arrives a row
   * committed off the stale read is no longer eligible for reconsideration.
   */
  const initialDataLoaded =
    portfoliosRaw !== undefined &&
    existingTradesRaw !== undefined &&
    existingAllocationsRaw !== undefined &&
    existingVerificationsRaw !== undefined &&
    existingTimelineRaw !== undefined;

  /**
   * `ownTradeId` (Buys) / `ownAllocationIds` (Sells) exclude a candidate's
   * own already-committed records from the comparison pool — without them, a
   * row that was itself just added would "match" the exact Trade/allocations
   * it just became (identical ticker/date/shares/price by construction),
   * showing a false "Duplicate" badge on a perfectly successful,
   * non-duplicate commit. Only matters for the per-row display after commit;
   * the pre-commit skip check in commitTickerGroup runs before this
   * candidate's own records exist, so it never needs an exclusion.
   */
  function duplicateMatch(candidate: ParsedTradeCandidate, ownTradeId?: string, ownAllocationIds?: string[]) {
    if (candidate.side === "BUY") {
      const trades = ownTradeId ? existingTrades.filter((t) => t.id !== ownTradeId) : existingTrades;
      return findDuplicateBuyMatch(candidate, trades);
    }
    const allocations = ownAllocationIds?.length
      ? existingAllocations.filter((a) => !ownAllocationIds.includes(a.id))
      : existingAllocations;
    return findDuplicateSellMatch(candidate, allocations);
  }

  /**
   * A pending Buy or Sell that's an exact duplicate of a trade/allocation
   * already on the ledger (same ticker/date/shares/price — e.g. the same
   * file, or the same real execution, re-imported) has nothing left to do:
   * committing it again would double-count real shares. This must run
   * BEFORE tickerMatchStatuses, not only at commit time inside
   * commitTickerGroup: an un-skipped duplicate still counts toward
   * pendingBuyShares/pendingSellShares in the net-share reconciliation,
   * which can hold a ticker at "Mismatch"/"Blocked — needs verification"
   * forever even when the ledger and a broker "My Position" screenshot
   * already agree exactly — commitTickerGroup's own skip only ever runs for
   * a ticker `tickerMatchStatuses` already reports as matched, so it can
   * never break that particular chicken-and-egg deadlock on its own (a real
   * gap found and reproduced during the reconciliation investigation: a
   * ticker whose only pending row was an exact re-import of an
   * already-fully-recorded, already-broker-verified position stayed
   * permanently "Mismatch"). Auto-marking the duplicate skipped here
   * resolves it the same way the Sell side already did on its own before
   * this was generalized to cover Buys too. This never commits anything
   * itself (ADR-002 — which lots a sell closes stays a manual decision for
   * a genuinely new Sell); it only closes a row whose real-world
   * transaction is already fully recorded. Gated on initialDataLoaded so a
   * briefly-empty trades/allocations read can't mislabel (or fail to label)
   * a row off stale data.
   */
  useEffect(() => {
    if (!initialDataLoaded) return;
    const state = importSession.getState();
    const ownAllocs = state.addedAllocationIds ?? {};
    const keysToSkip = state.pendingCandidates
      .filter(
        (e) =>
          !state.addedKeys.includes(e.key) &&
          !state.skippedKeys.includes(e.key) &&
          !state.dismissedKeys.includes(e.key) &&
          (() => {
            const m = duplicateMatch(e.candidate, undefined, ownAllocs[e.key]);
            return m !== undefined && (m.matchType === "exact" || pricesWithinOcrNoise(m.matchedPrice, e.candidate.price));
          })(),
      )
      .map((e) => e.key);
    if (keysToSkip.length === 0) return;
    importSession.update((prev) => ({ ...prev, skippedKeys: [...new Set([...prev.skippedKeys, ...keysToSkip])] }));
    retractRawTransactionKeys(keysToSkip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initialDataLoaded,
    pendingCandidates,
    existingTrades,
    existingAllocations,
    session.addedKeys,
    session.skippedKeys,
    session.dismissedKeys,
  ]);

  /**
   * Statement Aggregate Reconciliation: a Statement row that sums several
   * same-day executions from a higher-detail source (Orders, an Invoice, a
   * CSV export) into one printed quantity (see
   * findAggregateStatementMatches) is confirmation of that execution group,
   * not a separate transaction — committing it alongside the group it
   * summarizes would double-count real shares exactly the way an un-skipped
   * ledger duplicate would. Auto-skipped here on the same terms as the exact-
   * duplicate effect above: only once every match condition (ticker, side,
   * day, exact share sum, compatible price) is satisfied, and only for a
   * Statement row that doesn't already have a direct 1:1 cross-source match
   * (see findCrossSourceVerifiedKeys, computed fresh here rather than reused
   * from the render-time crossVerifiedKeys memo so this effect stays
   * self-contained like its sibling above). The matched execution rows
   * themselves are never skipped — they commit normally and are surfaced as
   * "Confirmed by Statement" via aggregateConfirmedKeys below.
   */
  useEffect(() => {
    if (!initialDataLoaded) return;
    const state = importSession.getState();
    const stillPending = state.pendingCandidates.filter(
      (e) => !state.addedKeys.includes(e.key) && !state.skippedKeys.includes(e.key) && !state.dismissedKeys.includes(e.key),
    );
    const crossSourceVerified = findCrossSourceVerifiedKeys(stillPending);
    const aggregateMatches = findAggregateStatementMatches(stillPending, crossSourceVerified);
    if (aggregateMatches.size === 0) return;
    const keysToSkip = [...aggregateMatches.keys()];
    importSession.update((prev) => ({ ...prev, skippedKeys: [...new Set([...prev.skippedKeys, ...keysToSkip])] }));
    retractRawTransactionKeys(keysToSkip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDataLoaded, pendingCandidates, session.addedKeys, session.skippedKeys, session.dismissedKeys]);

  /**
   * A ticker that already has trades recorded somewhere shouldn't make the
   * user re-pick a portfolio every time it's re-imported — this is the
   * "suggest the portfolio it already lives in" behavior. When it lives in
   * more than one portfolio, this is deliberately ambiguous (no auto-pick):
   * the user has to say which one these new rows belong to.
   */
  const existingPortfoliosByTicker = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const t of existingTrades) {
      const key = normalizeTicker(t.ticker);
      const set = map.get(key) ?? new Set<string>();
      set.add(t.portfolioId);
      map.set(key, set);
    }
    return map;
  }, [existingTrades]);

  /**
   * Every already-recorded (real, committed) Trade for a ticker, grouped for
   * TickerGroupCard's "Recorded on the ledger" panel — the direct-delete
   * tool for a blocked ticker whose problem is a duplicate/misread buy
   * already on the ledger rather than anything still pending (see
   * deleteExistingTrade). Global across portfolios like
   * existingPortfoliosByTicker, since the panel's job is to help the user
   * find the offending row wherever it actually is.
   */
  const existingTradesByTicker = useMemo(() => {
    const map = new Map<string, Trade[]>();
    for (const t of existingTrades) {
      const key = normalizeTicker(t.ticker);
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return map;
  }, [existingTrades]);

  function portfolioForTicker(ticker: string): string {
    if (tickerPortfolio[ticker]) return tickerPortfolio[ticker];
    const existing = existingPortfoliosByTicker.get(ticker);
    if (existing && existing.size === 1) return [...existing][0];
    return portfolios[0]?.id ?? "";
  }

  /**
   * The confident subset of portfolioForTicker's result: undefined whenever
   * the choice would be a guess (a brand-new ticker with more than one
   * portfolio open, and no explicit pick yet) rather than a real answer.
   * Auto-commit only ever fires once this resolves — landing money in the
   * wrong portfolio is exactly the risk manual assignment existed to avoid,
   * so ambiguity still waits on the user picking from the dropdown.
   */
  function resolvedPortfolioId(ticker: string): string | undefined {
    if (tickerPortfolio[ticker]) return tickerPortfolio[ticker];
    const existing = existingPortfoliosByTicker.get(ticker);
    if (existing && existing.size === 1) return [...existing][0];
    if ((!existing || existing.size === 0) && portfolios.length === 1) return portfolios[0].id;
    return undefined;
  }

  function setTickerPortfolio(ticker: string, portfolioId: string) {
    importSession.update((prev) => ({ ...prev, tickerPortfolio: { ...prev.tickerPortfolio, [ticker]: portfolioId } }));

    // Migration dual-write: also assigns every still-unassigned
    // RawTransaction for this ticker to the chosen portfolio (see
    // commitEngine.assignPortfolio), which is what lets the new
    // architecture's reactive commit trigger fire for it at all — Import
    // itself never assigns a portfolio (see importRecording.ts). Isolated
    // and non-fatal for the same reason as the dual-write in processFiles.
    assignPortfolio(repos, ticker, portfolioId).catch((err) => {
      console.error("assignPortfolio failed (shadow write, non-fatal):", err);
    });
  }

  async function processFiles(files: File[]) {
    if (files.length === 0) return;
    setStage("reading");
    setErrorMessage("");
    let seq = importSession.getState().uploadSeq;
    const batchResults: typeof recentFileResults = [];

    try {
      const orchestrator = await getImportOrchestrator();
      for (let i = 0; i < files.length; i++) {
        const currentFile = files[i];
        setQueueProgress({ index: i + 1, total: files.length, fileName: currentFile.name });

        const result = await orchestrator.importFile(currentFile);
        const existingUpload = await repos.uploads.getByHash(result.fileHash);
        let isDuplicateFile = Boolean(existingUpload);

        // A file whose earlier upload FAILED (e.g. the parser didn't know its
        // format yet) must not stay permanently blocked by its hash — once the
        // app can read it, re-uploading should work. Likewise, a file that
        // yields no trade candidates (evidence/verification/dividend-only
        // screenshots) is session-scoped: the session's own content-key dedup
        // already drops true repeats, so the hash must not block it either.
        if (
          isDuplicateFile &&
          result.status !== "failed" &&
          (existingUpload!.status === "failed" ||
            (result.candidates.length === 0 &&
              (result.orderEvidences.length > 0 || result.verifications.length > 0 || result.dividends.length > 0)))
        ) {
          await repos.uploads.delete(existingUpload!.id);
          isDuplicateFile = false;
        }

        // A file previously imported whose trades were later deleted should
        // not remain permanently blocked by its hash. If any candidate from
        // this file is no longer recorded in the ledger (e.g. a buy that was
        // deleted), treat the file as new so those candidates can be
        // re-imported. This fixes the case where deleting a trade and then
        // re-uploading the original file shows everything as "skipped".
        if (isDuplicateFile && result.candidates.length > 0) {
          const [currentTrades, currentAllocations] = await Promise.all([
            repos.trades.getAll(),
            repos.allocations.getAll(),
          ]);
          const hasUnrecordedCandidate = result.candidates.some((candidate) => {
            if (candidate.side === "BUY") {
              return !findDuplicateBuyMatch(candidate, currentTrades);
            }
            return !findDuplicateSellMatch(candidate, currentAllocations);
          });
          if (hasUnrecordedCandidate) {
            await repos.uploads.delete(existingUpload!.id);
            isDuplicateFile = false;
          }
        }

        if (!isDuplicateFile) {
          const upload: Upload = {
            id: generateId(),
            fileName: currentFile.name,
            fileHash: result.fileHash,
            contentType: currentFile.type || "application/octet-stream",
            status: result.status === "failed" ? "failed" : "parsed",
            candidates: result.candidates,
            rawText: result.rawText,
            fileBlob: result.fileBlob,
            createdAt: new Date().toISOString(),
            parsedAt: new Date().toISOString(),
          };
          await repos.uploads.save(upload);

          // Phase 9.7: keys computed BEFORE the dual-write below (not after,
          // as before) so each candidate/order-evidence row's own session key
          // can be threaded through as its RawTransaction's own `id` — see
          // importRecording.ts's ImportRecordingInput doc comment. This is
          // what lets a later Skip/Dismiss/Discard action retract the exact
          // right row by key, with no separate lookup needed.
          const fileSeq = seq;
          seq += 1;
          const newCandidates = result.candidates.map((candidate, ci) => ({ key: `${fileSeq}-c${ci}`, candidate }));
          const newOrderEvidenceEntries = result.orderEvidences.map((evidence, oi) => ({ key: `${fileSeq}-o${oi}`, evidence }));

          // Migration dual-write: additionally record every parsed candidate
          // as an immutable RawTransaction (see importRecording.ts). No
          // longer shadow data nobody reads — Phase 9.7 made this the
          // authoritative, full-lifecycle record (see the module's own doc
          // comment) — but still isolated in its own try/catch on purpose:
          // a transient IndexedDB failure here must never break today's
          // working Import flow, which the localStorage pending pool below
          // remains the actual source of truth for.
          try {
            await recordImportedRawTransactions(repos, {
              sourceUploadId: upload.id,
              candidates: newCandidates,
              verifications: result.verifications,
              dividends: result.dividends,
              orderEvidences: newOrderEvidenceEntries,
            });
          } catch (err) {
            console.error("recordImportedRawTransactions failed (shadow write, non-fatal):", err);
          }

          let skippedVerifications = 0;
          let skippedDividends = 0;
          let skippedOrderEvidences = 0;
          importSession.update((prev) => {
            const seenVerificationKeys = new Set(prev.pendingVerifications.map((e) => verificationContentKey(e.verification)));
            const newVerifications: VerificationEntry[] = [];
            result.verifications.forEach((verification, vi) => {
              const key = verificationContentKey(verification);
              if (seenVerificationKeys.has(key)) {
                skippedVerifications += 1;
                return;
              }
              seenVerificationKeys.add(key);
              newVerifications.push({ key: `${fileSeq}-v${vi}`, verification });
            });

            const seenDividendKeys = new Set([
              ...prev.pendingDividends.map((e) => dividendContentKey(e.dividend)),
              ...existingDividendKeys,
            ]);
            const newDividends: DividendEntry[] = [];
            result.dividends.forEach((dividend, di) => {
              const key = dividendContentKey(dividend);
              if (seenDividendKeys.has(key)) {
                skippedDividends += 1;
                return;
              }
              seenDividendKeys.add(key);
              newDividends.push({ key: `${fileSeq}-d${di}`, dividend });
            });

            // Deduped only against PREVIOUS files' rows, never within this
            // file's own batch: consecutive scrolled screenshots of the same
            // Orders screen overlap by a few rows (same signature in two
            // files = the overlap), while two identical rows within one
            // screenshot are genuinely two separate orders.
            const seenEvidenceKeys = new Set(prev.pendingOrderEvidences.map((e) => orderEvidenceContentKey(e.evidence)));
            const newOrderEvidences: OrderEvidenceEntry[] = [];
            newOrderEvidenceEntries.forEach(({ key, evidence }) => {
              if (seenEvidenceKeys.has(orderEvidenceContentKey(evidence))) {
                skippedOrderEvidences += 1;
                return;
              }
              newOrderEvidences.push({ key, evidence });
            });

            // Cross-document field completion: the same transaction read
            // from two documents (statement + invoice, invoice + orders
            // screenshot) completes each other's missing fees/taxes/time/
            // transactionNumber — strictly additive, never overwriting a
            // value a document actually carried (see
            // completeCandidateFieldsFromSiblings).
            const combinedCandidates = [...prev.pendingCandidates, ...newCandidates];
            const fieldCompletions = completeCandidateFieldsFromSiblings(combinedCandidates);
            const completedCandidates =
              fieldCompletions.size === 0
                ? combinedCandidates
                : combinedCandidates.map((e) => {
                    const patch = fieldCompletions.get(e.key);
                    return patch ? { ...e, candidate: { ...e.candidate, ...patch } } : e;
                  });

            return {
              ...prev,
              pendingCandidates: completedCandidates,
              pendingVerifications: [...prev.pendingVerifications, ...newVerifications],
              pendingDividends: [...prev.pendingDividends, ...newDividends],
              pendingOrderEvidences: [...prev.pendingOrderEvidences, ...newOrderEvidences],
            };
          });

          const dedupWarnings: string[] = [];
          if (skippedVerifications > 0) {
            dedupWarnings.push("This position reading matches one already in the list — not added again.");
          }
          if (skippedDividends > 0) {
            dedupWarnings.push(
              `${skippedDividends} dividend${skippedDividends === 1 ? "" : "s"} already in the list or already recorded — not added again.`,
            );
          }
          if (skippedOrderEvidences > 0) {
            dedupWarnings.push(
              `${skippedOrderEvidences} order row${skippedOrderEvidences === 1 ? "" : "s"} already read from an earlier screenshot (overlapping scroll) — not added again.`,
            );
          }
          if (dedupWarnings.length > 0) {
            result.warnings = [...result.warnings, ...dedupWarnings];
          }
        }

        batchResults.push({ fileName: currentFile.name, warnings: result.warnings, duplicate: isDuplicateFile });
        importSession.update((prev) => ({ ...prev, filesProcessed: prev.filesProcessed + 1 }));
      }

      importSession.update((prev) => ({ ...prev, uploadSeq: seq }));
      setRecentFileResults(batchResults);
      setStage("idle");
      setQueueProgress(null);
    } catch (e) {
      importSession.update((prev) => ({ ...prev, uploadSeq: seq }));
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Import failed.");
      setQueueProgress(null);
    }
  }

  function clearRowError(key: string) {
    setRowErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function setRowError(key: string, e: unknown) {
    setRowErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : "Something went wrong." }));
  }

  async function addBuyCandidate(entry: CandidateEntry, ticker: string) {
    try {
      const portfolioId = portfolioForTicker(ticker);
      const { trade } = await recordBuy(repos, {
        portfolioId,
        ticker,
        companyName: entry.candidate.companyName,
        shares: entry.candidate.shares,
        entryPrice: entry.candidate.price,
        fees: entry.candidate.fees ?? 0,
        taxes: entry.candidate.taxes ?? 0,
        executionDate: entry.candidate.date,
        executionTime: entry.candidate.time ?? "00:00",
        notes: "Imported from screenshot/PDF",
        transactionNumber: entry.candidate.transactionNumber,
      });
      importSession.update((prev) => ({
        ...prev,
        addedKeys: [...prev.addedKeys, entry.key],
        addedTradeIds: { ...prev.addedTradeIds, [entry.key]: trade.id },
      }));
      clearRowError(entry.key);
    } catch (e) {
      setRowError(entry.key, e);
    }
  }

  /**
   * Undoes one specific auto-added buy, right from Import — most useful for
   * a low-confidence row the user notices is wrong as soon as it lands.
   * Marked "dismissed" (not just un-added) so auto-commit never silently
   * re-adds a row the user deliberately removed.
   */
  async function deleteAutoAddedTrade(entry: CandidateEntry) {
    const tradeId = importSession.getState().addedTradeIds[entry.key];
    if (!tradeId) return;
    if (!confirm(t("importPage.deleteTradeConfirm"))) {
      return;
    }
    try {
      await deleteTrade(repos, tradeId);
      importSession.update((prev) => {
        const addedTradeIds = { ...prev.addedTradeIds };
        delete addedTradeIds[entry.key];
        return {
          ...prev,
          addedKeys: prev.addedKeys.filter((k) => k !== entry.key),
          dismissedKeys: [...prev.dismissedKeys, entry.key],
          addedTradeIds,
        };
      });
      clearRowError(entry.key);
    } catch (e) {
      setRowError(entry.key, e);
    }
  }

  /**
   * Deletes a trade already sitting on the real ledger for this ticker —
   * not one this Import session added (deleteAutoAddedTrade covers that),
   * but one recorded in an earlier session/import that's now the likely
   * cause of a mismatch (a duplicate buy, a misread quantity). Surfaced
   * directly on a blocked ticker's card (see TickerGroupCard's "Recorded on
   * the ledger" panel) so fixing a duplicate never requires leaving Import
   * for the Trades page and hunting for the right row by hand. Keyed by the
   * trade's own id in the same rowErrors map deleteAutoAddedTrade uses.
   */
  async function deleteExistingTrade(tradeId: string) {
    if (!confirm(t("importPage.deleteTradeConfirm"))) {
      return;
    }
    try {
      await deleteTrade(repos, tradeId);
      clearRowError(tradeId);
    } catch (e) {
      setRowError(tradeId, e);
    }
  }

  /**
   * Commits every pending buy/dividend/verification under one ticker in one
   * go — called only from confirmAndDistributeAll, and only for a ticker
   * whose share count has already reconciled against a broker position
   * screenshot (see tickerMatchStatuses/checkTickerMatch) and whose
   * portfolio has resolved. A buy that's an exact duplicate of an
   * already-recorded trade is skipped silently instead (near-certainly the
   * same transaction re-read from a different file); a "possible" duplicate
   * (same ticker/date/shares, a different price) still commits, since
   * that's usually the same real trade parsed from a different document
   * format, but keeps showing its duplicate badge so it stays visible for a
   * later look. Sells are deliberately excluded — which lot(s) a sell
   * closes is an explicit financial decision this app never auto-picks
   * (ADR-002), so "Allocate Sell" stays a manual action, gated separately on
   * the same match status.
   */
  async function commitTickerGroup(ticker: string) {
    const portfolioId = resolvedPortfolioId(ticker);
    if (!portfolioId) return;

    // Migration dual-write: setTickerPortfolio's own assignPortfolio call
    // only fires when the user explicitly picks from the dropdown —
    // resolvedPortfolioId can also resolve implicitly (a ticker already
    // uniquely tied to one portfolio, or a single-portfolio app), in which
    // case that call never happens and this ticker's RawTransactions would
    // stay unassigned forever, never reaching the new architecture's commit
    // trigger. Calling it here too, on every commit regardless of how the
    // portfolio resolved, closes that gap; it's a harmless no-op once
    // setTickerPortfolio already assigned everything. Isolated and
    // non-fatal for the same reason as every other shadow write here.
    assignPortfolio(repos, ticker, portfolioId).catch((err) => {
      console.error("assignPortfolio failed (shadow write, non-fatal):", err);
    });

    const state = importSession.getState();

    const buys = state.pendingCandidates.filter(
      (e) =>
        normalizeTicker(e.candidate.ticker) === ticker &&
        e.candidate.side === "BUY" &&
        !state.addedKeys.includes(e.key) &&
        !state.skippedKeys.includes(e.key) &&
        !state.dismissedKeys.includes(e.key) &&
        !inFlightKeys.has(e.key),
    );
    for (const entry of buys) {
      inFlightKeys.add(entry.key);
      try {
        const match = duplicateMatch(entry.candidate);
        // "exact" is the same read re-imported; a "possible" match whose price
        // sits within OCR/commission noise of the recorded one is the same
        // real trade parsed from a different document format (value-derived
        // vs raw execution price) — committing it would double-count real
        // shares and break the ticker's verification. Only a possible match
        // with a genuinely different price (>1%) still commits, badge intact.
        if (match && (match.matchType === "exact" || pricesWithinOcrNoise(match.matchedPrice, entry.candidate.price))) {
          importSession.update((prev) => ({ ...prev, skippedKeys: [...new Set([...prev.skippedKeys, entry.key])] }));
          continue;
        }
        await addBuyCandidate(entry, ticker);
      } finally {
        inFlightKeys.delete(entry.key);
      }
    }

    const dividends = state.pendingDividends.filter(
      (e) => normalizeTicker(e.dividend.ticker) === ticker && !state.addedKeys.includes(e.key) && !inFlightKeys.has(e.key),
    );
    for (const entry of dividends) {
      inFlightKeys.add(entry.key);
      try {
        await addDividend(entry, ticker);
      } finally {
        inFlightKeys.delete(entry.key);
      }
    }

    const verifications = state.pendingVerifications.filter(
      (e) => normalizeTicker(e.verification.ticker) === ticker && !state.acceptedKeys.includes(e.key) && !inFlightKeys.has(e.key),
    );
    for (const entry of verifications) {
      inFlightKeys.add(entry.key);
      try {
        await acceptVerification(entry, ticker);
      } finally {
        inFlightKeys.delete(entry.key);
      }
    }
  }

  /**
   * The entry point for actually moving anything into a portfolio. Only
   * ever commits tickers whose match status is already true — Step 1's
   * extraction and Step 2's per-ticker portfolio picks never write a real
   * Trade/Dividend/PositionVerification on their own. This is the two-phase
   * gate: extract-and-verify, then an explicit confirmation before anything
   * is allocated.
   *
   * Commits every currently-matched ticker in one click — deliberately not
   * gated on every ticker in the batch being matched (a single still-stuck
   * ticker, e.g. one still needing "Discard all pending" or a portfolio
   * pick, used to block every other already-verified ticker from
   * distributing at all). confirmTicker below is the same commit, scoped to
   * one ticker, for confirming just that one without waiting on the rest.
   */
  async function confirmAndDistributeAll() {
    // initialDataLoaded gates the button's own `disabled` too, so this should
    // be unreachable in the steady state — but the two are computed from
    // separate useLiveQuery reads on every render, so a click landing in the
    // narrow window where they've gone briefly out of sync must still say
    // something rather than silently doing nothing (see the same historical
    // "silent Import failure" class of bug this page already guards against
    // elsewhere).
    if (!initialDataLoaded) {
      setStage("error");
      setErrorMessage(t("importPage.stillLoadingError"));
      return;
    }
    const matchedTickers = activeTickerGroups
      .filter(([ticker]) => tickerMatchStatuses.get(ticker)?.matched)
      .map(([ticker]) => ticker);
    if (matchedTickers.length === 0) return;
    setDistributing(true);
    try {
      await Promise.all(matchedTickers.map((ticker) => commitTickerGroup(ticker)));
      setStage("idle");
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : t("importPage.confirmFailed"));
    } finally {
      setDistributing(false);
    }
  }

  /** Confirms and distributes just one ticker, independent of any other still-stuck ticker in the same batch. */
  async function confirmTicker(ticker: string) {
    if (!initialDataLoaded) {
      setStage("error");
      setErrorMessage(t("importPage.stillLoadingError"));
      return;
    }
    if (!tickerMatchStatuses.get(ticker)?.matched) return;
    setDistributing(true);
    try {
      await commitTickerGroup(ticker);
      setStage("idle");
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : t("importPage.confirmFailed"));
    } finally {
      setDistributing(false);
    }
  }

  async function clearAll() {
    const uploads = await repos.uploads.getAll();
    await Promise.all(uploads.map((u) => repos.uploads.delete(u.id)));
    importSession.clear();
    setRecentFileResults([]);
  }

  /**
   * Factory-reset for ONE ticker: permanently deletes everything ever
   * recorded for it (trades, allocations, timeline, journal, verifications,
   * raw transactions, ledger caches, and the uploads that carried it — see
   * purgeTickerData) AND every trace of it in this import session, so
   * re-uploading its documents starts from a truly blank slate, as if the
   * stock had never been imported.
   */
  async function resetTickerData(ticker: string) {
    if (!confirm(t("importPage.resetTickerConfirm", { ticker }))) return;
    try {
      await purgeTickerData(ticker);
      importSession.update((prev) => {
        const droppedKeys = new Set<string>();
        for (const e of [...prev.pendingCandidates, ...prev.discardedCandidates]) {
          if (normalizeTicker(e.candidate.ticker) === ticker) droppedKeys.add(e.key);
        }
        for (const e of prev.pendingVerifications) if (normalizeTicker(e.verification.ticker) === ticker) droppedKeys.add(e.key);
        for (const e of prev.pendingDividends) if (normalizeTicker(e.dividend.ticker) === ticker) droppedKeys.add(e.key);
        for (const e of prev.pendingOrderEvidences) if (normalizeTicker(e.evidence.ticker) === ticker) droppedKeys.add(e.key);
        const tickerPortfolio = { ...prev.tickerPortfolio };
        delete tickerPortfolio[ticker];
        return {
          ...prev,
          pendingCandidates: prev.pendingCandidates.filter((e) => !droppedKeys.has(e.key)),
          pendingVerifications: prev.pendingVerifications.filter((e) => !droppedKeys.has(e.key)),
          pendingDividends: prev.pendingDividends.filter((e) => !droppedKeys.has(e.key)),
          pendingOrderEvidences: prev.pendingOrderEvidences.filter((e) => !droppedKeys.has(e.key)),
          discardedCandidates: prev.discardedCandidates.filter((e) => !droppedKeys.has(e.key)),
          addedKeys: prev.addedKeys.filter((k) => !droppedKeys.has(k)),
          acceptedKeys: prev.acceptedKeys.filter((k) => !droppedKeys.has(k)),
          skippedKeys: prev.skippedKeys.filter((k) => !droppedKeys.has(k)),
          dismissedKeys: prev.dismissedKeys.filter((k) => !droppedKeys.has(k)),
          addedTradeIds: Object.fromEntries(Object.entries(prev.addedTradeIds).filter(([k]) => !droppedKeys.has(k))),
          addedAllocationIds: Object.fromEntries(Object.entries(prev.addedAllocationIds).filter(([k]) => !droppedKeys.has(k))),
          tickerPortfolio,
        };
      });
      setStage("idle");
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : t("importPage.resetTickerFailed"));
    }
  }

  /**
   * Discards suggested-duplicate pending candidates outright (unlike a
   * committed trade's delete, which reverses cash — these were never
   * committed, so there's nothing to refund). Never touches an
   * already-added/skipped/dismissed row; only rows still genuinely pending
   * are eligible, matching pendingDuplicateCandidateKeys below.
   */
  /**
   * Discarded rows move to discardedCandidates instead of vanishing: a
   * discarded duplicate is still a real read of its document, and the
   * surviving row's dual-source confirmation must not evaporate the moment
   * the redundant copy is cleaned up for commit.
   */
  function moveToDiscarded(prev: typeof session, keys: Set<string>) {
    // Phase 9.7: fires once here for all four discard entry points below
    // (clearPendingDuplicateCandidates, discardPendingCandidate,
    // discardPendingCandidateKeys, discardAllPendingForTicker) instead of
    // once per call site.
    retractRawTransactionKeys(keys);
    return {
      ...prev,
      pendingCandidates: prev.pendingCandidates.filter((e) => !keys.has(e.key)),
      discardedCandidates: [...prev.discardedCandidates, ...prev.pendingCandidates.filter((e) => keys.has(e.key))],
    };
  }

  function clearPendingDuplicateCandidates() {
    if (pendingDuplicateCandidateKeys.length === 0) return;
    const keys = new Set(pendingDuplicateCandidateKeys);
    importSession.update((prev) => moveToDiscarded(prev, keys));
  }

  /** Discards one order-evidence row read from an Orders screenshot — for a visibly misread row, so it can't wrongly corroborate (or fail to corroborate) anything. */
  function discardOrderEvidence(key: string) {
    importSession.update((prev) => ({
      ...prev,
      pendingOrderEvidences: prev.pendingOrderEvidences.filter((e) => e.key !== key),
    }));
    retractRawTransactionKeys([key]);
  }

  /** Discards one specific still-pending candidate — the single-row counterpart to clearPendingDuplicateCandidates. */
  function discardPendingCandidate(key: string) {
    importSession.update((prev) => moveToDiscarded(prev, new Set([key])));
  }

  /** Discards a named set of still-pending candidates in one shot — used by the mismatch auto-reconcile suggestion (see reconcileSuggestions). */
  function discardPendingCandidateKeys(keys: string[]) {
    importSession.update((prev) => moveToDiscarded(prev, new Set(keys)));
  }

  /**
   * For a ticker flagged alreadyFullyRecorded (see checkTickerMatch): the
   * broker independently confirms the ledger was already correct before
   * this batch, so every pending Buy/Sell for this ticker is re-describing
   * shares already accounted for — not a genuinely new transaction. Unlike
   * clearPendingDuplicateCandidates, this doesn't rely on any individual row
   * matching a specific sibling or existing trade by date+shares, since the
   * whole point is that the existing lots were recorded with a different
   * split than this new read. Never touches verifications (that's the
   * ground truth this decision rests on) or dividends (already deduped
   * separately at extraction time).
   */
  function discardAllPendingForTicker(ticker: string) {
    importSession.update((prev) =>
      moveToDiscarded(
        prev,
        new Set(prev.pendingCandidates.filter((e) => normalizeTicker(e.candidate.ticker) === ticker).map((e) => e.key)),
      ),
    );
  }

  /**
   * Restores ALL dismissed, skipped, and discarded candidates for a specific
   * ticker back to pending — the inverse of the individual trash/skip actions.
   * Useful when a row was accidentally deleted: one tap brings back every
   * hidden row for that ticker so the user can re-evaluate them.
   */
  function restoreTickerCandidates(ticker: string) {
    importSession.update((prev) => {
      const tickerDiscarded = prev.discardedCandidates.filter(
        (e) => normalizeTicker(e.candidate.ticker) === ticker,
      );
      const tickerDiscardedKeys = new Set(tickerDiscarded.map((e) => e.key));
      const tickerPendingKeys = new Set(
        prev.pendingCandidates
          .filter((e) => normalizeTicker(e.candidate.ticker) === ticker)
          .map((e) => e.key),
      );
      const toRestore = new Set([...tickerDiscardedKeys, ...tickerPendingKeys]);
      return {
        ...prev,
        pendingCandidates: [...prev.pendingCandidates, ...tickerDiscarded],
        discardedCandidates: prev.discardedCandidates.filter((e) => !tickerDiscardedKeys.has(e.key)),
        skippedKeys: prev.skippedKeys.filter((k) => !toRestore.has(k)),
        dismissedKeys: prev.dismissedKeys.filter((k) => !toRestore.has(k)),
      };
    });
  }

  async function addDividend(entry: DividendEntry, ticker: string) {
    try {
      const portfolioId = portfolioForTicker(ticker);
      await recordDividend(repos, portfolioId, {
        ticker,
        amount: entry.dividend.amount,
        date: entry.dividend.date,
        notes: "Imported from screenshot/PDF",
      });
      importSession.update((prev) => ({ ...prev, addedKeys: [...prev.addedKeys, entry.key] }));
      clearRowError(entry.key);
    } catch (e) {
      setRowError(entry.key, e);
    }
  }

  /**
   * OCR ticker resolution isn't perfect — a garbled/unrecognized company name
   * can still produce a low-confidence guess that's flat-out wrong (see
   * ThndrParser's header-ticker fallback). Rather than trying to make OCR
   * infallible, this gives the user a direct way to correct it: every
   * pending candidate/verification/dividend currently grouped under the
   * wrong ticker moves to the corrected one, AND — since auto-commit now
   * means a row is often already a real trade by the time a wrong ticker is
   * noticed — every already-recorded row under that ticker is corrected too
   * (`renameTickerEverywhere`, covering Trade/TradeAllocation/TimelineEvent/
   * PositionVerification). Correcting the pending pool first means anything
   * still waiting on a portfolio pick auto-commits under the right ticker
   * from the start, rather than needing this same fix run twice.
   */
  async function renameTickerGroup(oldTicker: string, newTickerRaw: string) {
    const newTicker = normalizeTicker(newTickerRaw);
    if (!newTicker || newTicker === oldTicker) return;
    importSession.update((prev) => {
      const tickerPortfolioNext = { ...prev.tickerPortfolio };
      if (prev.tickerPortfolio[oldTicker] && !tickerPortfolioNext[newTicker]) {
        tickerPortfolioNext[newTicker] = prev.tickerPortfolio[oldTicker];
      }
      return {
        ...prev,
        pendingCandidates: prev.pendingCandidates.map((e) =>
          normalizeTicker(e.candidate.ticker) === oldTicker ? { ...e, candidate: { ...e.candidate, ticker: newTicker } } : e,
        ),
        pendingVerifications: prev.pendingVerifications.map((e) =>
          normalizeTicker(e.verification.ticker) === oldTicker
            ? { ...e, verification: { ...e.verification, ticker: newTicker } }
            : e,
        ),
        pendingDividends: prev.pendingDividends.map((e) =>
          normalizeTicker(e.dividend.ticker) === oldTicker ? { ...e, dividend: { ...e.dividend, ticker: newTicker } } : e,
        ),
        pendingOrderEvidences: prev.pendingOrderEvidences.map((e) =>
          normalizeTicker(e.evidence.ticker) === oldTicker ? { ...e, evidence: { ...e.evidence, ticker: newTicker } } : e,
        ),
        discardedCandidates: prev.discardedCandidates.map((e) =>
          normalizeTicker(e.candidate.ticker) === oldTicker ? { ...e, candidate: { ...e.candidate, ticker: newTicker } } : e,
        ),
        tickerPortfolio: tickerPortfolioNext,
      };
    });
    try {
      await renameTickerEverywhere(repos, oldTicker, newTicker);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Failed to correct already-recorded rows for this ticker.");
    }
  }

  async function acceptVerification(entry: VerificationEntry, ticker: string) {
    try {
      const portfolioId = portfolioForTicker(ticker);
      await repos.verifications.save({
        ...entry.verification,
        id: generateId(),
        portfolioId,
        ticker: normalizeTicker(entry.verification.ticker),
      });
      importSession.update((prev) => ({ ...prev, acceptedKeys: [...prev.acceptedKeys, entry.key] }));
      clearRowError(entry.key);
    } catch (e) {
      setRowError(entry.key, e);
    }
  }

  const tickerGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        buys: CandidateEntry[];
        sells: CandidateEntry[];
        verifications: VerificationEntry[];
        dividends: DividendEntry[];
        orderEvidences: OrderEvidenceEntry[];
      }
    >();
    const group = (ticker: string) => {
      const t = normalizeTicker(ticker);
      const g = map.get(t) ?? { buys: [], sells: [], verifications: [], dividends: [], orderEvidences: [] };
      map.set(t, g);
      return g;
    };
    for (const entry of pendingCandidates) {
      const g = group(entry.candidate.ticker);
      (entry.candidate.side === "BUY" ? g.buys : g.sells).push(entry);
    }
    for (const entry of pendingVerifications) {
      group(entry.verification.ticker).verifications.push(entry);
    }
    for (const entry of pendingDividends) {
      group(entry.dividend.ticker).dividends.push(entry);
    }
    for (const entry of pendingOrderEvidences) {
      group(entry.evidence.ticker).orderEvidences.push(entry);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences]);

  /**
   * Nothing dedupes a pending Buy/Sell candidate against its own siblings in
   * the same batch the way processFiles already dedupes verifications and
   * dividends at extraction time — findDuplicateBuyMatch/findDuplicateSellMatch
   * (below, via duplicateMatch) only ever compare against trades already
   * committed to the ledger. An overlapping multi-file drop or a repeated PDF
   * page therefore piles up as separate pending rows with nothing flagging
   * the cause, inflating a ticker's extracted share total past its broker
   * screenshot with no way to fix it short of re-extracting from scratch.
   *
   * The same inflation happens for the opposite reason too: a pending
   * candidate can duplicate a trade already committed from an earlier import
   * (the same statement re-uploaded weeks later) — findDuplicateBuyMatch/
   * findDuplicateSellMatch already flag that with the amber/rose "Possible
   * duplicate"/"Duplicate" badge, but before this only ever informed the
   * user; there was no action to actually discard the redundant pending row,
   * so a ticker like this stayed permanently "Blocked" with its Mismatch
   * banner pointing at a duplicate nothing could remove. Folding both cases
   * into one set means "Clear suspected duplicates" and the per-row Discard
   * button resolve either kind the same way — discarding a pending row is
   * always safe regardless of which sibling or already-committed trade it
   * duplicates, since nothing has been committed for it yet.
   *
   * Computed only over rows still actually pending (excluding
   * added/skipped/dismissed) since those are already resolved one way or
   * another and out of this batch's editable pool.
   */
  const pendingDuplicateCandidateKeys = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    const siblingDuplicateKeys = suggestDuplicatePendingCandidateKeysToDelete(stillPending);
    const existingTradeDuplicateKeys = stillPending
      .filter((e) =>
        e.candidate.side === "BUY"
          ? findDuplicateBuyMatch(e.candidate, existingTrades) !== undefined
          : findDuplicateSellMatch(e.candidate, existingAllocations) !== undefined,
      )
      .map((e) => e.key);
    return [...new Set([...siblingDuplicateKeys, ...existingTradeDuplicateKeys])];
  }, [pendingCandidates, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingAllocations]);
  const pendingDuplicateCandidateKeySet = useMemo(() => new Set(pendingDuplicateCandidateKeys), [pendingDuplicateCandidateKeys]);

  /**
   * The dual-source rule, page-wide: every still-pending row whose exact
   * transaction (ticker/side/date/share count) was read from two DIFFERENT
   * document types — statement + invoice, statement + orders screenshot,
   * etc. (see findCrossSourceVerifiedKeys). Drives the per-row "Two
   * documents agree" badge and feeds the per-ticker verification gate.
   */
  const crossVerifiedKeys = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    // Discarded rows still corroborate: cleaning up the redundant copy of a
    // statement+orders-screenshot pair must not un-verify the row that stays.
    return findCrossSourceVerifiedKeys([...stillPending, ...session.discardedCandidates]);
  }, [pendingCandidates, session.discardedCandidates, addedKeys, skippedKeys, dismissedKeys]);

  /**
   * Statement Aggregate Reconciliation: Statement candidate key -> the
   * execution row keys (from Orders/an Orders screenshot/an Invoice/a CSV
   * export) whose shares sum exactly to it (see
   * findAggregateStatementMatches). Only searched for a Statement row
   * without a direct 1:1 cross-source match already (crossVerifiedKeys) —
   * Case 1 (one Statement row, one execution of the identical share count)
   * is already resolved by the dual-source rule above; this only covers
   * Case 2, a Statement row summarizing more than one execution.
   *
   * Deliberately NOT filtered by skippedKeys, unlike the other per-row
   * derivations above: the Statement row's own "skipped" state is the
   * OUTPUT of this exact match (see the aggregate auto-skip effect above),
   * so excluding skipped rows here would make the match — and therefore the
   * skip and the execution rows' "Confirmed by Statement" badge — disappear
   * the instant it succeeds. Same self-referential trap crossVerifiedKeys
   * avoids by re-including session.discardedCandidates after cleanup.
   */
  const aggregateStatementMatches = useMemo(() => {
    const stillPending = pendingCandidates.filter((e) => !addedKeys.has(e.key) && !dismissedKeys.has(e.key));
    return findAggregateStatementMatches(stillPending, crossVerifiedKeys);
  }, [pendingCandidates, addedKeys, dismissedKeys, crossVerifiedKeys]);

  /** Every execution row confirmed as part of a Statement aggregate — drives the "Confirmed by Statement" badge and lets the ticker verify without a broker screenshot the same way crossVerifiedKeys/orderConfirmedKeys already do. */
  const aggregateConfirmedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const executionKeys of aggregateStatementMatches.values()) {
      for (const key of executionKeys) keys.add(key);
    }
    return keys;
  }, [aggregateStatementMatches]);

  /** Per-execution-row breakdown text ("BUY 5,000 sh + BUY 3,000 sh") for the "Confirmed by Statement" badge's tooltip — the group of rows a Statement row aggregated this one with. */
  const aggregateGroupDetailByKey = useMemo(() => {
    const map = new Map<string, string>();
    if (aggregateStatementMatches.size === 0) return map;
    const byKey = new Map(pendingCandidates.map((e) => [e.key, e] as const));
    for (const executionKeys of aggregateStatementMatches.values()) {
      const rows = executionKeys.map((k) => byKey.get(k)).filter((e): e is CandidateEntry => e !== undefined);
      const summary = rows.map((e) => `${e.candidate.side} ${formatShares(e.candidate.shares)}`).join(" + ");
      for (const key of executionKeys) map.set(key, summary);
    }
    return map;
  }, [aggregateStatementMatches, pendingCandidates]);

  /**
   * Corroboration confidence bump, live: a still-pending row confirmed by
   * two independent document types (crossVerifiedKeys) or by a Statement
   * aggregate (aggregateConfirmedKeys) is raised to "high" confidence —
   * same philosophy as completeCandidateFieldsFromSiblings' one-shot patch
   * at upload time, generalized to (a) also cover the aggregate-match case,
   * which never shares an exact signature with what it summarizes so that
   * function can't see it, and (b) re-evaluate live on every render instead
   * of freezing at whatever was true the moment the file was processed — a
   * corroboration that only completes once a second document arrives later
   * (the first sat pending a while before the confirming one was uploaded)
   * now gets reflected instead of leaving the row stuck showing "Low-
   * confidence ticker guess" despite the badges right next to it already
   * proving the transaction is corroborated. See keysToRaiseToHighConfidence
   * (duplicateDetection.ts) for the actual raise decision; this effect only
   * decides WHEN to apply it and writes the patch into the session once.
   */
  useEffect(() => {
    const corroboratedKeys = new Set([...crossVerifiedKeys, ...aggregateConfirmedKeys]);
    const keysToRaise = keysToRaiseToHighConfidence(pendingCandidates, corroboratedKeys);
    if (keysToRaise.length === 0) return;
    const raiseSet = new Set(keysToRaise);
    importSession.update((prev) => ({
      ...prev,
      pendingCandidates: prev.pendingCandidates.map((e) =>
        raiseSet.has(e.key) ? { ...e, candidate: { ...e.candidate, confidence: "high" } } : e,
      ),
    }));
  }, [pendingCandidates, crossVerifiedKeys, aggregateConfirmedKeys]);

  /**
   * Pending Buy/Sell rows corroborated by a fulfilled order on the broker's
   * own account-wide "Orders" timeline screenshot (same ticker/side/share
   * count, price within tolerance — see findOrderConfirmedKeys). Drives the
   * per-row "Matches Orders history" badge, and — when EVERY still-pending
   * row of a ticker is confirmed one way or another — lets the ticker verify
   * without a "My Position" screenshot (checkTickerMatch's orders-verified).
   */
  const orderConfirmedKeys = useMemo(() => {
    if (pendingOrderEvidences.length === 0) return new Set<string>();
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findOrderConfirmedKeys(
      stillPending,
      pendingOrderEvidences.map((e) => e.evidence),
    );
  }, [pendingCandidates, pendingOrderEvidences, addedKeys, skippedKeys, dismissedKeys]);

  /**
   * Fulfilled evidence rows that had no matching pending candidate — grouped
   * by ticker. A verified ticker with orphaned evidence has transaction
   * history that isn't in the ledger yet (may be a historical buy that was
   * sold, or simply missing from the current batch). Surfaced as a warning
   * banner on the ticker card so the user knows to upload a Statement.
   */
  const orphanedEvidenceByTicker = useMemo(() => {
    if (pendingOrderEvidences.length === 0) return new Map<string, ParsedOrderEvidence[]>();
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findOrphanedFulfilledEvidence(
      stillPending,
      pendingOrderEvidences.map((e) => e.evidence),
    );
  }, [pendingCandidates, pendingOrderEvidences, addedKeys, skippedKeys, dismissedKeys]);

  /**
   * The verification gate (Step 2 of the two-phase workflow): a ticker's
   * pending buys/sells only get a green light once their net effect on its
   * share count exactly reconciles against a broker "My Position"
   * screenshot for that ticker — the most recent one, whether it was
   * accepted in an earlier session (existingVerifications) or is still
   * sitting in this batch's pending pool. A ticker with no pending buy/sell
   * candidates at all (a dividend-only or stray verification-only read) has
   * no share count to reconcile and is trivially matched. Nothing here
   * writes anything — see confirmAndDistributeAll for the one place that
   * actually commits, and only for tickers this reports as matched.
   */
  const tickerMatchStatuses = useMemo(() => {
    const map = new Map<string, TickerMatchStatus>();
    for (const [ticker, group] of tickerGroups) {
      const remainingBuys = group.buys.filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      const remainingSells = group.sells.filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      const pendingBuyShares = remainingBuys.reduce((sum, e) => sum + e.candidate.shares, 0);
      const pendingSellShares = remainingSells.reduce((sum, e) => sum + e.candidate.shares, 0);
      const remainingBuysAndSells = [...remainingBuys, ...remainingSells];
      const allPendingFromInvoice =
        remainingBuysAndSells.length > 0 && remainingBuysAndSells.every((e) => e.candidate.source === "invoice");
      const allPendingSelfVerified =
        remainingBuysAndSells.length > 0 &&
        remainingBuysAndSells.every(
          (e) => e.candidate.source === "invoice" || crossVerifiedKeys.has(e.key) || aggregateConfirmedKeys.has(e.key),
        );
      const allPendingOrderConfirmed =
        remainingBuysAndSells.length > 0 &&
        remainingBuysAndSells.every(
          (e) =>
            e.candidate.source === "invoice" ||
            crossVerifiedKeys.has(e.key) ||
            aggregateConfirmedKeys.has(e.key) ||
            orderConfirmedKeys.has(e.key),
        );
      const existingRemainingShares = existingTrades
        .filter((t) => normalizeTicker(t.ticker) === ticker)
        .reduce((sum, t) => sum + t.remainingShares, 0);

      const verificationCandidates = [
        ...existingVerifications.filter((v) => normalizeTicker(v.ticker) === ticker),
        ...group.verifications.map((e) => e.verification),
      ];
      const latestVerification = verificationCandidates.length
        ? verificationCandidates.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b))
        : undefined;

      map.set(
        ticker,
        checkTickerMatch({
          hasShares: group.buys.length + group.sells.length > 0,
          pendingBuyShares,
          pendingSellShares,
          existingRemainingShares,
          verifiedUnits: latestVerification?.units,
          verifiedAvgCost: latestVerification?.avgCost,
          allPendingFromInvoice,
          allPendingSelfVerified,
          allPendingOrderConfirmed,
        }),
      );
    }
    return map;
  }, [
    tickerGroups,
    addedKeys,
    skippedKeys,
    dismissedKeys,
    existingTrades,
    existingVerifications,
    crossVerifiedKeys,
    aggregateConfirmedKeys,
    orderConfirmedKeys,
  ]);

  /**
   * A ticker is "fully matched" once every buy/sell/dividend/verification row
   * extracted for it has reached a terminal state (committed, skipped as an
   * exact duplicate, or manually dismissed) and none is stuck on a row error
   * — i.e. there's nothing left here for the user to look at. Once true, its
   * card moves out of the active working list into the collapsed "Fully
   * matched" summary below, so the active list only ever shows tickers that
   * still need a decision (an unmatched share count, an unallocated sell, a
   * failed commit). A ticker with zero buy/sell rows (dividend/verification-
   * only) never resolves this way — there's no "sell = buy" question to
   * answer for it, so it stays visible like any other still-open card.
   */
  const rowErrorKeys = useMemo(() => new Set(Object.keys(rowErrors)), [rowErrors]);

  const tickerResolution = useMemo(() => {
    const map = new Map<string, { resolved: boolean; transactionCount: number }>();
    for (const [ticker, group] of tickerGroups) {
      const transactionKeys = [...group.buys, ...group.sells].map((e) => e.key);
      const resolved = isTickerFullyResolved({
        matched: Boolean(tickerMatchStatuses.get(ticker)?.matched),
        transactionKeys,
        dividendKeys: group.dividends.map((e) => e.key),
        verificationKeys: group.verifications.map((e) => e.key),
        addedKeys,
        skippedKeys,
        dismissedKeys,
        acceptedKeys,
        rowErrorKeys,
      });
      map.set(ticker, { resolved, transactionCount: transactionKeys.length });
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, addedKeys, skippedKeys, dismissedKeys, acceptedKeys, rowErrorKeys]);

  const activeTickerGroups = useMemo(
    () => tickerGroups.filter(([ticker]) => !tickerResolution.get(ticker)?.resolved),
    [tickerGroups, tickerResolution],
  );
  const completedTickerGroups = useMemo(
    () => tickerGroups.filter(([ticker]) => tickerResolution.get(ticker)?.resolved),
    [tickerGroups, tickerResolution],
  );

  const unmatchedTickerCount = activeTickerGroups.filter(([ticker]) => !tickerMatchStatuses.get(ticker)?.matched).length;
  const matchedTickerCount = activeTickerGroups.length - unmatchedTickerCount;
  const allTickersMatched = activeTickerGroups.length > 0 && unmatchedTickerCount === 0;

  /**
   * The one duplicate shape every per-ticker check above is blind to: the
   * same physical execution OCR'd twice under two different guessed tickers
   * (an unmapped company-name fallback filed the real transaction under one
   * name, a fuzzy guess filed its phantom under another). Key -> the ticker
   * the row most likely belongs to, driving a badge on the phantom row.
   */
  const wrongTickerHints = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    const hints = findWrongTickerCandidateKeys(stillPending, existingTrades, existingAllocations);
    // The Orders timeline prints the REAL ticker code on every row, so it can
    // catch a misfiled read even when no committed/pending copy exists under
    // the right ticker. Ledger/pending-based hints take precedence — they
    // point at an actual duplicate record, not just a matching order.
    if (pendingOrderEvidences.length > 0) {
      const orderHints = findWrongTickerHintsFromOrders(
        stillPending,
        pendingOrderEvidences.map((e) => e.evidence),
      );
      for (const [key, ticker] of orderHints) {
        if (!hints.has(key)) hints.set(key, ticker);
      }
    }
    return hints;
  }, [pendingCandidates, pendingOrderEvidences, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingAllocations]);

  /**
   * A pending row whose ticker/side/shares/price closely match a trade
   * already on the ledger, but whose date differs by exactly a single-digit
   * OCR misread — real observed failure (RMDA): the same execution,
   * duplicated across a scroll-overlap pair of screenshots, read once with
   * the day intact and once misread, so the exact-date signature every
   * other duplicate check relies on never caught it. Advisory only (see
   * findDateMisreadDuplicateHints) — drives a badge, never an auto-skip.
   */
  const dateMisreadHints = useMemo(() => {
    const stillPending = pendingCandidates.filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findDateMisreadDuplicateHints(stillPending, existingTrades, existingAllocations);
  }, [pendingCandidates, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingAllocations]);

  /**
   * For a mismatch none of the row-level checks can explain, the share
   * arithmetic itself often can: which subset of pending rows, removed,
   * leaves exactly the broker's verified count — ranked by the broker's own
   * avg cost when it was captured (see suggestRemovalsToReconcile). Ticker ->
   * the suggested removal, driving the banner's one-click fix. Skips
   * alreadyFullyRecorded tickers, which have their own bulk-discard action.
   */
  const reconcileSuggestions = useMemo(() => {
    const map = new Map<string, ReconcileSuggestion>();
    for (const [ticker, group] of tickerGroups) {
      // "mismatch" is only ever reached inside checkTickerMatch once a
      // verification was actually found — existingRemainingShares/
      // verifiedUnits/verifiedAvgCost are read straight off its own result
      // rather than re-selecting "the latest PositionVerification for this
      // ticker" a second time here (a real, found duplicate this consolidates
      // away — see importVerification.ts's verifiedAvgCost echo).
      const status = tickerMatchStatuses.get(ticker);
      if (!status || status.reason !== "mismatch" || status.alreadyFullyRecorded || status.verifiedUnits === undefined) continue;
      const stillPending = [...group.buys, ...group.sells].filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      // Still needed for cost basis (a quantity checkTickerMatch doesn't
      // track at all, unlike share counts) — the individual trades, not just
      // their remainingShares sum, are required to weight entryPrice per lot.
      const existingForTicker = existingTrades.filter((t) => normalizeTicker(t.ticker) === ticker);
      const suggestion = suggestRemovalsToReconcile({
        rows: stillPending.map((e) => ({
          key: e.key,
          side: e.candidate.side,
          shares: e.candidate.shares,
          price: e.candidate.price,
          confidence: e.candidate.confidence,
        })),
        existingRemainingShares: status.existingRemainingShares ?? 0,
        existingCostBasis: Money.sum(
          existingForTicker.map((t) => Money.from(t.entryPrice).multiply(t.remainingShares)),
        ).toNumber(),
        verifiedUnits: status.verifiedUnits,
        verifiedAvgCost: status.verifiedAvgCost,
      });
      if (suggestion) map.set(ticker, suggestion);
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, addedKeys, skippedKeys, dismissedKeys, existingTrades]);

  /**
   * The one case where alreadyFullyRecorded's "discard all pending" is the
   * WRONG direction: the ticker's recorded shares are opening-balance
   * placeholder lots (no real dates — see the retired Record-as-opening-
   * balance flow) and this batch carries the ticker's REAL dated
   * transactions adding up to the same broker-verified total. Discarding
   * the pending rows would keep the dateless placeholder and throw away the
   * real data — the right move is the exact opposite: delete the
   * placeholder lots and let the real rows verify and confirm. Only offered
   * for the clean swap (every existing share is a deletable placeholder AND
   * the pending rows alone reconcile with the broker), so the replacement
   * can never half-apply.
   */
  const placeholderReplacements = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [ticker] of tickerGroups) {
      const status = tickerMatchStatuses.get(ticker);
      if (!status || status.reason !== "mismatch" || !status.alreadyFullyRecorded || status.verifiedUnits === undefined) continue;
      const pendingNet = status.netShares - (status.existingRemainingShares ?? 0);
      if (Math.abs(pendingNet - status.verifiedUnits) >= 1e-6) continue;
      const existingOpen = existingTrades.filter((t) => normalizeTicker(t.ticker) === ticker && t.remainingShares > 0);
      if (existingOpen.length === 0) continue;
      const allDeletablePlaceholders = existingOpen.every(
        (t) => t.notes?.startsWith("Opening balance") && t.remainingShares === t.shares,
      );
      if (allDeletablePlaceholders) map.set(ticker, existingOpen.map((t) => t.id));
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, existingTrades]);

  const [replacingPlaceholderFor, setReplacingPlaceholderFor] = useState<string | null>(null);
  async function replacePlaceholderLots(ticker: string, tradeIds: string[]) {
    setReplacingPlaceholderFor(ticker);
    try {
      for (const id of tradeIds) {
        await deleteTrade(repos, id);
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Failed to delete the placeholder lot.");
    } finally {
      setReplacingPlaceholderFor(null);
    }
  }

  /**
   * A ticker resolved from an unmapped company name (see ThndrParser's
   * header fallback) can still land on the wrong 4-letter guess, or the same
   * real stock can OCR to a different guess on a different upload — the
   * exact failure mode reported against this page. Rather than requiring a
   * manual rename for every one of these, this flags it automatically
   * whenever it can be verified mechanically: two ticker groups whose buy/sell
   * rows are byte-for-byte identical (same side/shares/price/date) are, for
   * all practical purposes, the same upload read under two different guessed
   * tickers. Only ever a suggestion — nothing merges without the user's
   * click, and a coincidental exact match is vanishingly unlikely for real
   * trade data.
   */
  const mergeSuggestions = useMemo(() => {
    const signature = (group: (typeof tickerGroups)[number][1]): string =>
      [...group.buys, ...group.sells]
        .map((e) => `${e.candidate.side}|${e.candidate.shares}|${e.candidate.price}|${e.candidate.date}`)
        .sort()
        .join(";");
    const allLowConfidence = (group: (typeof tickerGroups)[number][1]): boolean =>
      [...group.buys, ...group.sells].every((e) => e.candidate.confidence === "low");

    const bySignature = new Map<string, string[]>();
    for (const [ticker, group] of tickerGroups) {
      const sig = signature(group);
      if (!sig) continue;
      const list = bySignature.get(sig) ?? [];
      list.push(ticker);
      bySignature.set(sig, list);
    }

    const suggestions = new Map<string, string>();
    for (const [ticker, group] of tickerGroups) {
      if (!allLowConfidence(group)) continue;
      const sig = signature(group);
      if (!sig) continue;
      const siblings = (bySignature.get(sig) ?? []).filter((t) => t !== ticker);
      if (siblings.length === 0) continue;
      const preferred =
        siblings.find((t) => {
          const siblingGroup = tickerGroups.find(([tk]) => tk === t)?.[1];
          return siblingGroup && !allLowConfidence(siblingGroup);
        }) ?? siblings[0];
      suggestions.set(ticker, preferred);
    }
    return suggestions;
  }, [tickerGroups]);

  const totalPending = pendingCandidates.length + pendingVerifications.length + pendingDividends.length;

  const currentYear = new Date().getFullYear();
  const startYearOptions = useMemo(() => {
    const years: number[] = [];
    for (let y = currentYear; y >= 2020; y--) years.push(y);
    return years;
  }, [currentYear]);

  return (
    <div>
      <PageHeader
        title={t("importPage.title")}
        description={t("importPage.description")}
        actions={
          <button
            onClick={() => {
              if (confirm(t("importPage.clearAllConfirm"))) {
                void clearAll();
              }
            }}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <RotateCcw size={14} /> {t("importPage.clearAll")}
          </button>
        }
      />

      {portfolios.length === 0 ? (
        <EmptyState
          title={t("importPage.createPortfolioFirstTitle")}
          description={t("importPage.createPortfolioFirstDescription")}
          action={
            <Link href="/portfolios" className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              {t("importPage.createPortfolio")}
            </Link>
          }
        />
      ) : null}

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">{t("importPage.step1Title")}</h3>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
          <label htmlFor="import-start-year" className="font-medium text-slate-300">
            {t("importPage.startDateLabel")}
          </label>
          <select
            id="import-start-year"
            value={trackingStartDate.slice(0, 4)}
            onChange={(e) => trackingStartDateStore.set(`${e.target.value}-01-01`)}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
          >
            {startYearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <span>{t("importPage.startDateHint", { date: trackingStartDate })}</span>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const dropped = Array.from(e.dataTransfer.files ?? []);
            if (dropped.length > 0) void processFiles(dropped);
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragOver ? "border-cyan-400 bg-cyan-500/5" : "border-slate-800 bg-slate-950/40"
          }`}
        >
          <UploadCloud size={28} className="text-slate-500" />
          <p className="text-sm font-medium text-slate-200">{t("importPage.dropzoneText")}</p>
          <p className="text-xs text-slate-500">{t("importPage.or")}</p>
          <label className="cursor-pointer rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400">
            {t("importPage.chooseFiles")}
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,text/csv,.csv"
              className="hidden"
              onChange={(e) => {
                const chosen = Array.from(e.target.files ?? []);
                if (chosen.length > 0) void processFiles(chosen);
                e.target.value = "";
              }}
            />
          </label>
          {queueProgress ? (
            <div className="mt-1 flex items-center gap-2 text-sm text-slate-300">
              <Loader2 size={14} className="animate-spin" />
              <FileText size={14} /> {t("importPage.processingProgress", { index: queueProgress.index, total: queueProgress.total, fileName: queueProgress.fileName })}
            </div>
          ) : null}
          {stage === "error" ? <p className="text-sm text-rose-400">{errorMessage}</p> : null}
        </div>

        {recentFileResults.length > 0 && stage !== "reading" ? (
          <div className="mt-3 space-y-1.5">
            {recentFileResults.map((r, i) => (
              <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
                <span className="font-medium text-slate-300">{r.fileName}</span>
                {r.duplicate ? (
                  <span className="ms-2 text-cyan-400">{t("importPage.duplicateFileSkipped")}</span>
                ) : r.warnings.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-300/80">
                    {r.warnings.map((w, wi) => (
                      <li key={wi}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="ms-2 text-emerald-400">{t("importPage.extractedSuccessfully")}</span>
                )}
              </div>
            ))}
          </div>
        ) : null}

        <p className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          {totalPending > 0 || pendingOrderEvidences.length > 0 ? <CheckCircle2 size={15} className="text-emerald-400" /> : null}
          {t("importPage.extractedSummary", { n: totalPending, orderRows: pendingOrderEvidences.length, files: filesProcessed })}
        </p>
      </div>

      {tickerGroups.length > 0 ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">{t("importPage.step2Title")}</h3>
              <p className="mt-1 text-xs text-slate-400">
                {activeTickerGroups.length === 0
                  ? t("importPage.allDoneStatus")
                  : allTickersMatched
                    ? t("importPage.allMatchedStatus")
                    : matchedTickerCount > 0
                      ? t("importPage.someMatchedStatus", { matched: matchedTickerCount, total: activeTickerGroups.length })
                      : t("importPage.noneMatchedStatus", { unmatched: unmatchedTickerCount, total: activeTickerGroups.length })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {pendingDuplicateCandidateKeys.length > 0 ? (
                <button
                  onClick={clearPendingDuplicateCandidates}
                  className="flex items-center gap-1.5 rounded-md border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-300 hover:bg-rose-500/10"
                >
                  <Eraser size={14} />
                  {t("importPage.clearSuspectedDuplicates", { n: pendingDuplicateCandidateKeys.length })}
                </button>
              ) : null}
              {activeTickerGroups.length > 0 ? (
                <button
                  onClick={() => void confirmAndDistributeAll()}
                  disabled={matchedTickerCount === 0 || distributing || !initialDataLoaded}
                  title={
                    matchedTickerCount === 0
                      ? t("importPage.noTickerVerified")
                      : allTickersMatched
                        ? undefined
                        : t("importPage.confirmSubsetTitle", { matched: matchedTickerCount, total: activeTickerGroups.length })
                  }
                  className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:hover:bg-slate-700"
                >
                  {distributing ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {allTickersMatched ? t("importPage.confirmDistributeAll") : t("importPage.confirmAllVerified", { n: matchedTickerCount })}
                </button>
              ) : null}
            </div>
          </div>

          {completedTickerGroups.length > 0 ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <button
                onClick={() => setCompletedExpanded((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-start"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                  <ShieldCheck size={15} />
                  {t("importPage.completedSectionTitle", { n: completedTickerGroups.length })}
                </span>
                <ChevronDown
                  size={16}
                  className={`shrink-0 text-emerald-400 transition-transform ${completedExpanded ? "rotate-180" : ""}`}
                />
              </button>
              {completedExpanded ? (
                <ul className="mt-3 space-y-1.5 text-sm text-emerald-200/90">
                  {completedTickerGroups.map(([ticker, group]) => {
                    const companyName = group.buys[0]?.candidate.companyName ?? group.sells[0]?.candidate.companyName ?? "";
                    const count = tickerResolution.get(ticker)?.transactionCount ?? 0;
                    return (
                      <li key={ticker} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-emerald-500/10 px-3 py-1.5">
                        <span>{t("importPage.completedTickerEntry", { ticker, company: companyName, count })}</span>
                        <button
                          onClick={() => void resetTickerData(ticker)}
                          title={t("importPage.resetTickerTitle", { ticker })}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-rose-500/40 px-2 py-0.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
                        >
                          <Trash2 size={12} /> {t("importPage.resetTicker")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}

          {activeTickerGroups.map(([ticker, group]) => {
            const existingIds = existingPortfoliosByTicker.get(ticker);
            const existingNames = existingIds ? [...existingIds].map((id) => portfolios.find((p) => p.id === id)?.name ?? "?") : [];
            return (
              <TickerGroupCard
                key={ticker}
                ticker={ticker}
                group={group}
                portfolios={portfolios}
                portfolioId={resolvedPortfolioId(ticker) ?? ""}
                portfolioResolved={resolvedPortfolioId(ticker) !== undefined}
                matchStatus={tickerMatchStatuses.get(ticker)}
                distributing={distributing}
                onPortfolioChange={(portfolioId) => setTickerPortfolio(ticker, portfolioId)}
                addedKeys={addedKeys}
                acceptedKeys={acceptedKeys}
                skippedKeys={skippedKeys}
                dismissedKeys={dismissedKeys}
                rowErrors={rowErrors}
                duplicateMatch={duplicateMatch}
                addedTradeIds={session.addedTradeIds}
                addedAllocationIds={session.addedAllocationIds}
                suspectedDuplicateKeys={pendingDuplicateCandidateKeySet}
                crossVerifiedKeys={crossVerifiedKeys}
                aggregateConfirmedKeys={aggregateConfirmedKeys}
                aggregateGroupDetailByKey={aggregateGroupDetailByKey}
                orderConfirmedKeys={orderConfirmedKeys}
                onDiscardOrderEvidence={(entry) => discardOrderEvidence(entry.key)}
                wrongTickerHints={wrongTickerHints}
                dateMisreadHints={dateMisreadHints}
                reconcileSuggestion={reconcileSuggestions.get(ticker)}
                placeholderReplacement={placeholderReplacements.has(ticker)}
                replacingPlaceholder={replacingPlaceholderFor === ticker}
                onReplacePlaceholder={() => void replacePlaceholderLots(ticker, placeholderReplacements.get(ticker) ?? [])}
                onDeleteAutoAdded={(entry) => void deleteAutoAddedTrade(entry)}
                onDiscardPending={(entry) => discardPendingCandidate(entry.key)}
                onDiscardPendingKeys={discardPendingCandidateKeys}
                onDiscardAllPending={() => discardAllPendingForTicker(ticker)}
                onConfirmTicker={() => void confirmTicker(ticker)}
                onAllocateSell={(entry) => setSellCandidate({ key: entry.key, ticker, portfolioId: portfolioForTicker(ticker), candidate: entry.candidate })}
                onRenameTicker={(newTicker) => void renameTickerGroup(ticker, newTicker)}
                onRestoreTicker={() => restoreTickerCandidates(ticker)}
                onResetTicker={() => void resetTickerData(ticker)}
                orphanedOrderEvidence={orphanedEvidenceByTicker.get(ticker)}
                existingPortfolioHint={
                  existingNames.length > 0 ? { multiple: existingNames.length > 1, names: existingNames } : undefined
                }
                mergeSuggestion={mergeSuggestions.get(ticker)}
                knownTickerSuggestion={tickerForCompanyNameFallback(ticker)}
                existingTradesForTicker={existingTradesByTicker.get(ticker) ?? []}
                onDeleteExistingTrade={(tradeId) => void deleteExistingTrade(tradeId)}
              />
            );
          })}
        </div>
      ) : null}

      <Modal
        title={t("importPage.allocateSellModalTitle", { tickerSuffix: sellCandidate ? t("importPage.allocateSellTickerSuffix", { ticker: sellCandidate.ticker }) : "" })}
        open={sellCandidate !== null}
        onClose={() => setSellCandidate(null)}
        widthClassName="max-w-2xl"
      >
        {sellCandidate ? (
          <SellAllocationForm
            portfolioId={sellCandidate.portfolioId}
            ticker={sellCandidate.ticker}
            initial={{
              exitPrice: sellCandidate.candidate.price,
              fees: sellCandidate.candidate.fees ?? 0,
              taxes: sellCandidate.candidate.taxes ?? 0,
              executionDate: sellCandidate.candidate.date,
              executionTime: sellCandidate.candidate.time,
              transactionNumber: sellCandidate.candidate.transactionNumber,
            }}
            onDone={(created) => {
              importSession.update((prev) => ({
                ...prev,
                addedKeys: [...prev.addedKeys, sellCandidate.key],
                addedAllocationIds: created?.allocationIds.length
                  ? { ...prev.addedAllocationIds, [sellCandidate.key]: created.allocationIds }
                  : prev.addedAllocationIds,
              }));
              setSellCandidate(null);
            }}
            onCancel={() => setSellCandidate(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function confidenceText(t: TFunction, confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return t("importPage.constraintConfidenceHigh");
  if (confidence === "medium") return t("importPage.constraintConfidenceMedium");
  return t("importPage.constraintConfidenceLow");
}

/**
 * Facts first, contradiction second, diagnosis only ever after that — see
 * constraintValidation.ts. Purely additive/read-only: renders whatever
 * checkTickerMatch + the existing diagnosis signals already produced,
 * changes nothing about the banners/badges above and below it.
 */
function ConstraintReportPanel({ report, t }: { report: TickerConstraintReport; t: TFunction }) {
  const { facts, contradictions, diagnosis } = report;
  return (
    <details className="border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
      <summary className="cursor-pointer select-none font-medium text-slate-300">
        {t("importPage.constraintReportTitle")}
        {report.satisfied ? (
          <span className="ms-2 text-emerald-400">{t("importPage.constraintSatisfied")}</span>
        ) : (
          <span className="ms-2 text-rose-400">{t("importPage.constraintContradictionTitle")}</span>
        )}
      </summary>
      <div className="mt-2 space-y-1.5">
        <p>
          {t("importPage.constraintFactsLine", {
            opening: formatShares(facts.openingShares),
            buy: formatShares(facts.buyShares),
            sell: formatShares(facts.sellShares),
            calculated: formatShares(facts.calculatedRemaining),
            holdingsSuffix:
              facts.holdingsRemaining !== undefined
                ? t("importPage.constraintFactsHoldingsSuffix", { holdings: formatShares(facts.holdingsRemaining) })
                : "",
          })}
        </p>
        {facts.closed ? <p className="text-slate-500">{t("importPage.constraintClosedPositionNote")}</p> : null}
        {contradictions.map((c, i) => (
          <p key={i} className="text-rose-300">
            {t("importPage.constraintContradictionLine", {
              expected: formatShares(c.expected),
              calculated: formatShares(c.calculated),
              difference: formatShares(c.difference),
            })}
          </p>
        ))}
        {diagnosis.length > 0 ? (
          <div className="mt-1.5 border-t border-slate-800 pt-1.5">
            <p className="font-medium text-slate-300">{t("importPage.constraintDiagnosisTitle")}</p>
            <ul className="mt-1 list-disc ps-4">
              {diagnosis.map((d, i) => (
                <li key={i}>
                  {d.explanation} — {t("importPage.constraintDiagnosisConfidence", { confidence: confidenceText(t, d.confidence) })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

const EVIDENCE_DOCUMENT_LABEL_KEY: Record<string, string> = {
  "Orders History": "importPage.evidenceOrdersHistory",
  "Broker Statement": "importPage.evidenceBrokerStatement",
  Invoice: "importPage.evidenceInvoice",
  Transactions: "importPage.evidenceTransactions",
  "My Position": "importPage.evidenceMyPosition",
};

/**
 * Surfaces completenessEngine's minimal-document recommendation instead of a
 * bare "needs a screenshot" block — names exactly which document closes the
 * gap and why, per the Evidence Resolution business rule "request only the
 * smallest missing document, never ask the user to re-upload everything."
 * Manual "I confirm this is complete" is deliberately NOT offered here as an
 * equal alternative — it's the last resort once no further evidence can
 * reasonably be requested, not a shortcut around requesting it.
 */
function RecoveryPlanPanel({ report, t }: { report: TickerCompletenessReport; t: TFunction }) {
  const plan = report.recoveryPlan;
  if (!plan) return null;
  return (
    <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
      <p className="font-medium">
        {t("importPage.recoveryPlanTitle", { document: t(EVIDENCE_DOCUMENT_LABEL_KEY[plan.bestEvidence] ?? plan.bestEvidence) })}
      </p>
      <p className="mt-1 text-amber-200/80">{plan.rationale}</p>
      {plan.alternativeEvidence ? (
        <p className="mt-1 text-amber-200/60">
          {t("importPage.recoveryPlanAlternative", { document: t(EVIDENCE_DOCUMENT_LABEL_KEY[plan.alternativeEvidence] ?? plan.alternativeEvidence) })}
        </p>
      ) : null}
    </div>
  );
}

export function TickerGroupCard({
  ticker,
  group,
  portfolios,
  portfolioId,
  portfolioResolved,
  matchStatus,
  distributing,
  onPortfolioChange,
  addedKeys,
  acceptedKeys,
  skippedKeys,
  dismissedKeys,
  rowErrors,
  duplicateMatch,
  addedTradeIds,
  addedAllocationIds,
  suspectedDuplicateKeys,
  crossVerifiedKeys,
  aggregateConfirmedKeys,
  aggregateGroupDetailByKey,
  orderConfirmedKeys,
  onDiscardOrderEvidence,
  wrongTickerHints,
  dateMisreadHints,
  reconcileSuggestion,
  placeholderReplacement = false,
  replacingPlaceholder = false,
  onReplacePlaceholder,
  onDeleteAutoAdded,
  onDiscardPending,
  onDiscardPendingKeys,
  onDiscardAllPending,
  onConfirmTicker,
  onAllocateSell,
  onRenameTicker,
  onRestoreTicker,
  onResetTicker,
  orphanedOrderEvidence,
  existingPortfolioHint,
  mergeSuggestion,
  knownTickerSuggestion,
  existingTradesForTicker,
  onDeleteExistingTrade,
}: {
  ticker: string;
  group: {
    buys: CandidateEntry[];
    sells: CandidateEntry[];
    verifications: VerificationEntry[];
    dividends: DividendEntry[];
    orderEvidences?: OrderEvidenceEntry[];
  };
  portfolios: { id: string; name: string }[];
  portfolioId: string;
  /** False while the ticker's portfolio is still ambiguous (a brand-new ticker with more than one portfolio open) — commit waits on the user picking one below. */
  portfolioResolved: boolean;
  /** The verification gate's result for this ticker — nothing here commits until this is matched. */
  matchStatus: TickerMatchStatus | undefined;
  /** True while confirmAndDistributeAll is actively committing this batch — drives the row-level "Adding…" spinner. */
  distributing: boolean;
  onPortfolioChange: (portfolioId: string) => void;
  addedKeys: Set<string>;
  acceptedKeys: Set<string>;
  skippedKeys: Set<string>;
  dismissedKeys: Set<string>;
  rowErrors: Record<string, string>;
  duplicateMatch: (
    candidate: ParsedTradeCandidate,
    ownTradeId?: string,
    ownAllocationIds?: string[],
  ) => { matchType: "exact" | "possible"; matchedId: string } | undefined;
  /** Entry key -> the real Trade.id an added Buy became — excludes a row's own committed trade from its duplicateMatch check so a successful commit never shows a false "Duplicate" badge against itself. */
  addedTradeIds: Record<string, string>;
  /** Sell entry key -> the TradeAllocation ids its "Allocate Sell" created — the Sell-side twin of addedTradeIds for the same self-duplicate exclusion. */
  addedAllocationIds?: Record<string, string[]>;
  /** Keys of pending (not yet added/skipped/dismissed) candidates suggested for discard — either a duplicate of a sibling in this same batch, or of a trade already committed to the ledger. See ImportPage's pendingDuplicateCandidateKeys. */
  suspectedDuplicateKeys: Set<string>;
  /** Keys of pending rows whose transaction was read from two different document types (see findCrossSourceVerifiedKeys) — drives the "Two documents agree" badge. */
  crossVerifiedKeys?: Set<string>;
  /** Keys of pending rows confirmed as part of a Statement aggregate (see findAggregateStatementMatches) — drives the "Confirmed by Statement" badge. */
  aggregateConfirmedKeys?: Set<string>;
  /** Entry key -> a formatted breakdown ("BUY 5,000 sh + BUY 3,000 sh") of the execution group a Statement row aggregated it with — the "Confirmed by Statement" badge's tooltip detail. */
  aggregateGroupDetailByKey?: Map<string, string>;
  /** Keys of pending rows corroborated by a fulfilled order on the broker's Orders timeline screenshot (see findOrderConfirmedKeys) — drives the "Matches Orders history" badge, and its absence the "No matching order" hint on a mismatch. */
  orderConfirmedKeys?: Set<string>;
  /** Discards one misread order-evidence row (see ImportPage's discardOrderEvidence). */
  onDiscardOrderEvidence?: (entry: OrderEvidenceEntry) => void;
  /** Pending key -> the ticker a phantom wrong-ticker read most likely belongs to (see findWrongTickerCandidateKeys) — drives the "likely {other}'s transaction" badge. */
  wrongTickerHints?: Map<string, string>;
  /** Pending key -> the date (already on the ledger) this row's date was most likely misread from (see findDateMisreadDuplicateHints) — drives an advisory "possible duplicate, misread date" badge. Never auto-discards anything. */
  dateMisreadHints?: Map<string, string>;
  /** The mismatch auto-reconcile solver's suggested removal for this ticker, when one exists (see suggestRemovalsToReconcile) — drives the banner's one-click fix and the per-row highlight. */
  reconcileSuggestion?: ReconcileSuggestion;
  /** True when this ticker's recorded shares are all deletable opening-balance placeholders and this batch's rows alone reconcile with the broker — flips the alreadyFullyRecorded banner from "discard pending" to "replace the placeholder" (see ImportPage's placeholderReplacements). */
  placeholderReplacement?: boolean;
  /** True while the placeholder lots are being deleted. */
  replacingPlaceholder?: boolean;
  onReplacePlaceholder?: () => void;
  onDeleteAutoAdded: (entry: CandidateEntry) => void;
  onDiscardPending: (entry: CandidateEntry) => void;
  /** Discards a named set of still-pending rows in one shot — the reconcile suggestion's "Remove suggested rows" action. */
  onDiscardPendingKeys?: (keys: string[]) => void;
  /** Discards every still-pending Buy/Sell for this ticker in one shot — only surfaced when matchStatus.alreadyFullyRecorded is true (see checkTickerMatch). */
  onDiscardAllPending: () => void;
  /** Confirms and distributes just this ticker, independent of any other ticker in the batch still stuck — see ImportPage's confirmTicker. */
  onConfirmTicker: () => void;
  onAllocateSell: (entry: CandidateEntry) => void;
  onRenameTicker: (newTicker: string) => void;
  /** Restores all dismissed/skipped/discarded Buy/Sell rows for this ticker back to pending state. */
  onRestoreTicker?: () => void;
  /** Permanently erases everything recorded for this ticker (ledger + session) so it can be re-imported from scratch — see ImportPage's resetTickerData. */
  onResetTicker?: () => void;
  /** Fulfilled order-evidence rows for this ticker that had no matching pending candidate — signals unrecorded historical trades. */
  orphanedOrderEvidence?: ParsedOrderEvidence[];
  existingPortfolioHint: { multiple: boolean; names: string[] } | undefined;
  mergeSuggestion: string | undefined;
  /** The real EGX symbol this group's company-name-fallback "ticker" maps to (see tickerForCompanyNameFallback) — drives the one-click rename banner. */
  knownTickerSuggestion?: string;
  /**
   * Every real, already-committed Trade for this ticker (any portfolio) —
   * drives the "Recorded on the ledger" panel shown on a blocked ticker,
   * letting a duplicate/misread buy be found and deleted right here instead
   * of on the Trades page. Distinct from addedTradeIds, which only covers
   * trades this Import session itself just created.
   */
  existingTradesForTicker?: Trade[];
  /** Deletes one already-recorded trade directly from this panel (see ImportPage's deleteExistingTrade). Guarded server-side the same way the Trades page's own delete is — refused if any shares were already closed against it. */
  onDeleteExistingTrade?: (tradeId: string) => void;
}) {
  const t = useT();
  const matched = matchStatus?.matched ?? false;
  const [renaming, setRenaming] = useState(false);
  const [draftTicker, setDraftTicker] = useState(ticker);
  const orderEvidences = group.orderEvidences ?? [];
  // An evidence-only group (Orders-history rows and nothing else) is
  // trivially matched but has nothing to distribute — a Confirm button on it
  // would be a no-op pretending to be an action.
  const hasCommittable =
    group.buys.length + group.sells.length + group.verifications.length + group.dividends.length > 0;
  // "No matching order" is only a meaningful signal when the broker's order
  // history for this ticker was actually uploaded AND the ticker isn't
  // already matched — an absent screenshot proves nothing about any row.
  // Covers both "mismatch" (a broker position screenshot disagrees) and
  // "no-verification" (no screenshot at all, e.g. a fully closed position
  // with no "My Position" screen to ever upload) — either way, a row this
  // ticker's own uploaded order history doesn't corroborate is the likely
  // place a missing/misread/duplicate transaction is hiding, and unlike a
  // combinatorial "which subset reconciles" solver this scales to any
  // number of pending rows.
  const tickerHasFulfilledOrders = orderEvidences.some((e) => e.evidence.status === "fulfilled");
  // How many rows the mismatch subset-solver could actually consider — the
  // "no combination explains it" wording is only honest at or below the
  // solver's exhaustive-search cap (see MAX_RECONCILE_ROWS).
  const stillPendingCount = [...group.buys, ...group.sells].filter(
    (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
  ).length;
  const highlightUnmatchedByOrders =
    tickerHasFulfilledOrders && (matchStatus?.reason === "mismatch" || matchStatus?.reason === "no-verification");
  /**
   * A "no-verification" ticker's gap is almost always confined to a
   * specific stretch of dates, not spread evenly across the whole history
   * (see findLastBalancedDate) — narrows "which transaction is wrong"
   * beyond just badging every unconfirmed row, deterministically and
   * without a combinatorial search.
   */
  const lastBalanced = useMemo(() => {
    if (matchStatus?.matched) return undefined;
    const stillPendingRows = [...group.buys, ...group.sells].filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return findLastBalancedDate({
      rows: stillPendingRows.map((e) => ({ key: e.key, side: e.candidate.side, shares: e.candidate.shares, date: e.candidate.date })),
      existingRemainingShares: matchStatus?.existingRemainingShares ?? 0,
    });
  }, [group.buys, group.sells, matchStatus, addedKeys, skippedKeys, dismissedKeys]);
  // Only meaningful for the "no-verification" shortfall banner below — a
  // pending Sell total that exceeds existing-ledger + pending-Buy shares
  // means the ledger is missing Buy history, not missing a screenshot. Read
  // directly off matchStatus (checkTickerMatch's own echoed inputs) rather
  // than re-deriving from group.buys/group.sells here — the single
  // canonical figure the match/mismatch decision was actually computed
  // against, so this display can never again silently drift from the
  // engine's own numbers the way it once did (see importVerification.ts).
  const pendingSellShares = matchStatus?.pendingSellShares ?? 0;
  const pendingBuyShares = matchStatus?.pendingBuyShares ?? 0;
  /**
   * Signed net effect of the still-pending rows flagged "Duplicate"
   * (+buys, -sells). Rows keep counting toward netShares until the user
   * discards them — the system deliberately never auto-deletes — so a
   * position that looks fully closed can still show a non-zero net purely
   * because of flagged duplicates. Surfacing "discarding them brings the
   * net to X" turns that from a mystery into one obvious action.
   */
  const duplicateFlaggedNet = useMemo(() => {
    const stillPending = (e: { key: string }) =>
      !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key) && suspectedDuplicateKeys.has(e.key);
    return (
      group.buys.filter(stillPending).reduce((sum, e) => sum + e.candidate.shares, 0) -
      group.sells.filter(stillPending).reduce((sum, e) => sum + e.candidate.shares, 0)
    );
  }, [group.buys, group.sells, addedKeys, skippedKeys, dismissedKeys, suspectedDuplicateKeys]);
  const netAfterDiscardingDuplicates = (matchStatus?.netShares ?? 0) - duplicateFlaggedNet;

  /**
   * Constraint Validation Layer: consumes checkTickerMatch's own already-
   * computed output (matchStatus) plus the other diagnosis signals this card
   * already has in scope (reconcileSuggestion, lastBalanced,
   * wrongTickerHints/dateMisreadHints, orphanedOrderEvidence) — recomputes
   * nothing. See constraintValidation.ts: facts first, objective
   * contradiction second, diagnosis only ever after that.
   */
  const constraintReport = useMemo(() => {
    if (!matchStatus || group.buys.length + group.sells.length === 0) return undefined;
    const stillPendingRows = [...group.buys, ...group.sells].filter(
      (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
    );
    return buildTickerConstraintReport(ticker, matchStatus, {
      reconcileSuggestion,
      lastBalancedDate: lastBalanced,
      wrongTickerHintCount: stillPendingRows.filter((e) => wrongTickerHints?.has(e.key)).length,
      dateMisreadHintCount: stillPendingRows.filter((e) => dateMisreadHints?.has(e.key)).length,
      orphanedOrderEvidenceCount: orphanedOrderEvidence?.length ?? 0,
      discrepancySide: matchStatus.discrepancySide,
    });
  }, [
    ticker,
    matchStatus,
    group.buys,
    group.sells,
    addedKeys,
    skippedKeys,
    dismissedKeys,
    reconcileSuggestion,
    lastBalanced,
    wrongTickerHints,
    dateMisreadHints,
    orphanedOrderEvidence,
  ]);

  /**
   * Evidence Resolution's minimal-document recommendation (completenessEngine.ts)
   * for a still-unmatched ticker — reuses the exact same engine the
   * RawTransaction-based path already uses, fed from this card's own
   * already-computed signals (matchStatus, orphanedOrderEvidence,
   * lastBalanced) rather than a second, parallel implementation. Only
   * meaningful once unmatched — a matched ticker has nothing to recover.
   */
  const completenessReport = useMemo((): TickerCompletenessReport | undefined => {
    if (!matchStatus || matchStatus.matched || group.buys.length + group.sells.length === 0) return undefined;
    const status: TickerStatus = {
      ...matchStatus,
      ticker,
      orphanedOrderEvidence: orphanedOrderEvidence ?? [],
      wrongTickerHintCount: 0,
      dateMisreadHintCount: 0,
      lastBalancedDate: lastBalanced,
    };
    return assessTickerCompleteness(status);
  }, [matchStatus, group.buys, group.sells, ticker, orphanedOrderEvidence, lastBalanced]);

  function confirmRename() {
    onRenameTicker(draftTicker);
    setRenaming(false);
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      {mergeSuggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-300">
          <span>
            {t("importPage.mergeSuggestionText", { ticker: mergeSuggestion })}
          </span>
          <button
            onClick={() => onRenameTicker(mergeSuggestion)}
            className="rounded-md border border-amber-400/40 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-500/10"
          >
            {t("importPage.mergeInto", { ticker: mergeSuggestion })}
          </button>
        </div>
      ) : null}
      {!mergeSuggestion && knownTickerSuggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-cyan-500/5 px-4 py-2.5 text-xs text-cyan-300">
          <span>
            {t("importPage.knownTickerSuggestionText", { ticker, realTicker: knownTickerSuggestion })}
          </span>
          <button
            onClick={() => onRenameTicker(knownTickerSuggestion)}
            className="rounded-md border border-cyan-400/40 px-2.5 py-1 font-medium text-cyan-300 hover:bg-cyan-500/10"
          >
            {t("importPage.renameToTicker", { ticker: knownTickerSuggestion })}
          </button>
        </div>
      ) : null}
      {existingPortfolioHint ? (
        <div className="border-b border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-400">
          {existingPortfolioHint.multiple
            ? t("importPage.existingPortfolioHintMultiple", { ticker, names: existingPortfolioHint.names.join(", ") })
            : t("importPage.existingPortfolioHintSingle", { ticker, name: existingPortfolioHint.names[0] })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        {renaming ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draftTicker}
              onChange={(e) => setDraftTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRename();
                if (e.key === "Escape") {
                  setDraftTicker(ticker);
                  setRenaming(false);
                }
              }}
              className="w-24 rounded border border-cyan-500/50 bg-slate-800 px-2 py-1 text-sm font-semibold text-slate-100"
            />
            <button
              onClick={confirmRename}
              className="rounded-md bg-cyan-500 px-2 py-1 text-xs font-medium text-slate-950 hover:bg-cyan-400"
            >
              {t("importPage.save")}
            </button>
            <button
              onClick={() => {
                setDraftTicker(ticker);
                setRenaming(false);
              }}
              className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800"
            >
              {t("importPage.cancel")}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setDraftTicker(ticker);
                setRenaming(true);
              }}
              title={t("importPage.renameTitle")}
              className="flex items-center gap-1.5 text-sm font-semibold text-slate-100 hover:text-cyan-400"
            >
              {ticker}
              <Pencil size={12} className="text-slate-500" />
            </button>
            {!matchStatus?.matched ? (
              <button
                onClick={onRestoreTicker}
                title={t("importPage.restoreTickerRows", { ticker })}
                className="rounded p-0.5 text-slate-500 hover:text-amber-400 hover:bg-amber-500/10"
              >
                <RotateCcw size={12} />
              </button>
            ) : null}
            {onResetTicker ? (
              <button
                onClick={onResetTicker}
                title={t("importPage.resetTickerTitle", { ticker })}
                className="rounded p-0.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </div>
        )}
        <div className="flex items-center gap-3">
          <MatchBadge status={matchStatus} />
          <label className="flex items-center gap-2 text-xs text-slate-400">
            {t("importPage.portfolioLabel")}
            <select
              value={portfolioId}
              onChange={(e) => onPortfolioChange(e.target.value)}
              className={`rounded border px-2 py-1 text-xs ${
                portfolioResolved
                  ? "border-slate-700 bg-slate-800 text-slate-100"
                  : "border-cyan-500/50 bg-slate-800 text-cyan-300"
              }`}
            >
              {!portfolioResolved ? (
                <option value="" disabled>
                  {t("importPage.selectPortfolioPlaceholder")}
                </option>
              ) : null}
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {matched && portfolioResolved && hasCommittable ? (
            <button
              onClick={onConfirmTicker}
              disabled={distributing}
              title={t("importPage.confirmTickerTitle", { ticker })}
              className="flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {distributing ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              {t("importPage.confirmTickerButton", { ticker })}
            </button>
          ) : null}
        </div>
      </div>
      {constraintReport ? <ConstraintReportPanel report={constraintReport} t={t} /> : null}
      {completenessReport?.recoveryPlan ? <RecoveryPlanPanel report={completenessReport} t={t} /> : null}
      {matchStatus?.reason === "matched" && (matchStatus.existingRemainingShares ?? 0) > 0 ? (
        <div className="border-b border-slate-800 bg-emerald-500/5 px-4 py-2 text-xs text-slate-400">
          {t("importPage.matchesBrokerBanner", {
            onLedger: formatShares(matchStatus.existingRemainingShares!),
            batch: formatShares(matchStatus.netShares - matchStatus.existingRemainingShares!),
            total: formatShares(matchStatus.verifiedUnits ?? matchStatus.netShares),
          })}
        </div>
      ) : null}
      {orphanedOrderEvidence && orphanedOrderEvidence.length > 0 && matchStatus?.reason === "matched" ? (
        <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          {t("importPage.orphanedEvidenceBanner", { n: orphanedOrderEvidence.length })}
        </div>
      ) : null}
      {matchStatus?.reason === "no-verification" && matchStatus.netShares < -1e-6 ? (
        <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
          {t("importPage.missingBuyHistoryBanner", {
            ticker,
            pendingSellShares: formatShares(pendingSellShares),
            existing: formatShares(matchStatus.existingRemainingShares ?? 0),
            pendingBuy: formatShares(pendingBuyShares),
            available: formatShares((matchStatus.existingRemainingShares ?? 0) + pendingBuyShares),
            short: formatShares(-matchStatus.netShares),
          })}
        </div>
      ) : matchStatus?.reason === "no-verification" ? (
        <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          <p>
            {t("importPage.needsScreenshotBanner", {
              ticker,
              netShares: formatShares(matchStatus.netShares),
              suffix: tickerHasFulfilledOrders
                ? t("importPage.needsScreenshotSuffixHasOrders")
                : t("importPage.needsScreenshotSuffixNoOrders"),
            })}
          </p>
          {Math.abs(matchStatus.existingRemainingShares ?? 0) > 1e-6 ? (
            <p className="mt-1.5">
              {t("importPage.netBreakdownHint", {
                existing: formatShares(matchStatus.existingRemainingShares ?? 0),
                pendingBuy: formatShares(pendingBuyShares),
                pendingSell: formatShares(pendingSellShares),
                net: formatShares(matchStatus.netShares),
              })}
            </p>
          ) : null}
          {matchStatus.discrepancySide ? (
            <p className="mt-1.5 font-medium">
              {"⚠ "}
              {matchStatus.discrepancySide === "buy" && pendingBuyShares < 1e-6
                ? t("importPage.discrepancySideLedgerBuy", { ticker, net: formatShares(matchStatus.netShares) })
                : matchStatus.discrepancySide === "buy"
                  ? t("importPage.discrepancySideBuy")
                  : t("importPage.discrepancySideSell")}
            </p>
          ) : null}
          {Math.abs(duplicateFlaggedNet) > 1e-6 ? (
            <p className="mt-1.5 text-cyan-300">
              {Math.abs(netAfterDiscardingDuplicates) < 1e-6
                ? t("importPage.duplicateDiscardHintZero", { dupNet: formatShares(duplicateFlaggedNet) })
                : t("importPage.duplicateDiscardHint", {
                    dupNet: formatShares(duplicateFlaggedNet),
                    after: formatShares(netAfterDiscardingDuplicates),
                  })}
            </p>
          ) : null}
          {lastBalanced ? (
            <p className="mt-1.5 text-cyan-300">{t("importPage.lastBalancedHint", { date: formatDate(lastBalanced.date) })}</p>
          ) : null}
        </div>
      ) : matchStatus?.reason === "mismatch" && matchStatus.alreadyFullyRecorded && placeholderReplacement ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-300">
          <span>
            {t("importPage.placeholderReplaceBanner", { ticker, verified: formatShares(matchStatus.verifiedUnits!) })}
          </span>
          <button
            onClick={onReplacePlaceholder}
            disabled={replacingPlaceholder}
            className="shrink-0 rounded-md border border-cyan-400/40 px-2.5 py-1 font-medium text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50"
          >
            {replacingPlaceholder ? t("importPage.replacing") : t("importPage.replacePlaceholder")}
          </button>
        </div>
      ) : matchStatus?.reason === "mismatch" && matchStatus.alreadyFullyRecorded ? (
        <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("importPage.alreadyFullyRecordedBanner", { ticker, extra: formatShares(matchStatus.netShares - matchStatus.verifiedUnits!) })}
            </span>
            <button
              onClick={onDiscardAllPending}
              className="shrink-0 rounded-md border border-rose-400/40 px-2.5 py-1 font-medium text-rose-300 hover:bg-rose-500/10"
            >
              {t("importPage.discardAllPendingFor", { ticker })}
            </button>
          </div>
          {lastBalanced ? (
            <p className="mt-1.5 text-cyan-300">{t("importPage.lastBalancedHint", { date: formatDate(lastBalanced.date) })}</p>
          ) : null}
        </div>
      ) : matchStatus?.reason === "mismatch" && reconcileSuggestion ? (
        <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("importPage.mismatchReconcileBanner", {
                existingSuffix: (matchStatus.existingRemainingShares ?? 0) > 0 ? t("importPage.existingLedgerSuffix", { existing: formatShares(matchStatus.existingRemainingShares!) }) : "",
                netShares: formatShares(matchStatus.netShares),
                verified: formatShares(matchStatus.verifiedUnits ?? 0),
                removeCount: reconcileSuggestion.keysToRemove.length,
                avgCostSuffix: reconcileSuggestion.rankedByAvgCost ? t("importPage.rankedByAvgCostSuffix") : "",
                alternativesSuffix: t("importPage.alternativesSuffix", { n: reconcileSuggestion.alternatives }),
              })}
            </span>
            <button
              onClick={() => onDiscardPendingKeys?.(reconcileSuggestion.keysToRemove)}
              className="shrink-0 rounded-md border border-rose-400/40 px-2.5 py-1 font-medium text-rose-300 hover:bg-rose-500/10"
            >
              {t("importPage.removeSuggestedRows", { n: reconcileSuggestion.keysToRemove.length })}
            </button>
          </div>
          {lastBalanced ? (
            <p className="mt-1.5 text-cyan-300">{t("importPage.lastBalancedHint", { date: formatDate(lastBalanced.date) })}</p>
          ) : null}
        </div>
      ) : matchStatus?.reason === "mismatch" ? (
        <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
          <p>
            {t("importPage.mismatchGenericBanner", {
              existingSuffix: (matchStatus.existingRemainingShares ?? 0) > 0 ? t("importPage.existingLedgerSuffix", { existing: formatShares(matchStatus.existingRemainingShares!) }) : "",
              netShares: formatShares(matchStatus.netShares),
              verified: formatShares(matchStatus.verifiedUnits ?? 0),
            })}
          </p>
          {matchStatus.discrepancySide ? (
            <p className="mt-1.5 font-medium">
              {"⚠ "}
              {matchStatus.discrepancySide === "buy"
                ? t("importPage.discrepancySideBuy")
                : t("importPage.discrepancySideSell")}
            </p>
          ) : null}
          {matchStatus.verifiedUnits !== undefined ? (
            <p className="mt-1.5 text-cyan-300">
              {t(
                // The strong "no combination of removable rows explains it" claim
                // is only true when the solver actually searched exhaustively —
                // it skips batches above MAX_RECONCILE_ROWS, so those get the
                // softer wording instead of a false assertion.
                stillPendingCount <= MAX_RECONCILE_ROWS
                  ? "importPage.mismatchGapHint"
                  : "importPage.mismatchGapHintLarge",
                {
                  gap: formatShares(Math.abs(matchStatus.netShares - matchStatus.verifiedUnits)),
                  direction:
                    matchStatus.netShares > matchStatus.verifiedUnits
                      ? t("importPage.mismatchGapTooMany")
                      : t("importPage.mismatchGapTooFew"),
                },
              )}
            </p>
          ) : null}
          {lastBalanced ? (
            <p className="mt-1.5 text-cyan-300">{t("importPage.lastBalancedHint", { date: formatDate(lastBalanced.date) })}</p>
          ) : null}
        </div>
      ) : !portfolioResolved ? (
        <div className="border-b border-slate-800 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-300">
          {t("importPage.newTickerAmbiguousBanner")}
        </div>
      ) : null}

      {!matched && (existingTradesForTicker?.length ?? 0) > 0 ? (
        <div className="border-b border-slate-800 bg-slate-950/40 px-4 py-2 text-xs">
          <p className="text-slate-400">{t("importPage.existingTradesPanelTitle", { n: existingTradesForTicker!.length })}</p>
          <ul className="mt-1.5 space-y-1">
            {existingTradesForTicker!.map((tr) => {
              const deletable = tr.remainingShares === tr.shares;
              return (
                <li key={tr.id} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-slate-400">
                  <span className="tabular-nums">
                    {formatShares(tr.shares)} sh @ {formatMoney(tr.entryPrice)} · {formatDate(tr.executionDate)}
                  </span>
                  {deletable ? (
                    <button
                      onClick={() => onDeleteExistingTrade?.(tr.id)}
                      title={t("importPage.deleteTradeTitle")}
                      className="shrink-0 rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : (
                    <span title={t("importPage.cannotDeleteHasSells")} className="shrink-0 text-slate-700">
                      <Trash2 size={12} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {(() => {
            const failedId = existingTradesForTicker!.find((tr) => rowErrors[tr.id])?.id;
            return failedId ? <p className="mt-1 text-rose-400">{rowErrors[failedId]}</p> : null;
          })()}
        </div>
      ) : null}

      <div className="divide-y divide-slate-800">
        {group.buys.filter((entry) => !skippedKeys.has(entry.key)).map((entry) => {
          const match = duplicateMatch(entry.candidate, addedTradeIds[entry.key]);
          return (
            <AutoCommitRow
              key={entry.key}
              entry={entry}
              match={match}
              added={addedKeys.has(entry.key)}
              skipped={skippedKeys.has(entry.key)}
              dismissed={dismissedKeys.has(entry.key)}
              portfolioResolved={portfolioResolved}
              matched={matched}
              distributing={distributing}
              error={rowErrors[entry.key]}
              suspectedDuplicate={suspectedDuplicateKeys.has(entry.key)}
              suggestedRemoval={reconcileSuggestion?.keysToRemove.includes(entry.key) ?? false}
              wrongTickerHint={wrongTickerHints?.get(entry.key)}
              dateMisreadHint={dateMisreadHints?.get(entry.key)}
              crossSourceVerified={crossVerifiedKeys?.has(entry.key) ?? false}
              aggregateConfirmed={aggregateConfirmedKeys?.has(entry.key) ?? false}
              aggregateMatchDetail={aggregateGroupDetailByKey?.get(entry.key)}
              orderConfirmed={orderConfirmedKeys?.has(entry.key) ?? false}
              noMatchingOrder={highlightUnmatchedByOrders && !(orderConfirmedKeys?.has(entry.key) ?? false)}
              onDelete={() => onDeleteAutoAdded(entry)}
              onDiscardPending={() => onDiscardPending(entry)}
            />
          );
        })}
        {group.sells.filter((entry) => !skippedKeys.has(entry.key)).map((entry) => {
          const match = duplicateMatch(entry.candidate, undefined, addedAllocationIds?.[entry.key]);
          const added = addedKeys.has(entry.key);
          const disabled = !matched || !portfolioResolved;
          return (
            <CandidateRow
              key={entry.key}
              entry={entry}
              match={match}
              added={added}
              skipped={skippedKeys.has(entry.key)}
              actionLabel={match ? t("importPage.allocateAnyway") : t("importPage.allocateSell")}
              actionClassName="bg-rose-500 hover:bg-rose-400"
              onAction={() => onAllocateSell(entry)}
              disabled={disabled}
              disabledReason={
                !matched
                  ? t("importPage.verifyTickerFirst")
                  : !portfolioResolved
                    ? t("importPage.pickPortfolioFirst")
                    : undefined
              }
              suspectedDuplicate={suspectedDuplicateKeys.has(entry.key)}
              suggestedRemoval={reconcileSuggestion?.keysToRemove.includes(entry.key) ?? false}
              wrongTickerHint={wrongTickerHints?.get(entry.key)}
              dateMisreadHint={dateMisreadHints?.get(entry.key)}
              crossSourceVerified={crossVerifiedKeys?.has(entry.key) ?? false}
              aggregateConfirmed={aggregateConfirmedKeys?.has(entry.key) ?? false}
              aggregateMatchDetail={aggregateGroupDetailByKey?.get(entry.key)}
              orderConfirmed={orderConfirmedKeys?.has(entry.key) ?? false}
              noMatchingOrder={highlightUnmatchedByOrders && !(orderConfirmedKeys?.has(entry.key) ?? false)}
              onDiscardPending={() => onDiscardPending(entry)}
            />
          );
        })}
        {(() => {
          const skippedCount = [...group.buys, ...group.sells].filter((e) => skippedKeys.has(e.key)).length;
          return skippedCount > 0 ? (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-slate-500">
              <CheckCircle2 size={13} className="text-slate-500" />
              {t("importPage.duplicatesHidden", { count: skippedCount })}
            </div>
          ) : null;
        })()}
        {group.verifications.map((entry) => (
          <div key={entry.key} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate-300">
                <ShieldCheck size={14} className="text-cyan-400" />
                {t("importPage.brokerPositionCheck", {
                  units: formatShares(entry.verification.units),
                  avgCostSuffix: entry.verification.avgCost !== undefined ? t("importPage.avgCostSuffix", { avgCost: formatMoney(entry.verification.avgCost) }) : "",
                })}
              </span>
              {acceptedKeys.has(entry.key) ? (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 size={14} /> {t("importPage.accepted")}
                </span>
              ) : !matched ? (
                <span className="text-xs text-amber-300">{t("importPage.blockedNeedsVerification")}</span>
              ) : !portfolioResolved ? (
                <span className="text-xs text-slate-500">{t("importPage.waitingForPortfolio")}</span>
              ) : distributing ? (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Loader2 size={13} className="animate-spin" /> {t("importPage.accepting")}
                </span>
              ) : (
                <span className="text-xs text-slate-500">{t("importPage.readyClickConfirm")}</span>
              )}
            </div>
            {rowErrors[entry.key] ? <p className="mt-1.5 text-xs text-rose-400">{rowErrors[entry.key]}</p> : null}
          </div>
        ))}
        {group.dividends.map((entry) => (
          <div key={entry.key} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate-300">
                <CircleDollarSign size={14} className="text-emerald-400" />
                {t("importPage.dividendRow", { amount: formatMoney(entry.dividend.amount), date: formatDate(entry.dividend.date) })}
              </span>
              {addedKeys.has(entry.key) ? (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 size={14} /> {t("importPage.added")}
                </span>
              ) : !matched ? (
                <span className="text-xs text-amber-300">{t("importPage.blockedNeedsVerification")}</span>
              ) : !portfolioResolved ? (
                <span className="text-xs text-slate-500">{t("importPage.waitingForPortfolio")}</span>
              ) : distributing ? (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Loader2 size={13} className="animate-spin" /> {t("importPage.adding")}
                </span>
              ) : (
                <span className="text-xs text-slate-500">{t("importPage.readyClickConfirm")}</span>
              )}
            </div>
            {rowErrors[entry.key] ? <p className="mt-1.5 text-xs text-rose-400">{rowErrors[entry.key]}</p> : null}
          </div>
        ))}
        {/* Cancelled orders are pure noise during manual review — a struck-through
            BUY/SELL line still reads like a transaction at a glance and invites
            recording something that never executed. They stay in the session data
            (nothing here commits), but only fulfilled orders render. */}
        {orderEvidences.filter((entry) => entry.evidence.status === "fulfilled").map((entry) => (
          <div key={entry.key} className="px-4 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <History size={13} className={entry.evidence.status === "fulfilled" ? "text-cyan-400" : "text-slate-600"} />
                {entry.evidence.date
                  ? t("importPage.transactionsHistoryRow", {
                      side: entry.evidence.side,
                      date: formatDate(entry.evidence.date),
                      total: formatMoney(entry.evidence.totalValue),
                    })
                  : t("importPage.ordersHistoryRow", {
                      side: entry.evidence.side,
                      shares: formatShares(entry.evidence.shares ?? 0),
                      price: formatMoney(entry.evidence.price ?? 0),
                      orderType: entry.evidence.orderType ?? "",
                      total: formatMoney(entry.evidence.totalValue),
                    })}
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    entry.evidence.status === "fulfilled" ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-700/40 text-slate-400 line-through"
                  }`}
                >
                  {entry.evidence.status === "fulfilled" ? t("importPage.fulfilled") : t("importPage.cancelled")}
                </span>
              </span>
              <button
                onClick={() => onDiscardOrderEvidence?.(entry)}
                title={t("importPage.discardOrderEvidenceTitle")}
                className="rounded p-1 text-slate-600 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The verification-gate badge on a ticker card's header — the visual anchor for the whole two-phase workflow. */
function MatchBadge({ status }: { status: TickerMatchStatus | undefined }) {
  const t = useT();
  if (!status || status.reason === "no-verification") {
    // netShares < 0 means this batch's Sell(s) already exceed what's on the
    // ledger (existing remaining shares + this batch's pending buys) — no
    // broker "My Position" screenshot can ever resolve that, since the
    // position is already sold out. The real fix is finding the missing Buy
    // history, not waiting on a screenshot that will never exist.
    if (status && status.netShares < -1e-6) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400">
          <ShieldAlert size={11} /> {t("importPage.matchMissingBuyHistory")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
        <ShieldAlert size={11} /> {t("importPage.matchNeedsScreenshot")}
      </span>
    );
  }
  if (status.reason === "mismatch") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400">
        <ShieldAlert size={11} /> {t("importPage.matchMismatch")}
      </span>
    );
  }
  if (status.reason === "closed-position") {
    // matched=true here means an independent source (invoice/cross/orders
    // history) already corroborated the closed round-trip; matched=false
    // means the net-zero arithmetic alone was all that was on offer — never
    // trusted by itself (see importVerification.ts's closed-position fix,
    // the JUFO/SKPC bug class). The unmatched case gets the same amber
    // "needs evidence" treatment as no-verification, plus a
    // RecoveryPlanPanel naming exactly what to upload next.
    if (!status.matched) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
          <ShieldAlert size={11} /> {t("importPage.matchClosedNeedsEvidence")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchSoldOut")}
      </span>
    );
  }
  if (status.reason === "invoice-verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchInvoiceVerified")}
      </span>
    );
  }
  if (status.reason === "cross-verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchCrossVerified")}
      </span>
    );
  }
  if (status.reason === "orders-verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> {t("importPage.matchOrdersVerified")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
      <ShieldCheck size={11} /> {t("importPage.matchVerified")}
    </span>
  );
}

/**
 * Buy rows commit as a batch once the user clicks "Confirm — Distribute to
 * Portfolios" (see ImportPage's confirmAndDistributeAll) — this only ever
 * shows status, never an action button. A "low" confidence row (an
 * unmapped-ticker guess, the tier most likely to be flat-out wrong) gets a
 * visually distinct amber-tinted treatment instead of the confirmation
 * checkbox this used to require, since there's no click left to gate — the
 * warning styling plus a one-click delete afterward is the replacement
 * safety net.
 */
export function AutoCommitRow({
  entry,
  match,
  added,
  skipped,
  dismissed,
  portfolioResolved,
  matched,
  distributing,
  error,
  suspectedDuplicate = false,
  suggestedRemoval = false,
  wrongTickerHint,
  dateMisreadHint,
  crossSourceVerified = false,
  aggregateConfirmed = false,
  aggregateMatchDetail,
  orderConfirmed = false,
  noMatchingOrder = false,
  onDelete,
  onDiscardPending,
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
  skipped: boolean;
  dismissed: boolean;
  portfolioResolved: boolean;
  /** Whether this row's ticker has reconciled against a broker position screenshot yet — nothing commits until it does. */
  matched: boolean;
  /** True while confirmAndDistributeAll is actively committing this row's batch. */
  distributing: boolean;
  error?: string;
  /** Flags a still-pending row as a suggested duplicate — of a sibling still pending in this batch, or of a trade already committed to the ledger (see ImportPage's pendingDuplicateCandidateKeys). Drives the "Discard" action regardless of which; the badge itself is only shown when `match` isn't already showing its own duplicate pill for the same row. */
  suspectedDuplicate?: boolean;
  /** True when the mismatch auto-reconcile solver picked this row for removal (see suggestRemovalsToReconcile) — highlights the row the banner's one-click fix would discard. */
  suggestedRemoval?: boolean;
  /** The ticker this row most likely belongs to, when it looks like a phantom wrong-ticker read of another ticker's transaction (see findWrongTickerCandidateKeys). */
  wrongTickerHint?: string;
  /** The ledger date this row's date was most likely misread from (see findDateMisreadDuplicateHints) — advisory only, never auto-discards. */
  dateMisreadHint?: string;
  /** True when this exact transaction was read from two different document types (statement + invoice, statement + orders screenshot, …) — the dual-source verification rule (see findCrossSourceVerifiedKeys). */
  crossSourceVerified?: boolean;
  /** True when this row is part of an execution group a Statement row's aggregate quantity confirmed (see findAggregateStatementMatches) — the Statement row itself never renders as a separate candidate once matched, so this row carries the confirmation instead. */
  aggregateConfirmed?: boolean;
  /** Formatted breakdown ("BUY 5,000 sh + BUY 3,000 sh") of the execution group this row belongs to — the aggregateConfirmed badge's tooltip detail. */
  aggregateMatchDetail?: string;
  /** True when a fulfilled order on the broker's Orders timeline screenshot corroborates this exact row (see findOrderConfirmedKeys). */
  orderConfirmed?: boolean;
  /** True on a mismatch when this ticker's Orders history was uploaded and no fulfilled order matches this row — the likely extra/wrong row behind the mismatch. */
  noMatchingOrder?: boolean;
  onDelete: () => void;
  /**
   * Discards this row from the pending pool outright — available on every
   * still-pending row, not just ones auto-flagged as a suspected duplicate.
   * A Mismatch banner's cause isn't always machine-detectable (see
   * checkTickerMatch's alreadyFullyRecorded and the sibling/existing-trade
   * duplicate checks — none catch every shape), so the user can manually
   * try removing whichever row they judge to be the wrong/extra one and see
   * if the ticker's total then reconciles against its broker screenshot.
   */
  onDiscardPending?: () => void;
}) {
  const t = useT();
  const c = entry.candidate;
  const isLowConfidence = c.confidence === "low";
  const stillPending = !added && !skipped && !dismissed;
  const canDiscard = suspectedDuplicate && stillPending;
  const flaggedForRemoval = stillPending && (suggestedRemoval || wrongTickerHint !== undefined);
  return (
    <div
      className={`px-4 py-2.5 text-sm ${canDiscard || flaggedForRemoval ? "bg-rose-500/5" : isLowConfidence ? "bg-amber-500/[0.04]" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
            {c.side}
          </span>
          <span className="tabular-nums text-slate-300">{formatShares(c.shares)} sh</span>
          <span className="tabular-nums text-slate-300">@ {formatMoney(c.price)}</span>
          <span className="text-slate-400">{formatDate(c.date)}</span>
          {isLowConfidence ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              <ShieldAlert size={11} /> {t("importPage.lowConfidenceGuess")}
            </span>
          ) : c.confidence ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_COLOR[c.confidence] }} />
              {confidenceLabel(t, c.confidence)}
            </span>
          ) : null}
          {match ? (
            <span
              title={
                match.matchType === "exact"
                  ? t("importPage.exactMatchTitle")
                  : t("importPage.possibleMatchTitle")
              }
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
              }`}
            >
              <ShieldAlert size={11} /> {match.matchType === "exact" ? t("importPage.duplicate") : t("importPage.possibleDuplicate")}
            </span>
          ) : null}
          {canDiscard && !match ? (
            <span
              title={t("importPage.suspectedDuplicateTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suspectedDuplicate")}
            </span>
          ) : null}
          {stillPending && wrongTickerHint ? (
            <span
              title={t("importPage.likelyOthersTransactionTitle", { ticker: wrongTickerHint })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.likelyOthersTransaction", { ticker: wrongTickerHint })}
            </span>
          ) : null}
          {stillPending && dateMisreadHint ? (
            <span
              title={t("importPage.dateMisreadHintTitle", { date: formatDate(dateMisreadHint) })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.dateMisreadHint", { date: formatDate(dateMisreadHint) })}
            </span>
          ) : null}
          {stillPending && suggestedRemoval ? (
            <span
              title={t("importPage.suggestedRemovalTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suggestedRemoval")}
            </span>
          ) : null}
          {crossSourceVerified ? (
            <span
              title={t("importPage.crossSourceVerifiedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.twoDocumentsAgree")}
            </span>
          ) : null}
          {aggregateConfirmed ? (
            <span
              title={
                aggregateMatchDetail
                  ? t("importPage.aggregateConfirmedTitleDetail", { detail: aggregateMatchDetail })
                  : t("importPage.aggregateConfirmedTitle")
              }
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.aggregateConfirmed")}
            </span>
          ) : null}
          {orderConfirmed ? (
            <span
              title={t("importPage.orderConfirmedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <History size={11} /> {t("importPage.matchesOrdersHistory")}
            </span>
          ) : stillPending && noMatchingOrder ? (
            <span
              title={t("importPage.noMatchingOrderTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              <History size={11} /> {t("importPage.noMatchingOrder")}
            </span>
          ) : null}
        </div>
        {skipped ? (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <XCircle size={14} /> {t("importPage.skippedDuplicate")}
          </span>
        ) : dismissed ? (
          <span className="text-xs text-slate-600">{t("importPage.removed")}</span>
        ) : added ? (
          <span className="flex items-center gap-2 text-xs text-emerald-400">
            <span className="flex items-center gap-1">
              <CheckCircle2 size={14} /> {t("importPage.added")}
            </span>
            {isLowConfidence ? (
              <button
                onClick={onDelete}
                title={t("importPage.deleteTradeTitle")}
                className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </span>
        ) : canDiscard ? (
          <button
            onClick={onDiscardPending}
            title={t("importPage.discardDuplicateTitle")}
            className="flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 size={12} /> {t("importPage.discard")}
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            {!matched ? (
              <span className="text-xs text-amber-300">{t("importPage.blockedNeedsVerification")}</span>
            ) : !portfolioResolved ? (
              <span className="text-xs text-slate-500">{t("importPage.waitingForPortfolio")}</span>
            ) : distributing ? (
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <Loader2 size={13} className="animate-spin" /> {t("importPage.adding")}
              </span>
            ) : (
              <span className="text-xs text-slate-500">{t("importPage.readyClickConfirm")}</span>
            )}
            <button
              onClick={onDiscardPending}
              disabled={distributing}
              title={t("importPage.discardGenericTitle")}
              className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>
      {error ? <p className="mt-1.5 text-xs text-rose-400">{error}</p> : null}
    </div>
  );
}

/**
 * Sell is the one row type Import never batch-commits (see ImportPage's
 * commitTickerGroup doc comment) — which lot(s) it closes is an explicit
 * financial decision (ADR-002), so "Allocate Sell" always opens the
 * allocation modal for the user to review and submit. Because that modal
 * is itself the review step, a low-confidence sell doesn't need a separate
 * confirmation gate the way a batch-committed buy did — it's flagged with
 * the same amber styling, but the button stays clickable either way. It's
 * still gated on the ticker's verification-match status, though: `disabled`
 * blocks the click (with `disabledReason` as its tooltip) until this
 * ticker's share count reconciles against a broker position screenshot.
 */
export function CandidateRow({
  entry,
  match,
  added,
  skipped = false,
  actionLabel,
  actionClassName,
  onAction,
  disabled = false,
  disabledReason,
  suspectedDuplicate = false,
  suggestedRemoval = false,
  wrongTickerHint,
  dateMisreadHint,
  crossSourceVerified = false,
  aggregateConfirmed = false,
  aggregateMatchDetail,
  orderConfirmed = false,
  noMatchingOrder = false,
  onDiscardPending,
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
  /** True when this row was auto-resolved as an exact duplicate of an already-recorded transaction (see the exact-duplicate-sell auto-skip effect) — replaces the action button with a "Skipped — duplicate" state so nothing invites a double-count. */
  skipped?: boolean;
  actionLabel: string;
  actionClassName: string;
  onAction: () => void;
  disabled?: boolean;
  disabledReason?: string;
  /** Flags a still-pending row as a suggested duplicate — of a sibling still pending in this batch, or of a trade already committed to the ledger (see ImportPage's pendingDuplicateCandidateKeys). Drives the "Discard" action regardless of which; the badge itself is only shown when `match` isn't already showing its own duplicate pill for the same row. */
  suspectedDuplicate?: boolean;
  /** True when the mismatch auto-reconcile solver picked this row for removal (see suggestRemovalsToReconcile and AutoCommitRow's twin prop). */
  suggestedRemoval?: boolean;
  /** The ticker this row most likely belongs to, when it looks like a phantom wrong-ticker read (see findWrongTickerCandidateKeys and AutoCommitRow's twin prop). */
  wrongTickerHint?: string;
  /** The ledger date this row's date was most likely misread from (see findDateMisreadDuplicateHints and AutoCommitRow's twin prop). */
  dateMisreadHint?: string;
  /** True when this exact transaction was read from two different document types (see AutoCommitRow's twin prop). */
  crossSourceVerified?: boolean;
  /** True when this row is part of an execution group a Statement row's aggregate quantity confirmed (see AutoCommitRow's twin prop). */
  aggregateConfirmed?: boolean;
  /** Formatted breakdown of the execution group this row belongs to (see AutoCommitRow's twin prop). */
  aggregateMatchDetail?: string;
  /** True when a fulfilled order on the broker's Orders timeline screenshot corroborates this exact row (see AutoCommitRow's twin prop). */
  orderConfirmed?: boolean;
  /** True on a mismatch when this ticker's Orders history was uploaded and no fulfilled order matches this row (see AutoCommitRow's twin prop). */
  noMatchingOrder?: boolean;
  /** Discards this row from the pending pool outright — available on every still-pending row, not just ones auto-flagged as a suspected duplicate (see AutoCommitRow's onDiscardPending). */
  onDiscardPending?: () => void;
}) {
  const t = useT();
  const c = entry.candidate;
  const isLowConfidence = c.confidence === "low";
  const canDiscard = suspectedDuplicate && !added && !skipped;
  const flaggedForRemoval = !added && !skipped && (suggestedRemoval || wrongTickerHint !== undefined);
  return (
    <div
      className={`px-4 py-2.5 text-sm ${canDiscard || flaggedForRemoval ? "bg-rose-500/5" : isLowConfidence ? "bg-amber-500/[0.04]" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              c.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
            }`}
          >
            {c.side}
          </span>
          <span className="tabular-nums text-slate-300">{formatShares(c.shares)} sh</span>
          <span className="tabular-nums text-slate-300">@ {formatMoney(c.price)}</span>
          <span className="text-slate-400">{formatDate(c.date)}</span>
          {isLowConfidence ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              <ShieldAlert size={11} /> {t("importPage.lowConfidenceGuess")}
            </span>
          ) : c.confidence ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_COLOR[c.confidence] }} />
              {confidenceLabel(t, c.confidence)}
            </span>
          ) : null}
          {match ? (
            <span
              title={
                match.matchType === "exact"
                  ? t("importPage.exactMatchTitle")
                  : t("importPage.possibleMatchTitle")
              }
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
              }`}
            >
              <ShieldAlert size={11} /> {match.matchType === "exact" ? t("importPage.duplicate") : t("importPage.possibleDuplicate")}
            </span>
          ) : null}
          {canDiscard && !match ? (
            <span
              title={t("importPage.suspectedDuplicateTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suspectedDuplicate")}
            </span>
          ) : null}
          {!added && wrongTickerHint ? (
            <span
              title={t("importPage.likelyOthersTransactionTitle", { ticker: wrongTickerHint })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.likelyOthersTransaction", { ticker: wrongTickerHint })}
            </span>
          ) : null}
          {!added && dateMisreadHint ? (
            <span
              title={t("importPage.dateMisreadHintTitle", { date: formatDate(dateMisreadHint) })}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.dateMisreadHint", { date: formatDate(dateMisreadHint) })}
            </span>
          ) : null}
          {!added && suggestedRemoval ? (
            <span
              title={t("importPage.suggestedRemovalTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300"
            >
              <ShieldAlert size={11} /> {t("importPage.suggestedRemoval")}
            </span>
          ) : null}
          {crossSourceVerified ? (
            <span
              title={t("importPage.crossSourceVerifiedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.twoDocumentsAgree")}
            </span>
          ) : null}
          {aggregateConfirmed ? (
            <span
              title={
                aggregateMatchDetail
                  ? t("importPage.aggregateConfirmedTitleDetail", { detail: aggregateMatchDetail })
                  : t("importPage.aggregateConfirmedTitle")
              }
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <ShieldCheck size={11} /> {t("importPage.aggregateConfirmed")}
            </span>
          ) : null}
          {orderConfirmed ? (
            <span
              title={t("importPage.orderConfirmedTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300"
            >
              <History size={11} /> {t("importPage.matchesOrdersHistory")}
            </span>
          ) : !added && noMatchingOrder ? (
            <span
              title={t("importPage.noMatchingOrderTitle")}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              <History size={11} /> {t("importPage.noMatchingOrder")}
            </span>
          ) : null}
        </div>
        {added ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle2 size={14} /> {t("importPage.added")}
          </span>
        ) : skipped ? (
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <CheckCircle2 size={14} /> {t("importPage.skippedDuplicate")}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <button
              onClick={onDiscardPending}
              title={
                canDiscard
                  ? t("importPage.discardDuplicateTitle")
                  : t("importPage.discardGenericTitle")
              }
              className={`rounded p-1 hover:bg-rose-500/10 ${canDiscard ? "text-rose-300" : "text-slate-500 hover:text-rose-400"}`}
            >
              <Trash2 size={13} />
            </button>
            <button
              onClick={onAction}
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              className={`rounded-md px-3 py-1 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 ${
                disabled ? "" : actionClassName
              }`}
            >
              {actionLabel}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

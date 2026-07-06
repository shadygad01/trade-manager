import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { UploadCloud, FileText, ShieldCheck, ShieldAlert, CheckCircle2, Loader2, RotateCcw, CircleDollarSign, History, Pencil, Trash2, XCircle, Eraser } from "lucide-react";
import { repos, getImportOrchestrator } from "@presentation/lib/data";
import { recordBuy, deleteTrade, renameTickerEverywhere } from "@application/services/TradeService";
import { recordDividend } from "@application/services/PortfolioService";
import {
  findDuplicateBuyMatch,
  findDuplicateSellMatch,
  dividendContentKey,
  buildExistingDividendKeys,
  suggestDuplicatePendingCandidateKeysToDelete,
  findCrossSourceVerifiedKeys,
  findWrongTickerCandidateKeys,
} from "@application/services/duplicateDetection";
import { checkTickerMatch, type TickerMatchStatus } from "@application/services/importVerification";
import {
  orderEvidenceContentKey,
  findOrderConfirmedKeys,
  findWrongTickerHintsFromOrders,
} from "@application/services/orderEvidence";
import { suggestRemovalsToReconcile, type ReconcileSuggestion } from "@application/services/mismatchResolver";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { tickerForCompanyNameFallback } from "@domain/value-objects/knownTickers";
import { isBeforeTrackingStart } from "@domain/value-objects/trackingWindow";
import type { ParsedTradeCandidate, Upload } from "@domain/entities/Upload";
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
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [queueProgress, setQueueProgress] = useState<{ index: number; total: number; fileName: string } | null>(null);
  const [recentFileResults, setRecentFileResults] = useState<{ fileName: string; warnings: string[]; duplicate: boolean }[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [sellCandidate, setSellCandidate] = useState<{ key: string; ticker: string; portfolioId: string; candidate: ParsedTradeCandidate } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [distributing, setDistributing] = useState(false);

  const session = useImportSession();
  const { pendingCandidates, pendingVerifications, pendingDividends, pendingOrderEvidences, tickerPortfolio, filesProcessed } = session;

  /**
   * Every extraction path already filters a Buy/Sell candidate dated before
   * TRACKING_START_DATE at parse time (see trackedDateRange.ts) — but
   * ThndrParser's dividend extraction didn't, until a real out-of-range
   * dividend (a 2024 payout, tracking starts 2026-01-01) reached this pool,
   * sat there looking normal, and only surfaced as a thrown error the
   * moment the user tried to confirm it. Silently dropping any out-of-range
   * candidate/dividend still sitting in the pool — regardless of which
   * extraction path let it through, including ones already stuck in a
   * session from before this fix — means there's never a row that can only
   * ever fail to commit.
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
  }, [pendingCandidates, pendingDividends]);

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
        const isDuplicateFile = Boolean(existingUpload);

        if (!isDuplicateFile) {
          const upload: Upload = {
            id: generateId(),
            fileName: currentFile.name,
            fileHash: result.fileHash,
            contentType: currentFile.type || "application/octet-stream",
            status: result.status === "failed" ? "failed" : "parsed",
            candidates: result.candidates,
            rawText: result.rawText,
            createdAt: new Date().toISOString(),
            parsedAt: new Date().toISOString(),
          };
          await repos.uploads.save(upload);

          const fileSeq = seq;
          seq += 1;
          const newCandidates = result.candidates.map((candidate, ci) => ({ key: `${fileSeq}-c${ci}`, candidate }));
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
            result.orderEvidences.forEach((evidence, oi) => {
              if (seenEvidenceKeys.has(orderEvidenceContentKey(evidence))) {
                skippedOrderEvidences += 1;
                return;
              }
              newOrderEvidences.push({ key: `${fileSeq}-o${oi}`, evidence });
            });

            return {
              ...prev,
              pendingCandidates: [...prev.pendingCandidates, ...newCandidates],
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
        if (match?.matchType === "exact") {
          importSession.update((prev) => ({ ...prev, skippedKeys: [...prev.skippedKeys, entry.key] }));
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
    const matchedTickers = tickerGroups
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
      const remainingSells = group.sells.filter((e) => !addedKeys.has(e.key));
      const pendingBuyShares = remainingBuys.reduce((sum, e) => sum + e.candidate.shares, 0);
      const pendingSellShares = remainingSells.reduce((sum, e) => sum + e.candidate.shares, 0);
      const remainingBuysAndSells = [...remainingBuys, ...remainingSells];
      const allPendingFromInvoice =
        remainingBuysAndSells.length > 0 && remainingBuysAndSells.every((e) => e.candidate.source === "invoice");
      const allPendingSelfVerified =
        remainingBuysAndSells.length > 0 &&
        remainingBuysAndSells.every((e) => e.candidate.source === "invoice" || crossVerifiedKeys.has(e.key));
      const allPendingOrderConfirmed =
        remainingBuysAndSells.length > 0 &&
        remainingBuysAndSells.every(
          (e) => e.candidate.source === "invoice" || crossVerifiedKeys.has(e.key) || orderConfirmedKeys.has(e.key),
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
          allPendingFromInvoice,
          allPendingSelfVerified,
          allPendingOrderConfirmed,
        }),
      );
    }
    return map;
  }, [tickerGroups, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingVerifications, crossVerifiedKeys, orderConfirmedKeys]);

  const unmatchedTickerCount = tickerGroups.filter(([ticker]) => !tickerMatchStatuses.get(ticker)?.matched).length;
  const matchedTickerCount = tickerGroups.length - unmatchedTickerCount;
  const allTickersMatched = tickerGroups.length > 0 && unmatchedTickerCount === 0;

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
      const status = tickerMatchStatuses.get(ticker);
      if (!status || status.reason !== "mismatch" || status.alreadyFullyRecorded) continue;
      const stillPending = [...group.buys, ...group.sells].filter(
        (e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key),
      );
      const existingForTicker = existingTrades.filter((t) => normalizeTicker(t.ticker) === ticker);
      const verificationCandidates = [
        ...existingVerifications.filter((v) => normalizeTicker(v.ticker) === ticker),
        ...group.verifications.map((e) => e.verification),
      ];
      if (verificationCandidates.length === 0) continue;
      const latestVerification = verificationCandidates.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b));
      const suggestion = suggestRemovalsToReconcile({
        rows: stillPending.map((e) => ({
          key: e.key,
          side: e.candidate.side,
          shares: e.candidate.shares,
          price: e.candidate.price,
          confidence: e.candidate.confidence,
        })),
        existingRemainingShares: existingForTicker.reduce((sum, t) => sum + t.remainingShares, 0),
        existingCostBasis: Money.sum(
          existingForTicker.map((t) => Money.from(t.entryPrice).multiply(t.remainingShares)),
        ).toNumber(),
        verifiedUnits: latestVerification.units,
        verifiedAvgCost: latestVerification.avgCost,
      });
      if (suggestion) map.set(ticker, suggestion);
    }
    return map;
  }, [tickerGroups, tickerMatchStatuses, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingVerifications]);

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
                  <span className="ml-2 text-cyan-400">{t("importPage.duplicateFileSkipped")}</span>
                ) : r.warnings.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-300/80">
                    {r.warnings.map((w, wi) => (
                      <li key={wi}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="ml-2 text-emerald-400">{t("importPage.extractedSuccessfully")}</span>
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
                {allTickersMatched
                  ? t("importPage.allMatchedStatus")
                  : matchedTickerCount > 0
                    ? t("importPage.someMatchedStatus", { matched: matchedTickerCount, total: tickerGroups.length })
                    : t("importPage.noneMatchedStatus", { unmatched: unmatchedTickerCount, total: tickerGroups.length })}
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
              <button
                onClick={() => void confirmAndDistributeAll()}
                disabled={matchedTickerCount === 0 || distributing || !initialDataLoaded}
                title={
                  matchedTickerCount === 0
                    ? t("importPage.noTickerVerified")
                    : allTickersMatched
                      ? undefined
                      : t("importPage.confirmSubsetTitle", { matched: matchedTickerCount, total: tickerGroups.length })
                }
                className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:hover:bg-slate-700"
              >
                {distributing ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                {allTickersMatched ? t("importPage.confirmDistributeAll") : t("importPage.confirmAllVerified", { n: matchedTickerCount })}
              </button>
            </div>
          </div>
          {tickerGroups.map(([ticker, group]) => {
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
                orderConfirmedKeys={orderConfirmedKeys}
                onDiscardOrderEvidence={(entry) => discardOrderEvidence(entry.key)}
                wrongTickerHints={wrongTickerHints}
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
                existingPortfolioHint={
                  existingNames.length > 0 ? { multiple: existingNames.length > 1, names: existingNames } : undefined
                }
                mergeSuggestion={mergeSuggestions.get(ticker)}
                knownTickerSuggestion={tickerForCompanyNameFallback(ticker)}
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
  orderConfirmedKeys,
  onDiscardOrderEvidence,
  wrongTickerHints,
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
  existingPortfolioHint,
  mergeSuggestion,
  knownTickerSuggestion,
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
  /** Keys of pending rows corroborated by a fulfilled order on the broker's Orders timeline screenshot (see findOrderConfirmedKeys) — drives the "Matches Orders history" badge, and its absence the "No matching order" hint on a mismatch. */
  orderConfirmedKeys?: Set<string>;
  /** Discards one misread order-evidence row (see ImportPage's discardOrderEvidence). */
  onDiscardOrderEvidence?: (entry: OrderEvidenceEntry) => void;
  /** Pending key -> the ticker a phantom wrong-ticker read most likely belongs to (see findWrongTickerCandidateKeys) — drives the "likely {other}'s transaction" badge. */
  wrongTickerHints?: Map<string, string>;
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
  existingPortfolioHint: { multiple: boolean; names: string[] } | undefined;
  mergeSuggestion: string | undefined;
  /** The real EGX symbol this group's company-name-fallback "ticker" maps to (see tickerForCompanyNameFallback) — drives the one-click rename banner. */
  knownTickerSuggestion?: string;
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
  // history for this ticker was actually uploaded AND the count doesn't
  // reconcile — an absent screenshot proves nothing about any row.
  const tickerHasFulfilledOrders = orderEvidences.some((e) => e.evidence.status === "fulfilled");
  const highlightUnmatchedByOrders = tickerHasFulfilledOrders && matchStatus?.reason === "mismatch";
  // Only meaningful for the "no-verification" shortfall banner below — a
  // pending Sell total that exceeds existing-ledger + pending-Buy shares
  // means the ledger is missing Buy history, not missing a screenshot.
  const pendingSellShares = group.sells
    .filter((e) => !addedKeys.has(e.key))
    .reduce((sum, e) => sum + e.candidate.shares, 0);
  const pendingBuyShares = group.buys
    .filter((e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key))
    .reduce((sum, e) => sum + e.candidate.shares, 0);

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
      {matchStatus?.reason === "matched" && (matchStatus.existingRemainingShares ?? 0) > 0 ? (
        <div className="border-b border-slate-800 bg-emerald-500/5 px-4 py-2 text-xs text-slate-400">
          {t("importPage.matchesBrokerBanner", {
            onLedger: formatShares(matchStatus.existingRemainingShares!),
            batch: formatShares(matchStatus.netShares - matchStatus.existingRemainingShares!),
            total: formatShares(matchStatus.verifiedUnits ?? matchStatus.netShares),
          })}
        </div>
      ) : matchStatus?.reason === "no-verification" && matchStatus.netShares < -1e-6 ? (
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
          {t("importPage.needsScreenshotBanner", {
            ticker,
            suffix: tickerHasFulfilledOrders
              ? t("importPage.needsScreenshotSuffixHasOrders")
              : t("importPage.needsScreenshotSuffixNoOrders"),
          })}
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
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
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
      ) : matchStatus?.reason === "mismatch" && reconcileSuggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
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
      ) : matchStatus?.reason === "mismatch" ? (
        <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
          {t("importPage.mismatchGenericBanner", {
            existingSuffix: (matchStatus.existingRemainingShares ?? 0) > 0 ? t("importPage.existingLedgerSuffix", { existing: formatShares(matchStatus.existingRemainingShares!) }) : "",
            netShares: formatShares(matchStatus.netShares),
            verified: formatShares(matchStatus.verifiedUnits ?? 0),
          })}
        </div>
      ) : !portfolioResolved ? (
        <div className="border-b border-slate-800 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-300">
          {t("importPage.newTickerAmbiguousBanner")}
        </div>
      ) : null}

      <div className="divide-y divide-slate-800">
        {group.buys.map((entry) => {
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
              crossSourceVerified={crossVerifiedKeys?.has(entry.key) ?? false}
              orderConfirmed={orderConfirmedKeys?.has(entry.key) ?? false}
              noMatchingOrder={highlightUnmatchedByOrders && !(orderConfirmedKeys?.has(entry.key) ?? false)}
              onDelete={() => onDeleteAutoAdded(entry)}
              onDiscardPending={() => onDiscardPending(entry)}
            />
          );
        })}
        {group.sells.map((entry) => {
          const match = duplicateMatch(entry.candidate, undefined, addedAllocationIds?.[entry.key]);
          const added = addedKeys.has(entry.key);
          const disabled = !matched || !portfolioResolved;
          return (
            <CandidateRow
              key={entry.key}
              entry={entry}
              match={match}
              added={added}
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
              crossSourceVerified={crossVerifiedKeys?.has(entry.key) ?? false}
              orderConfirmed={orderConfirmedKeys?.has(entry.key) ?? false}
              noMatchingOrder={highlightUnmatchedByOrders && !(orderConfirmedKeys?.has(entry.key) ?? false)}
              onDiscardPending={() => onDiscardPending(entry)}
            />
          );
        })}
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
        {orderEvidences.map((entry) => (
          <div key={entry.key} className="px-4 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <History size={13} className={entry.evidence.status === "fulfilled" ? "text-cyan-400" : "text-slate-600"} />
                {t("importPage.ordersHistoryRow", {
                  side: entry.evidence.side,
                  shares: formatShares(entry.evidence.shares),
                  price: formatMoney(entry.evidence.price),
                  orderType: entry.evidence.orderType,
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
  crossSourceVerified = false,
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
  /** True when this exact transaction was read from two different document types (statement + invoice, statement + orders screenshot, …) — the dual-source verification rule (see findCrossSourceVerifiedKeys). */
  crossSourceVerified?: boolean;
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
  actionLabel,
  actionClassName,
  onAction,
  disabled = false,
  disabledReason,
  suspectedDuplicate = false,
  suggestedRemoval = false,
  wrongTickerHint,
  crossSourceVerified = false,
  orderConfirmed = false,
  noMatchingOrder = false,
  onDiscardPending,
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
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
  /** True when this exact transaction was read from two different document types (see AutoCommitRow's twin prop). */
  crossSourceVerified?: boolean;
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
  const canDiscard = suspectedDuplicate && !added;
  const flaggedForRemoval = !added && (suggestedRemoval || wrongTickerHint !== undefined);
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

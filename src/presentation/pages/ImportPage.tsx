import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { UploadCloud, FileText, ShieldCheck, ShieldAlert, CheckCircle2, Loader2, RotateCcw, CircleDollarSign, Pencil, Trash2, XCircle } from "lucide-react";
import { repos, getImportOrchestrator } from "@presentation/lib/data";
import { recordBuy, deleteTrade, renameTickerEverywhere } from "@application/services/TradeService";
import { recordDividend } from "@application/services/PortfolioService";
import { findDuplicateBuyMatch, findDuplicateSellMatch } from "@application/services/duplicateDetection";
import { checkTickerMatch, type TickerMatchStatus } from "@application/services/importVerification";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { ParsedTradeCandidate, Upload } from "@domain/entities/Upload";
import {
  importSession,
  useImportSession,
  type CandidateEntry,
  type VerificationEntry,
  type DividendEntry,
} from "@presentation/lib/importSession";
import { PageHeader } from "@presentation/components/PageHeader";
import { Modal } from "@presentation/components/Modal";
import { EmptyState } from "@presentation/components/EmptyState";
import { SellAllocationForm } from "@presentation/components/SellAllocationForm";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";
import { STATUS } from "@presentation/lib/chartColors";

const CONFIDENCE_STYLE: Record<"high" | "medium" | "low", { label: string; color: string }> = {
  high: { label: "High", color: STATUS.good },
  medium: { label: "Medium", color: STATUS.warning },
  low: { label: "Low", color: STATUS.critical },
};

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
function dividendContentKey(d: { ticker: string; date: string; amount: number }): string {
  return `${normalizeTicker(d.ticker)}|${d.date}|${d.amount}`;
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
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [queueProgress, setQueueProgress] = useState<{ index: number; total: number; fileName: string } | null>(null);
  const [recentFileResults, setRecentFileResults] = useState<{ fileName: string; warnings: string[]; duplicate: boolean }[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [sellCandidate, setSellCandidate] = useState<{ key: string; ticker: string; portfolioId: string; candidate: ParsedTradeCandidate } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [distributing, setDistributing] = useState(false);

  const session = useImportSession();
  const { pendingCandidates, pendingVerifications, pendingDividends, tickerPortfolio, filesProcessed } = session;
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
    existingVerificationsRaw !== undefined;

  function duplicateMatch(candidate: ParsedTradeCandidate) {
    return candidate.side === "BUY"
      ? findDuplicateBuyMatch(candidate, existingTrades)
      : findDuplicateSellMatch(candidate, existingAllocations);
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

            const seenDividendKeys = new Set(prev.pendingDividends.map((e) => dividendContentKey(e.dividend)));
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

            return {
              ...prev,
              pendingCandidates: [...prev.pendingCandidates, ...newCandidates],
              pendingVerifications: [...prev.pendingVerifications, ...newVerifications],
              pendingDividends: [...prev.pendingDividends, ...newDividends],
            };
          });

          const dedupWarnings: string[] = [];
          if (skippedVerifications > 0) {
            dedupWarnings.push("This position reading matches one already in the list — not added again.");
          }
          if (skippedDividends > 0) {
            dedupWarnings.push(
              `${skippedDividends} dividend${skippedDividends === 1 ? "" : "s"} already in the list — not added again.`,
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
    if (!confirm("Delete this trade? Its cost will be refunded to the portfolio's cash balance. This can't be undone.")) {
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
   * The single entry point for actually moving anything into a portfolio.
   * Only ever called by an explicit user click on "Confirm — Distribute to
   * Portfolios", and only ever commits tickers whose match status is
   * already true — Step 1's extraction and Step 2's per-ticker portfolio
   * picks never write a real Trade/Dividend/PositionVerification on their
   * own. This is the two-phase gate: extract-and-verify, then a single
   * explicit confirmation before anything is allocated.
   */
  async function confirmAndDistributeAll() {
    if (!initialDataLoaded || !allTickersMatched) return;
    setDistributing(true);
    try {
      const matchedTickers = tickerGroups
        .filter(([ticker]) => tickerMatchStatuses.get(ticker)?.matched)
        .map(([ticker]) => ticker);
      await Promise.all(matchedTickers.map((ticker) => commitTickerGroup(ticker)));
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
      { buys: CandidateEntry[]; sells: CandidateEntry[]; verifications: VerificationEntry[]; dividends: DividendEntry[] }
    >();
    const group = (ticker: string) => {
      const t = normalizeTicker(ticker);
      const g = map.get(t) ?? { buys: [], sells: [], verifications: [], dividends: [] };
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
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pendingCandidates, pendingVerifications, pendingDividends]);

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
      const pendingBuyShares = group.buys
        .filter((e) => !addedKeys.has(e.key) && !skippedKeys.has(e.key) && !dismissedKeys.has(e.key))
        .reduce((sum, e) => sum + e.candidate.shares, 0);
      const pendingSellShares = group.sells
        .filter((e) => !addedKeys.has(e.key))
        .reduce((sum, e) => sum + e.candidate.shares, 0);
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
        }),
      );
    }
    return map;
  }, [tickerGroups, addedKeys, skippedKeys, dismissedKeys, existingTrades, existingVerifications]);

  const unmatchedTickerCount = tickerGroups.filter(([ticker]) => !tickerMatchStatuses.get(ticker)?.matched).length;
  const allTickersMatched = tickerGroups.length > 0 && unmatchedTickerCount === 0;

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
        title="Import"
        description="Step 1: extract every transaction from as many screenshots/PDFs/CSVs as you need. Step 2: every ticker's share count must match a broker 'My Position' screenshot before anything can be distributed. Only once every ticker is verified can you confirm and allocate to portfolios."
        actions={
          <button
            onClick={() => {
              if (
                confirm(
                  "Clear all? This wipes the extracted list and this device's uploaded-file history (so a re-uploaded file is no longer treated as a duplicate). Trades you've already added are not affected."
                )
              ) {
                void clearAll();
              }
            }}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <RotateCcw size={14} /> Clear all
          </button>
        }
      />

      {portfolios.length === 0 ? (
        <EmptyState
          title="Create a portfolio first"
          description="Distributing extracted trades needs at least one portfolio to assign them to."
          action={
            <Link href="/portfolios" className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              Create a portfolio
            </Link>
          }
        />
      ) : null}

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Step 1 — Extract</h3>
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
          <p className="text-sm font-medium text-slate-200">Drag & drop screenshots, PDFs, or CSVs here — select as many at once as you like</p>
          <p className="text-xs text-slate-500">or</p>
          <label className="cursor-pointer rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400">
            Choose files
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
              <FileText size={14} /> Processing {queueProgress.index} of {queueProgress.total}: {queueProgress.fileName}
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
                  <span className="ml-2 text-cyan-400">already imported before — skipped as a duplicate file.</span>
                ) : r.warnings.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-300/80">
                    {r.warnings.map((w, wi) => (
                      <li key={wi}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="ml-2 text-emerald-400">extracted successfully.</span>
                )}
              </div>
            ))}
          </div>
        ) : null}

        <p className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          {totalPending > 0 ? <CheckCircle2 size={15} className="text-emerald-400" /> : null}
          <span className="font-medium">{totalPending}</span> transaction{totalPending === 1 ? "" : "s"} extracted so far
          {filesProcessed > 0 ? ` from ${filesProcessed} file${filesProcessed === 1 ? "" : "s"}` : ""}. Drop more files anytime,
          or move on to Step 2 once you're done.
        </p>
      </div>

      {tickerGroups.length > 0 ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Step 2 — Verify &amp; Distribute</h3>
              <p className="mt-1 text-xs text-slate-400">
                {allTickersMatched
                  ? "Every ticker's share count matches its broker position screenshot — ready to distribute."
                  : `${unmatchedTickerCount} of ${tickerGroups.length} ticker${tickerGroups.length === 1 ? "" : "s"} still ${
                      unmatchedTickerCount === 1 ? "needs" : "need"
                    } to match a broker position screenshot before anything can be allocated to a portfolio.`}
              </p>
            </div>
            <button
              onClick={() => void confirmAndDistributeAll()}
              disabled={!allTickersMatched || distributing || !initialDataLoaded}
              className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:hover:bg-slate-700"
            >
              {distributing ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Confirm — Distribute to Portfolios
            </button>
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
                portfolioId={portfolioForTicker(ticker)}
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
                onDeleteAutoAdded={(entry) => void deleteAutoAddedTrade(entry)}
                onAllocateSell={(entry) => setSellCandidate({ key: entry.key, ticker, portfolioId: portfolioForTicker(ticker), candidate: entry.candidate })}
                onRenameTicker={(newTicker) => void renameTickerGroup(ticker, newTicker)}
                existingPortfolioHint={
                  existingNames.length > 0 ? { multiple: existingNames.length > 1, names: existingNames } : undefined
                }
                mergeSuggestion={mergeSuggestions.get(ticker)}
              />
            );
          })}
        </div>
      ) : null}

      <Modal
        title={`Allocate Sell${sellCandidate ? ` · ${sellCandidate.ticker}` : ""}`}
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
            onDone={() => {
              importSession.update((prev) => ({ ...prev, addedKeys: [...prev.addedKeys, sellCandidate.key] }));
              setSellCandidate(null);
            }}
            onCancel={() => setSellCandidate(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function TickerGroupCard({
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
  onDeleteAutoAdded,
  onAllocateSell,
  onRenameTicker,
  existingPortfolioHint,
  mergeSuggestion,
}: {
  ticker: string;
  group: { buys: CandidateEntry[]; sells: CandidateEntry[]; verifications: VerificationEntry[]; dividends: DividendEntry[] };
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
  duplicateMatch: (candidate: ParsedTradeCandidate) => { matchType: "exact" | "possible"; matchedId: string } | undefined;
  onDeleteAutoAdded: (entry: CandidateEntry) => void;
  onAllocateSell: (entry: CandidateEntry) => void;
  onRenameTicker: (newTicker: string) => void;
  existingPortfolioHint: { multiple: boolean; names: string[] } | undefined;
  mergeSuggestion: string | undefined;
}) {
  const matched = matchStatus?.matched ?? false;
  const [renaming, setRenaming] = useState(false);
  const [draftTicker, setDraftTicker] = useState(ticker);

  function confirmRename() {
    onRenameTicker(draftTicker);
    setRenaming(false);
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      {mergeSuggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-300">
          <span>
            These rows look identical to <strong>{mergeSuggestion}</strong> — likely the same stock read as a different
            ticker.
          </span>
          <button
            onClick={() => onRenameTicker(mergeSuggestion)}
            className="rounded-md border border-amber-400/40 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-500/10"
          >
            Merge into {mergeSuggestion}
          </button>
        </div>
      ) : null}
      {existingPortfolioHint ? (
        <div className="border-b border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-400">
          {existingPortfolioHint.multiple
            ? `${ticker} already has trades in more than one portfolio (${existingPortfolioHint.names.join(", ")}) — pick where these belong.`
            : `${ticker} already has trades in ${existingPortfolioHint.names[0]} — selected automatically.`}
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
              Save
            </button>
            <button
              onClick={() => {
                setDraftTicker(ticker);
                setRenaming(false);
              }}
              className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setDraftTicker(ticker);
              setRenaming(true);
            }}
            title="Wrong ticker? Click to correct it — this fixes every pending row extracted under this name."
            className="flex items-center gap-1.5 text-sm font-semibold text-slate-100 hover:text-cyan-400"
          >
            {ticker}
            <Pencil size={12} className="text-slate-500" />
          </button>
        )}
        <div className="flex items-center gap-3">
          <MatchBadge status={matchStatus} />
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Portfolio
            <select
              value={portfolioId}
              onChange={(e) => onPortfolioChange(e.target.value)}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
            >
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {matchStatus?.reason === "no-verification" ? (
        <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          No broker "My Position" screenshot uploaded for {ticker} yet — upload one in Step 1 so its share count can be
          verified before anything is allocated to a portfolio.
        </div>
      ) : matchStatus?.reason === "mismatch" ? (
        <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
          Mismatch: extracted transactions total {formatShares(matchStatus.netShares)} shares, but the broker screenshot
          shows {formatShares(matchStatus.verifiedUnits ?? 0)} — fix a duplicate/missing row or re-upload before this can
          be distributed.
        </div>
      ) : !portfolioResolved ? (
        <div className="border-b border-slate-800 bg-cyan-500/5 px-4 py-2 text-xs text-cyan-300">
          This ticker is new to more than one of your portfolios — pick one above so it's ready once you confirm.
        </div>
      ) : null}

      <div className="divide-y divide-slate-800">
        {group.buys.map((entry) => {
          const match = duplicateMatch(entry.candidate);
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
              onDelete={() => onDeleteAutoAdded(entry)}
            />
          );
        })}
        {group.sells.map((entry) => {
          const match = duplicateMatch(entry.candidate);
          const added = addedKeys.has(entry.key);
          return (
            <CandidateRow
              key={entry.key}
              entry={entry}
              match={match}
              added={added}
              actionLabel={match ? "Allocate anyway" : "Allocate Sell"}
              actionClassName="bg-rose-500 hover:bg-rose-400"
              onAction={() => onAllocateSell(entry)}
              disabled={!matched}
              disabledReason={!matched ? "Verify this ticker's share count against a broker position screenshot first." : undefined}
            />
          );
        })}
        {group.verifications.map((entry) => (
          <div key={entry.key} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate-300">
                <ShieldCheck size={14} className="text-cyan-400" />
                Broker position check: {formatShares(entry.verification.units)} units
                {entry.verification.avgCost !== undefined ? ` @ ${formatMoney(entry.verification.avgCost)} avg` : ""}
              </span>
              {acceptedKeys.has(entry.key) ? (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 size={14} /> Accepted
                </span>
              ) : !matched ? (
                <span className="text-xs text-amber-300">Blocked — needs verification</span>
              ) : !portfolioResolved ? (
                <span className="text-xs text-slate-500">Waiting for portfolio</span>
              ) : distributing ? (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Loader2 size={13} className="animate-spin" /> Accepting…
                </span>
              ) : (
                <span className="text-xs text-slate-500">Ready — click Confirm above</span>
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
                Dividend: {formatMoney(entry.dividend.amount)} on {formatDate(entry.dividend.date)}
              </span>
              {addedKeys.has(entry.key) ? (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 size={14} /> Added
                </span>
              ) : !matched ? (
                <span className="text-xs text-amber-300">Blocked — needs verification</span>
              ) : !portfolioResolved ? (
                <span className="text-xs text-slate-500">Waiting for portfolio</span>
              ) : distributing ? (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Loader2 size={13} className="animate-spin" /> Adding…
                </span>
              ) : (
                <span className="text-xs text-slate-500">Ready — click Confirm above</span>
              )}
            </div>
            {rowErrors[entry.key] ? <p className="mt-1.5 text-xs text-rose-400">{rowErrors[entry.key]}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The verification-gate badge on a ticker card's header — the visual anchor for the whole two-phase workflow. */
function MatchBadge({ status }: { status: TickerMatchStatus | undefined }) {
  if (!status || status.reason === "no-verification") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
        <ShieldAlert size={11} /> Needs broker screenshot
      </span>
    );
  }
  if (status.reason === "mismatch") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400">
        <ShieldAlert size={11} /> Mismatch
      </span>
    );
  }
  if (status.reason === "closed-position") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
        <ShieldCheck size={11} /> Sold out — no screenshot needed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
      <ShieldCheck size={11} /> Verified
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
  onDelete,
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
  onDelete: () => void;
}) {
  const c = entry.candidate;
  const isLowConfidence = c.confidence === "low";
  return (
    <div className={`px-4 py-2.5 text-sm ${isLowConfidence ? "bg-amber-500/[0.04]" : ""}`}>
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
              <ShieldAlert size={11} /> Low-confidence ticker guess
            </span>
          ) : c.confidence ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_STYLE[c.confidence].color }} />
              {CONFIDENCE_STYLE[c.confidence].label}
            </span>
          ) : null}
          {match ? (
            <span
              title={
                match.matchType === "exact"
                  ? "Same ticker, date, shares and price as an existing trade."
                  : "Same ticker, date and shares as an existing trade, but a different price."
              }
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
              }`}
            >
              <ShieldAlert size={11} /> {match.matchType === "exact" ? "Duplicate" : "Possible duplicate"}
            </span>
          ) : null}
        </div>
        {skipped ? (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <XCircle size={14} /> Skipped — duplicate
          </span>
        ) : dismissed ? (
          <span className="text-xs text-slate-600">Removed</span>
        ) : added ? (
          <span className="flex items-center gap-2 text-xs text-emerald-400">
            <span className="flex items-center gap-1">
              <CheckCircle2 size={14} /> Added
            </span>
            {isLowConfidence ? (
              <button
                onClick={onDelete}
                title="Delete this trade and refund its cost"
                className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </span>
        ) : !matched ? (
          <span className="text-xs text-amber-300">Blocked — needs verification</span>
        ) : !portfolioResolved ? (
          <span className="text-xs text-slate-500">Waiting for portfolio</span>
        ) : distributing ? (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <Loader2 size={13} className="animate-spin" /> Adding…
          </span>
        ) : (
          <span className="text-xs text-slate-500">Ready — click Confirm above</span>
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
}: {
  entry: CandidateEntry;
  match: { matchType: "exact" | "possible"; matchedId: string } | undefined;
  added: boolean;
  actionLabel: string;
  actionClassName: string;
  onAction: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const c = entry.candidate;
  const isLowConfidence = c.confidence === "low";
  return (
    <div className={`px-4 py-2.5 text-sm ${isLowConfidence ? "bg-amber-500/[0.04]" : ""}`}>
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
              <ShieldAlert size={11} /> Low-confidence ticker guess
            </span>
          ) : c.confidence ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CONFIDENCE_STYLE[c.confidence].color }} />
              {CONFIDENCE_STYLE[c.confidence].label}
            </span>
          ) : null}
          {match ? (
            <span
              title={
                match.matchType === "exact"
                  ? "Same ticker, date, shares and price as an existing trade."
                  : "Same ticker, date and shares as an existing trade, but a different price."
              }
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                match.matchType === "exact" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"
              }`}
            >
              <ShieldAlert size={11} /> {match.matchType === "exact" ? "Duplicate" : "Possible duplicate"}
            </span>
          ) : null}
        </div>
        {added ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle2 size={14} /> Added
          </span>
        ) : (
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
        )}
      </div>
    </div>
  );
}

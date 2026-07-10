import { normalizeTicker } from "@domain/value-objects/Ticker";
import { computePositions, type PositionAggregate } from "./TradeService";
import { computeHoldings } from "./holdingsEngine";
import type { AppRepositories } from "./types";
import type { CommittedLedgerRepository, RawTransactionRepository } from "@domain/repositories";

/**
 * The production read cutover, made safe to run today instead of gated
 * behind a one-time manual sign-off: for each ticker, prefer the canonical
 * (RawTransaction -> ledgerCache -> computeHoldings) result, but fall back to
 * the legacy (Trade/TradeAllocation -> computePositions) result whenever the
 * two disagree or the canonical side has nothing yet. This is
 * systemValidation.ts's own comparison logic (`missing-in-new`/
 * `shares-mismatch`/`cost-basis-mismatch`), applied per read instead of as a
 * one-time gate a human has to manually clear first — the exact concrete
 * risk it exists to catch (a ticker whose RawTransaction verification
 * hasn't reached a terminal verdict yet — e.g. under the closed-position fix
 * from this session's first sprint — would otherwise silently vanish from
 * Holdings/Dashboard/PortfolioDetail the moment the UI stopped reading Trade
 * directly) is why this reconciles on every call rather than trusting the
 * canonical side unconditionally.
 *
 * `source: "legacy-fallback"` is not a failure state to hide — it's the
 * honest signal that this ticker's evidence hasn't been independently
 * verified end-to-end yet, exactly the same distinction
 * completenessEngine/evidenceIntelligence already draw for Import. A caller
 * that wants to explain a "legacy-fallback" position to the user can look up
 * why via `evidenceIntelligence.getEvidenceIntelligence(ticker, ...)`.
 */

export interface CanonicalPosition extends PositionAggregate {
  source: "canonical" | "legacy-fallback";
  /** Only present for "legacy-fallback" — why the canonical side wasn't trusted for this ticker. */
  fallbackReason?: string;
}

const SHARE_TOLERANCE = 1e-6;
const COST_BASIS_TOLERANCE = 0.01;

export interface CanonicalHoldingsRepos extends AppRepositories {
  rawTransactions: RawTransactionRepository;
  committedLedger: CommittedLedgerRepository;
}

/**
 * Best-effort: any failure reading the canonical side (rawTransactions/
 * committedLedger unavailable — e.g. a test fixture supplying only the
 * legacy repos surface, or a genuine Dexie read error) falls back to an
 * empty map rather than throwing, so `computeCanonicalPositions` as a whole
 * NEVER crashes the page — it degrades to plain legacy positions instead,
 * same non-fatal-shadow-read discipline this codebase already applies to
 * every dual-write (see commitEngine.ts/ImportPage.tsx's own "shadow write,
 * non-fatal" comments). A read-side crash is strictly worse than a stale
 * read: the user's Holdings page must never go blank because of it.
 */
async function tryComputeCanonicalByTicker(
  repos: CanonicalHoldingsRepos,
  portfolioId: string,
  priceMap: Record<string, number>,
): Promise<Map<string, PositionAggregate>> {
  const canonicalByTicker = new Map<string, PositionAggregate>();
  try {
    const rawForPortfolio = await repos.rawTransactions.getByPortfolio(portfolioId);
    const tickers = new Set(rawForPortfolio.filter((t) => t.ticker !== undefined).map((t) => normalizeTicker(t.ticker!)));
    for (const ticker of tickers) {
      const [events, allocations] = await Promise.all([
        repos.committedLedger.getLedgerEvents(portfolioId, ticker),
        repos.committedLedger.getAllocations(portfolioId, ticker),
      ]);
      const [holding] = computeHoldings(events, allocations, priceMap);
      if (holding) {
        canonicalByTicker.set(ticker, {
          ticker: holding.ticker,
          totalShares: holding.totalShares,
          costBasis: holding.costBasis,
          avgCost: holding.avgCost,
          currentPrice: holding.currentPrice,
          marketValue: holding.marketValue,
          unrealizedPnl: holding.unrealizedPnl,
          unrealizedPnlPct: holding.unrealizedPnlPct,
          openTrades: [],
        });
      }
    }
  } catch (err) {
    console.error("computeCanonicalPositions: canonical read failed, falling back to legacy positions only (non-fatal):", err);
  }
  return canonicalByTicker;
}

export async function computeCanonicalPositions(
  repos: CanonicalHoldingsRepos,
  portfolioId: string,
  priceMap: Record<string, number>,
): Promise<CanonicalPosition[]> {
  const legacy = await computePositions(repos, portfolioId, priceMap);
  const legacyByTicker = new Map(legacy.map((p) => [normalizeTicker(p.ticker), p]));
  const canonicalByTicker = await tryComputeCanonicalByTicker(repos, portfolioId, priceMap);

  const allTickers = new Set([...legacyByTicker.keys(), ...canonicalByTicker.keys()]);
  const result: CanonicalPosition[] = [];
  for (const ticker of allTickers) {
    const legacyPos = legacyByTicker.get(ticker);
    const canonical = canonicalByTicker.get(ticker);

    if (!legacyPos && canonical) {
      // No legacy row at all for a ticker the canonical side has — cannot
      // happen via today's write path (every write still lands in Trade
      // first), kept only so a future write-side cutover doesn't silently
      // drop a ticker that exists solely in the new architecture.
      result.push({ ...canonical, source: "canonical" });
      continue;
    }
    if (!legacyPos) continue;

    if (!canonical) {
      result.push({ ...legacyPos, source: "legacy-fallback", fallbackReason: "This ticker's evidence has not yet reached a terminal verification verdict — see Import's recovery plan for what's still missing." });
      continue;
    }

    const sharesAgree = Math.abs(canonical.totalShares - legacyPos.totalShares) < SHARE_TOLERANCE;
    const costBasisAgrees = Math.abs(canonical.costBasis - legacyPos.costBasis) < COST_BASIS_TOLERANCE;
    if (sharesAgree && costBasisAgrees) {
      result.push({ ...legacyPos, source: "canonical" });
    } else {
      result.push({
        ...legacyPos,
        source: "legacy-fallback",
        fallbackReason: `The evidence-first ledger computes ${canonical.totalShares} shares / cost basis ${canonical.costBasis.toFixed(2)} for this ticker, which disagrees with the recorded trades (${legacyPos.totalShares} shares / ${legacyPos.costBasis.toFixed(2)}) — showing the recorded trades until the discrepancy is resolved.`,
      });
    }
  }

  return result.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

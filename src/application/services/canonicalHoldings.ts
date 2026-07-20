import { normalizeTicker } from "@domain/value-objects/Ticker";
import { computePositions, type PositionAggregate } from "./TradeService";
import { computeHoldings } from "./holdingsEngine";
import type { AppRepositories } from "./types";
import type { CommittedLedgerRepository, RawTransactionRepository } from "@domain/repositories";

/**
 * The production read cutover, made safe to run today instead of gated
 * behind a one-time manual sign-off: for each ticker, prefer the canonical
 * (RawTransaction -> ledgerCache -> computeHoldings) result. Legacy
 * (Trade/TradeAllocation -> computePositions) is used ONLY when the
 * canonical side has nothing yet for this ticker (verification hasn't
 * reached a terminal verdict, e.g. under the closed-position fix from an
 * earlier sprint — the exact concrete risk that would otherwise silently
 * vanish a position from Holdings/Dashboard/PortfolioDetail the moment the
 * UI stopped reading Trade directly) or when a canonical-only position has
 * no matching legacy row at all (the disclosed `moveTrade`/`consolidateTicker`
 * orphaned-fact gap, unrelated to this rule and not fixed here).
 *
 * As of the root-cause fix in docs/ROADMAP.md's investigation, canonical is
 * trusted UNCONDITIONALLY whenever it has real committed data for a ticker —
 * including when it disagrees with legacy. Legacy is a DERIVED projection of
 * the same fact log (ledgerProjection.projectLegacyTicker), never an
 * independent source of truth, so a disagreement means legacy has drifted,
 * not that canonical might be wrong: the pure, deterministic replay engines
 * (ledgerEngine.ts/allocationEngine.ts/holdingsEngine.ts) cannot themselves
 * disagree with a complete fact log. Silently preferring legacy "until the
 * discrepancy is resolved" (the pre-fix behavior) was itself the mechanism
 * that let an already-closed position keep showing open indefinitely, since
 * nothing ever forced the discrepancy to resolve — see
 * docs/EXECUTION_GRAPH.md's "Parallel-work rules" and the investigation
 * entry in docs/ROADMAP.md for the full trace. This is what makes
 * open/partial/closed a single canonical determination
 * (holdingsEngine.computeHoldings) that Ledger, Allocation, Holdings, and
 * Portfolio all derive from — not two independently-computed answers with a
 * silent tie-break.
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
 * A ticker whose canonical ledger has real committed events (it went
 * through `commitTicker` for real) but whose lots net to zero open shares —
 * every lot fully allocated away by a real, committed `SellAllocationDecision`
 * fact. Recorded as this distinct sentinel rather than simply omitted:
 * `computeHoldings` returning nothing is otherwise indistinguishable from
 * "this ticker never reached the canonical ledger at all" (see
 * `PositionAggregate | "closed"` below), and collapsing the two meant a
 * ticker the canonical ledger had CONFIDENTLY verified closed still fell
 * back to a legacy `Trade` row whenever that row's own `remainingShares`
 * hadn't been reduced to match — a real, reproduced bug (the exact
 * "closed-positions-showing-open" report this fix answers): a Sell can only
 * ever reduce canonical shares, never invent them, so a canonical "closed"
 * verdict is asymmetrically more trustworthy than an open-vs-open share-count
 * disagreement (which stays legacy-first, unchanged — see the "disagrees"
 * branch below) or a ticker with no canonical events at all (still
 * legacy-fallback, unchanged — see `canonicalHoldings.test.ts`'s own
 * "no committed ledgerCache entry" case, which this must not regress).
 */
const CLOSED = "closed" as const;

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
): Promise<Map<string, PositionAggregate | typeof CLOSED>> {
  const canonicalByTicker = new Map<string, PositionAggregate | typeof CLOSED>();
  try {
    const rawForPortfolio = await repos.rawTransactions.getByPortfolio(portfolioId);
    const tickers = new Set(rawForPortfolio.filter((t) => t.ticker !== undefined).map((t) => normalizeTicker(t.ticker!)));
    for (const ticker of tickers) {
      const [events, allocations] = await Promise.all([
        repos.committedLedger.getLedgerEvents(portfolioId, ticker),
        repos.committedLedger.getAllocations(portfolioId, ticker),
      ]);
      // Never committed to the canonical ledger at all — leave it out of the
      // map entirely, exactly as before, so computeCanonicalPositions's own
      // "not yet verified" legacy-fallback branch still applies.
      if (events.length === 0) continue;
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
      } else {
        canonicalByTicker.set(ticker, CLOSED);
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

    if (canonical === CLOSED) {
      // The canonical ledger has real committed Buy/Sell facts for this
      // ticker and they net to zero open shares — trusted over whatever a
      // legacy Trade row still says (see tryComputeCanonicalByTicker's own
      // doc comment on why this specific verdict is trustworthy enough to
      // override a stale legacy row). Nothing to show in Holdings for a
      // closed position, same as computeHoldings/computePositions both
      // already omit one.
      continue;
    }

    if (!legacyPos && canonical) {
      // No legacy row at all for a ticker the canonical side has. The
      // original assumption here ("cannot happen via today's write path,
      // every write still lands in Trade first") is real for how a fact is
      // FIRST written, but not for what happens to it afterward: `moveTrade`
      // (and `consolidateTicker`, which calls it) reassigns a Trade's
      // `portfolioId` without ever touching the matching RawTransaction fact
      // or committedLedger cache entry it left behind in the SOURCE
      // portfolio — a real, reproduced gap (see the Phase 10 mutator-audit
      // list this codebase's own history already names `moveTrade` on).
      // Reproduced directly: after moving a Trade out of a portfolio, this
      // exact branch served a full-cost-basis phantom position for the
      // ticker in the portfolio it no longer belongs to, with zero open
      // lots to back it up (`openTrades: []`, hardcoded on every canonical
      // entry) — a real, live bug, not the hypothetical future-architecture
      // case the original comment anticipated. Until `moveTrade`/
      // `consolidateTicker` are fixed to correct their facts too, an
      // unbacked canonical-only position is untrustworthy by construction
      // (nothing independently corroborates it), so it's dropped here
      // instead of shown — logged, not silent, so it stays discoverable.
      console.error(
        `computeCanonicalPositions: dropping an unbacked canonical-only position for ${ticker} in portfolio ${portfolioId} (${canonical.totalShares} shares, no matching legacy Trade) — likely an orphaned fact left behind by moveTrade/consolidateTicker.`,
      );
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
      // Root-cause fix (docs/ROADMAP.md's investigation): trust the
      // fact-replay side over the legacy Trade/TradeAllocation projection
      // whenever they disagree and the canonical side has real committed
      // data for this ticker. The two are never independent alternatives —
      // legacy is a DERIVED projection of the same fact log
      // (ledgerProjection.projectLegacyTicker), so a disagreement means the
      // legacy row has drifted from its own source of truth (a missing
      // SellAllocationDecision fact, a stale cache, a partial write — see
      // the investigation for the concrete mechanisms this codebase already
      // has), never the other way around: the pure, deterministic replay
      // engines (ledgerEngine.ts/allocationEngine.ts/holdingsEngine.ts)
      // cannot themselves be wrong given a complete fact log. Previously
      // this branch showed the (possibly stale) legacy numbers "until the
      // discrepancy is resolved" — which is exactly the mechanism that let
      // an already-closed position keep showing open indefinitely, since
      // nothing ever forced the discrepancy to resolve. This is what makes
      // Ledger/Allocation/Holdings/Portfolio all derive open/closed state
      // from the one canonical rule (holdingsEngine.computeHoldings) instead
      // of legacy silently overriding it on any disagreement.
      //
      // `openTrades: []` is the same disclosed limitation the adjacent "no
      // legacy row" branch above already accepts for a canonical-only
      // position — canonical has no Trade-shaped per-lot detail to offer,
      // only the ticker-level totals holdingsEngine.computeHoldings computed.
      result.push({
        ticker: canonical.ticker,
        totalShares: canonical.totalShares,
        costBasis: canonical.costBasis,
        avgCost: canonical.avgCost,
        currentPrice: canonical.currentPrice,
        marketValue: canonical.marketValue,
        unrealizedPnl: canonical.unrealizedPnl,
        unrealizedPnlPct: canonical.unrealizedPnlPct,
        openTrades: [],
        source: "canonical",
      });
    }
  }

  return result.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

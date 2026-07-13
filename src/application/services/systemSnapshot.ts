import type { RawTransaction, RawTransactionSource } from "@domain/entities/RawTransaction";
import type { RawTransactionRepository, PortfolioRepository } from "@domain/repositories";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { isRetracted } from "./rawTransactionFolds";
import { generateLedgerEvents, type LedgerEvent } from "./ledgerEngine";
import { generateAllocations, type Allocation } from "./allocationEngine";
import { computeHoldings } from "./holdingsEngine";
import { verifyAllDetailed } from "./verificationEngine";
import { authorityRank } from "./evidenceAuthority";
import { resolveCurrentPortfolioId } from "./commitEngine";

/**
 * System Snapshot: a deterministic, content-only fingerprint of the entire
 * replayable state for one portfolio (Facts, Ledger, Holdings, Allocation,
 * Verification, Portfolio, Policy), each independently hashed plus one
 * combined hash — the artifact the end-to-end Determinism Test
 * (determinism.e2e.test.ts) compares against a committed golden reference.
 *
 * "Deterministic" here means: replaying the exact same sequence of Facts
 * through the exact same engines twice, in two independently-constructed
 * databases, must produce byte-identical hashes — even though every row's
 * own `id` (`generateId()`), `seq`, and timestamp fields (`recordedAt`,
 * `createdAt`) are randomly generated per run and therefore MUST differ
 * between the two runs. Every category below is normalized specifically to
 * strip those random fields and re-express any cross-reference (a
 * SellAllocationDecision's `sellExecutionId`, a Correction's `targetId`, an
 * Allocation's `lotEventId`, ...) as a CONTENT key of whatever it points to,
 * rather than the pointed-to row's own random id. This reuses, in spirit,
 * the same "coarse content signature" concept `ledgerRebuild.canonicalKey`/
 * `duplicateDetection.pendingCandidateSignature` already established in this
 * codebase — but content keys here are used ONLY for hashing/snapshot
 * identity, never as a replay-time lookup key (see docs/PORTFOLIO_OS_V2_SPEC.md
 * Part 4.2 on why conflating those two uses is exactly the bug class this
 * codebase has fought hardest — this module never resolves a lookup by
 * content key, only by real id, then substitutes content strings into the
 * OUTPUT it hashes).
 *
 * Known, disclosed limitation: two Facts with byte-identical content (e.g.
 * a genuine twin-lot pair sharing every printed field) produce the same
 * content key, so a reference to either would be indistinguishable in the
 * snapshot. This does not weaken the Determinism Test's actual claim
 * (replaying the SAME facts twice yields the SAME snapshot) since it's a
 * property of the domain data, not of this module's normalization — flagged
 * for completeness, not because it's been observed to cause a false pass.
 */

/**
 * Deliberately just these two — no `committedLedger`. Ledger/Allocation/
 * Holdings below are computed by calling `generateLedgerEvents`/
 * `generateAllocations`/`computeHoldings` directly against the live Facts,
 * not by reading `ledgerCache`/`allocationsCache`. This snapshot exists to
 * prove REPLAY determinism (same Facts in -> same output out); reading the
 * cache instead would test cache freshness, a different, already-covered
 * concern (see `canonicalHoldings.ts`'s legacy/canonical reconciliation).
 */
export interface SnapshotRepos {
  rawTransactions: RawTransactionRepository;
  portfolios: PortfolioRepository;
}

export interface SystemSnapshot {
  facts: string;
  ledger: string;
  holdings: string;
  allocation: string;
  verification: string;
  portfolio: string;
  policy: string;
  /** Hash of the seven category hashes above, in this fixed order — the single value a golden-reference test compares. */
  combined: string;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((acc: Record<string, unknown>, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/** A pure-content fingerprint of one fact's own payload — never a real id, never used as a lookup key, only ever substituted into hashed output. `refs` (already-resolved content keys for any id this payload references) lets a fact's own key incorporate what it points to, so two structurally-identical corrections targeting two DIFFERENT (but also structurally-identical) facts still don't collide with each other's targets by accident. */
function leafContentKey(fact: RawTransaction): string {
  return stableStringify({ kind: fact.kind, source: fact.source, ticker: fact.ticker ? normalizeTicker(fact.ticker) : undefined, payload: fact.payload });
}

interface ResolvableRefs {
  targetId?: string;
  sellExecutionId?: string;
  allocations?: { lotRef: string; shares: number }[];
}

/**
 * Builds a stable id -> content-key map for every live fact, resolving
 * reference fields (targetId/sellExecutionId/lotRef) to fixed point — a
 * fact that references another reference-bearing fact (e.g. a Correction of
 * a Correction) keeps re-resolving until nothing changes, mirroring
 * purge.ts's own supersedes-chain-to-fixpoint pattern.
 */
function buildContentKeyMap(facts: RawTransaction[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const f of facts) keys.set(f.id, leafContentKey(f));

  let changed = true;
  let guard = 0;
  while (changed && guard < facts.length + 5) {
    changed = false;
    guard += 1;
    for (const f of facts) {
      const refs = f.payload as ResolvableRefs;
      const resolvedRefs: Record<string, unknown> = {};
      let touchedAnyRef = false;
      if (refs.targetId !== undefined) {
        resolvedRefs.targetId = keys.get(refs.targetId) ?? refs.targetId;
        touchedAnyRef = true;
      }
      if (refs.sellExecutionId !== undefined) {
        resolvedRefs.sellExecutionId = keys.get(refs.sellExecutionId) ?? refs.sellExecutionId;
        touchedAnyRef = true;
      }
      if (refs.allocations !== undefined) {
        resolvedRefs.allocations = refs.allocations.map((a) => ({ lotRef: keys.get(a.lotRef) ?? a.lotRef, shares: a.shares }));
        touchedAnyRef = true;
      }
      if (!touchedAnyRef) continue;
      const nextKey = stableStringify({
        kind: f.kind,
        source: f.source,
        ticker: f.ticker ? normalizeTicker(f.ticker) : undefined,
        payload: { ...(f.payload as object), ...resolvedRefs },
      });
      if (nextKey !== keys.get(f.id)) {
        keys.set(f.id, nextKey);
        changed = true;
      }
    }
  }
  return keys;
}

/**
 * A control fact (PortfolioAssignment/Correction/Retraction) carries no
 * portfolioId of its own (`createRawTransaction` is never called with one
 * for these kinds — see commitEngine.ts's `assignPortfolio`/
 * `retractRawTransaction`/`renameRawTransactionsTicker`) — it belongs to
 * whichever portfolio its TARGET resolves to, not to `resolveCurrentPortfolioId`
 * applied to itself (which would only find an assignment pointed AT the
 * control fact, essentially never true). Every other kind uses
 * `resolveCurrentPortfolioId` directly, exactly like `relevantTradeTransactions`.
 */
function resolveEffectivePortfolioId(all: RawTransaction[], fact: RawTransaction): string | undefined {
  if (fact.kind === "PortfolioAssignment" || fact.kind === "Correction" || fact.kind === "Retraction") {
    const targetId = (fact.payload as { targetId?: string }).targetId;
    const target = targetId !== undefined ? all.find((t) => t.id === targetId) : undefined;
    return target ? resolveCurrentPortfolioId(all, target) : fact.portfolioId;
  }
  return resolveCurrentPortfolioId(all, fact);
}

export async function computeSystemSnapshot(repos: SnapshotRepos, portfolioId: string, tickers?: string[]): Promise<SystemSnapshot> {
  // Deliberately NOT `getByPortfolio(portfolioId)`: commitEngine.ts's own
  // `relevantTradeTransactions` documents exactly why — a RawTransaction's
  // own `portfolioId` field can stay undefined even once it's effectively
  // assigned via a separate PortfolioAssignment fact (adoption never
  // rewrites the original fact, only adds a pointer). Using `getByPortfolio`
  // here silently dropped every adopted Buy/Sell fact from the Facts
  // category and, worse, broke cross-reference resolution for anything that
  // pointed at one (a SellAllocationDecision's `lotRef` fell back to the raw,
  // random fact id since the target wasn't in `contentKeys` at all) — caught
  // by this module's own determinism test comparing two independent runs,
  // not by inspection.
  const allFacts = await repos.rawTransactions.getAll();
  const liveGlobal = allFacts.filter((f) => !isRetracted(allFacts, f.id));
  const contentKeys = buildContentKeyMap(liveGlobal);
  const liveFacts = liveGlobal.filter((f) => resolveEffectivePortfolioId(liveGlobal, f) === portfolioId);

  const resolvedTickers = (
    tickers ?? Array.from(new Set(liveFacts.map((f) => f.ticker).filter((t): t is string => t !== undefined).map(normalizeTicker)))
  ).sort();

  // ---- Facts ----
  const factsNormalized = liveFacts
    .map((f) => contentKeys.get(f.id)!)
    .sort();
  const facts = await sha256Hex(stableStringify(factsNormalized));

  // ---- Ledger + Allocation + Holdings (per-ticker replay, same engines the app itself uses) ----
  let ledgerEvents: LedgerEvent[] = [];
  let allocations: Allocation[] = [];
  for (const ticker of resolvedTickers) {
    const relevant = liveFacts.filter((f) => f.ticker !== undefined && normalizeTicker(f.ticker) === ticker);
    const tradeTxns = relevant.filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution");
    const decisionTxns = relevant.filter((t) => t.kind === "SellAllocationDecision");
    const events = generateLedgerEvents(tradeTxns);
    ledgerEvents = ledgerEvents.concat(events);
    allocations = allocations.concat(generateAllocations(events, decisionTxns));
  }

  const eventKeyByEventId = new Map<string, string>();
  for (const e of ledgerEvents) {
    eventKeyByEventId.set(
      e.eventId,
      stableStringify({
        type: e.type,
        ticker: normalizeTicker(e.ticker),
        executionDate: e.executionDate,
        executionTime: e.executionTime,
        shares: e.shares,
        price: e.price,
        fees: e.fees,
        taxes: e.taxes,
        transactionNumber: e.transactionNumber,
        companyName: e.type === "LotOpened" ? e.companyName : undefined,
      })
    );
  }
  const ledgerNormalized = Array.from(eventKeyByEventId.values()).sort();
  const ledger = await sha256Hex(stableStringify(ledgerNormalized));

  const allocationNormalized = allocations
    .map((a) =>
      stableStringify({
        sell: eventKeyByEventId.get(a.sellEventId) ?? a.sellEventId,
        lot: eventKeyByEventId.get(a.lotEventId) ?? a.lotEventId,
        shares: a.shares,
        price: a.price,
        fees: a.fees,
        taxes: a.taxes,
        executionDate: a.executionDate,
        executionTime: a.executionTime,
        transactionNumber: a.transactionNumber,
      })
    )
    .sort();
  const allocation = await sha256Hex(stableStringify(allocationNormalized));

  // ---- Holdings (empty price map: current price is external, volatile,
  // and out of scope for a REPLAY determinism claim) ----
  const holdingsRaw = computeHoldings(ledgerEvents, allocations, {});
  const holdingsNormalized = holdingsRaw
    .map((h) => stableStringify({ ticker: h.ticker, totalShares: h.totalShares, costBasis: h.costBasis, avgCost: h.avgCost }))
    .sort();
  const holdings = await sha256Hex(stableStringify(holdingsNormalized));

  // ---- Verification ----
  const verificationResult = verifyAllDetailed({ transactions: liveFacts, positions: [] });
  const transactionVerdicts = Array.from(verificationResult.transactions.entries())
    .filter(([id]) => contentKeys.has(id))
    .map(([id, v]) =>
      stableStringify({ fact: contentKeys.get(id), verdict: v.verdict, evidenceTypes: v.evidence.map((e) => e.type).sort() })
    )
    .sort();
  const tickerStatuses = Array.from(verificationResult.tickers.entries())
    .filter(([ticker]) => resolvedTickers.includes(ticker))
    .map(([ticker, s]) =>
      stableStringify({
        ticker,
        matched: s.matched,
        reason: s.reason,
        netShares: s.netShares,
        existingRemainingShares: s.existingRemainingShares,
        pendingBuyShares: s.pendingBuyShares,
        pendingSellShares: s.pendingSellShares,
        verifiedUnits: s.verifiedUnits,
        verifiedAvgCost: s.verifiedAvgCost,
        alreadyFullyRecorded: s.alreadyFullyRecorded,
        discrepancySide: s.discrepancySide,
      })
    )
    .sort();
  const verification = await sha256Hex(stableStringify({ transactionVerdicts, tickerStatuses }));

  // ---- Portfolio ----
  const portfolioRow = await repos.portfolios.getById(portfolioId);
  const portfolioNormalized = portfolioRow
    ? { name: portfolioRow.name, kind: portfolioRow.kind, cash: portfolioRow.cash, archivedAt: portfolioRow.archivedAt ?? null }
    : null;
  const portfolio = await sha256Hex(stableStringify(portfolioNormalized));

  // ---- Policy ----
  const knownSources: RawTransactionSource[] = [
    "statement",
    "invoice",
    "official-broker-excel",
    "orders-screen",
    "orders-timeline",
    "position-verification",
    "csv",
    "notification",
    "email",
    "screenshot",
    "other-document",
    "manual",
    "backfill",
  ];
  const authorityRanking = knownSources.map((s) => [s, authorityRank(s)] as const);
  const verdictCounts = { Verified: 0, Rejected: 0, "Needs Review": 0 } as Record<string, number>;
  for (const v of verificationResult.transactions.values()) verdictCounts[v.verdict] += 1;
  const policy = await sha256Hex(stableStringify({ authorityRanking, verdictCounts }));

  const combined = await sha256Hex([facts, ledger, holdings, allocation, verification, portfolio, policy].join("|"));

  return { facts, ledger, holdings, allocation, verification, portfolio, policy, combined };
}

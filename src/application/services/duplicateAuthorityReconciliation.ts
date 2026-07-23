import {
  createRawTransaction,
  type RawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import type { Trade } from "@domain/entities/Trade";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { isRetracted, resolveCurrentTicker } from "./rawTransactionFolds";
import { canonicalKey } from "./ledgerRebuild";
import { authorityRank } from "./evidenceAuthority";
import { timesConflict } from "./duplicateDetection";
import type { LegacyLedgerRepos } from "./ledgerProjection";
import type { CommitEngineRepos } from "./commitEngine";

/**
 * Closes a structural gap `duplicateMatch`/`upgradeFact` (ImportPage.tsx)
 * never covers: those only ever reconcile a fact against a NEW candidate
 * actively being extracted in an Import session, comparing it against the
 * legacy Trade/TradeAllocation projection. Any OTHER writer that appends a
 * live execution fact outside that flow — e.g. `ensureLegacyFactsExist`
 * (ledgerProjection.ts) reactively gap-filling a legacy Trade — never passes
 * through that check at all, so two live facts describing the identical
 * execution (same canonicalKey) can coexist indefinitely with nothing to
 * converge them, regardless of which one was appended first, which ticker,
 * or which portfolio. This is that missing convergence step, generic across
 * every ticker/portfolio/execution: whenever more than one live fact shares
 * a canonicalKey, only the highest-`authorityRank` one survives.
 *
 * Deliberately scoped to one (already-resolved) ticker per call, run from
 * `commitTicker` right after `ensureLegacyFactsExist`, never a
 * database-wide sweep — the same "no unattended full-portfolio rewrite"
 * safety boundary this codebase's BF-1 Validation Design established. A
 * genuine tie (`authorityRank` equal — e.g. two "manual" facts) is never
 * resolved automatically, mirroring `higherAuthority`'s own "ties favor
 * neither" rule; only a STRICTLY higher-ranked survivor triggers anything.
 *
 * canonicalKey alone (ticker/date/shares/price) is NOT sufficient proof two
 * facts describe the SAME execution — crossTransactionIsolation.test.ts's
 * whole "twin lot" suite exists because two genuinely DISTINCT real
 * executions routinely share that exact value (e.g. two same-price
 * same-day orders). A first version of this function ignored that and
 * wrongly merged a twin-lot pair in exactly that test, caught by the
 * regression suite before shipping. `findLiveExecutionFact`'s own
 * `timesConflict` tie-break is the established, already-tested primitive
 * for this distinction, reused first: if ANY pair within a canonicalKey
 * group has a genuinely conflicting `executionTime` (proving they're
 * different real orders, not one execution described twice), the WHOLE
 * group is left untouched.
 *
 * That alone still isn't enough: a SECOND real, reproduced defect (same
 * test, same investigation) showed `ensureLegacyFactsExist` can itself
 * nondeterministically mint a redundant gap-fill fact for one twin lot even
 * while its own already-adopted extraction-time fact is still live — a
 * pre-existing Gap Filling behavior, out of this fix's scope to correct
 * (see docs/ROADMAP.md Sprint 16). When that happens, the redundant fact's
 * `executionTime` can coincidentally match its sibling's, defeating the
 * `timesConflict` check alone. The second guard therefore consults the
 * legacy Trades when they are available (they always are from
 * `commitTicker`): a group is skipped only when its facts are compatible
 * with MORE THAN ONE same-value Trade. This preserves the twin-lot safety
 * boundary without throwing away a safe convergence merely because another
 * same-value Trade exists at a different, conflicting time.
 *
 * Buy-side: a Buy fact is never referenced by another fact's id, so a plain
 * retraction is the whole fix (mirrors `upgradeFact`'s own BUY branch).
 * Sell-side: also re-points a live SellAllocationDecision referencing the
 * losing fact at the survivor instead of leaving it dangling — the same
 * swap provenanceRepair.ts's own `upgradeSellExecutionFact` performs for
 * its narrower ("manual"-only) historical case, inlined here rather than
 * imported to avoid a circular dependency (provenanceRepair.ts already
 * imports commitEngine.ts for `retractRawTransaction`/`appendAndMaybeCommit`).
 *
 * Every write below goes straight to `repos.rawTransactions.append` —
 * never `retractRawTransaction`/`appendAndMaybeCommit` — for the exact
 * reason `ensureLegacyFactsExist`'s own doc comment states: this runs
 * INSIDE `commitTicker`, and `appendAndMaybeCommit` reactively re-triggers
 * `commitTicker` on every append. A real, reproduced regression caught this
 * the hard way (the same twin-lot suite above, on a first attempt at this
 * fix): the recursive re-entrant commit interleaved with the outer call's
 * own `projectLegacyTicker` run and transiently deleted a still-open Trade
 * row before its own Sell could reference it. Diagnostics tracing is
 * intentionally skipped here for the same reason `ensureLegacyFactsExist`
 * has none — there is no `WriterContext`-carrying choke point available at
 * this recursion depth that doesn't reintroduce the same hazard.
 */
export async function reconcileDuplicateAuthority(
  repos: CommitEngineRepos & Partial<LegacyLedgerRepos>,
  ticker: string
): Promise<number> {
  const normalized = normalizeTicker(ticker);
  let convergedCount = 0;

  // Keep the actual Trade times, rather than only their number. A
  // time-resolved pair of facts can safely converge even when a different
  // twin lot shares its time-blind canonicalKey.
  let buysByKey: Map<string, Trade[]> | undefined;
  if (repos.trades) {
    const allTrades = await repos.trades.getAll();
    buysByKey = new Map<string, Trade[]>();
    for (const t of allTrades) {
      if (normalizeTicker(t.ticker) !== normalized) continue;
      const key = canonicalKey({ side: "BUY", ticker: normalized, date: t.executionDate, shares: t.shares, price: t.entryPrice });
      const matches = buysByKey.get(key) ?? [];
      matches.push(t);
      buysByKey.set(key, matches);
    }
  }

  for (const kind of ["BuyExecution", "SellExecution"] as const) {
    const all = await repos.rawTransactions.getAll();
    const live = all.filter((t) => {
      if (t.kind !== kind) return false;
      if (isRetracted(all, t.id)) return false;
      const resolved = resolveCurrentTicker(all, t);
      return resolved !== undefined && normalizeTicker(resolved) === normalized;
    });

    const byKey = new Map<string, RawTransaction[]>();
    for (const t of live) {
      const p = t.payload as BuyExecutionPayload | SellExecutionPayload;
      const key = canonicalKey({
        side: kind === "BuyExecution" ? "BUY" : "SELL",
        ticker: normalized,
        date: p.executionDate,
        shares: p.shares,
        price: p.price,
      });
      const list = byKey.get(key) ?? [];
      list.push(t);
      byKey.set(key, list);
    }

    for (const [key, facts] of byKey.entries()) {
      if (facts.length <= 1) continue;

      const timeOf = (t: RawTransaction) => (t.payload as BuyExecutionPayload | SellExecutionPayload).executionTime;
      const hasConflictingTwin = facts.some((a, i) => facts.some((b, j) => i < j && timesConflict(timeOf(a), timeOf(b))));
      if (hasConflictingTwin) continue; // at least one pair is provably a distinct real execution — never merge this group.

      if (kind === "BuyExecution") {
        const compatibleTrades = (buysByKey?.get(key) ?? []).filter((trade) =>
          facts.every((fact) => !timesConflict(timeOf(fact), trade.executionTime)),
        );
        // Projection can contain two Trade rows for the very duplicate fact
        // pair we are trying to converge. Count distinct broker/time claims,
        // not rows, so those derived duplicates do not masquerade as genuine
        // twin lots. Different transaction numbers or execution times remain
        // separate real executions and retain the conservative guard.
        const distinctExecutionClaims = new Set(
          compatibleTrades.map((trade) =>
            trade.transactionNumber
              ? `number:${trade.transactionNumber}`
              : `time:${trade.executionTime || "unknown"}`,
          ),
        );
        if (distinctExecutionClaims.size >= 2) continue;
      }

      const best = facts.reduce((a, b) => (authorityRank(b.source) > authorityRank(a.source) ? b : a));
      for (const loser of facts) {
        if (loser.id === best.id) continue;
        if (authorityRank(loser.source) >= authorityRank(best.source)) continue; // tie — never auto-resolved.

        await repos.rawTransactions.append(
          createRawTransaction({
            kind: "Retraction",
            source: "manual",
            payload: { targetId: loser.id, reason: "Provenance upgrade: superseded by a higher-authority document describing the same execution." },
          })
        );

        if (kind === "BuyExecution") {
          // Allocation decisions reference the concrete BuyExecution id as
          // their lotRef. When provenance convergence replaces a legacy Buy
          // with the broker-Excel fact, every live decision pointing at the
          // loser must move too; otherwise the Allocation Engine drops those
          // decisions as orphaned and Holdings jumps back to gross purchases.
          const freshAll = await repos.rawTransactions.getAll();
          const affectedDecisions = freshAll.filter((transaction) => {
            if (transaction.kind !== "SellAllocationDecision" || isRetracted(freshAll, transaction.id)) return false;
            return (transaction.payload as SellAllocationDecisionPayload).allocations.some((allocation) => allocation.lotRef === loser.id);
          });
          for (const decision of affectedDecisions) {
            await repos.rawTransactions.append(
              createRawTransaction({
                kind: "Retraction",
                source: "manual",
                payload: { targetId: decision.id, reason: "Provenance upgrade: re-pointed allocation lots at the higher-authority BuyExecution fact." },
              }),
            );
            const payload = decision.payload as SellAllocationDecisionPayload;
            await repos.rawTransactions.append(
              createRawTransaction({
                kind: "SellAllocationDecision",
                source: "manual",
                portfolioId: decision.portfolioId,
                ticker: decision.ticker,
                payload: {
                  sellExecutionId: payload.sellExecutionId,
                  allocations: payload.allocations.map((allocation) =>
                    allocation.lotRef === loser.id ? { ...allocation, lotRef: best.id } : allocation,
                  ),
                },
              }),
            );
          }
        } else {
          const freshAll = await repos.rawTransactions.getAll();
          const decision = freshAll.find(
            (t) =>
              t.kind === "SellAllocationDecision" &&
              !isRetracted(freshAll, t.id) &&
              (t.payload as SellAllocationDecisionPayload).sellExecutionId === loser.id
          );
          if (decision) {
            await repos.rawTransactions.append(
              createRawTransaction({
                kind: "Retraction",
                source: "manual",
                payload: { targetId: decision.id, reason: "Provenance upgrade: re-pointed at the higher-authority SellExecution fact." },
              })
            );
            const replacementPayload: SellAllocationDecisionPayload = {
              sellExecutionId: best.id,
              allocations: (decision.payload as SellAllocationDecisionPayload).allocations,
            };
            await repos.rawTransactions.append(
              createRawTransaction({ kind: "SellAllocationDecision", source: "manual", portfolioId: decision.portfolioId, ticker: decision.ticker, payload: replacementPayload })
            );
          }
        }
        convergedCount += 1;
      }
    }
  }

  // Repair data produced before Buy-side re-pointing existed: the duplicate
  // Buy may already be retracted, leaving no live duplicate pair for the loop
  // above to visit, while old decisions still point at that dead lot id.
  const repairSnapshot = await repos.rawTransactions.getAll();
  const liveBuys = repairSnapshot.filter(
    (transaction): transaction is RawTransaction & { payload: BuyExecutionPayload } =>
      transaction.kind === "BuyExecution" && !isRetracted(repairSnapshot, transaction.id),
  );
  const danglingDecisions = repairSnapshot.filter(
    (transaction) => transaction.kind === "SellAllocationDecision" && !isRetracted(repairSnapshot, transaction.id),
  );
  for (const decision of danglingDecisions) {
    const payload = decision.payload as SellAllocationDecisionPayload;
    let changed = false;
    const repairedAllocations = payload.allocations.map((allocation) => {
      const referenced = repairSnapshot.find((transaction) => transaction.id === allocation.lotRef);
      if (!referenced || referenced.kind !== "BuyExecution" || !isRetracted(repairSnapshot, referenced.id)) return allocation;
      const oldBuy = referenced.payload as BuyExecutionPayload;
      const replacement = liveBuys
        .filter((candidate) => {
          const buy = candidate.payload;
          return (
            normalizeTicker(buy.ticker) === normalizeTicker(oldBuy.ticker) &&
            buy.executionDate === oldBuy.executionDate &&
            buy.shares === oldBuy.shares &&
            buy.price === oldBuy.price &&
            !timesConflict(buy.executionTime, oldBuy.executionTime)
          );
        })
        .sort((a, b) => authorityRank(b.source) - authorityRank(a.source))[0];
      if (!replacement) return allocation;
      changed = true;
      return { ...allocation, lotRef: replacement.id };
    });
    if (!changed) continue;
    await repos.rawTransactions.append(
      createRawTransaction({
        kind: "Retraction",
        source: "manual",
        payload: { targetId: decision.id, reason: "Repair: allocation referenced a BuyExecution superseded by higher-authority evidence." },
      }),
    );
    await repos.rawTransactions.append(
      createRawTransaction({
        kind: "SellAllocationDecision",
        source: "manual",
        portfolioId: decision.portfolioId,
        ticker: decision.ticker,
        payload: { sellExecutionId: payload.sellExecutionId, allocations: repairedAllocations },
      }),
    );
    convergedCount += 1;
  }

  return convergedCount;
}

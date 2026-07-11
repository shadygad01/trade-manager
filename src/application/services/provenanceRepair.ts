import {
  createRawTransaction,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
  type RawTransactionSource,
} from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { appendAndMaybeCommit, retractRawTransaction, type CommitEngineRepos } from "./commitEngine";
import { isRetracted, resolveCurrentTicker, findUnclaimedSellExecutionFact } from "./rawTransactionFolds";

/**
 * One-time repair for data already written before ensureSellFacts
 * (TradeService.ts) was fixed to adopt an already-existing, correctly-
 * sourced SellExecution fact instead of always minting a fresh one with
 * source "manual". That code fix only changes what happens on a FUTURE
 * `recordSell` call — it cannot retroactively repair a sell the OLD code
 * already recorded, which left two live facts for the same real sell: the
 * correctly-sourced one (e.g. "official-broker-excel", written at
 * extraction time) sitting orphaned and unclaimed forever, and a
 * wrongly-"manual"-sourced one that the ledger's own SellAllocationDecision
 * actually references. `isTickerFullyOfficialBrokerExcelSourced` checks
 * EVERY live fact for a ticker, so the orphaned correct twin existing
 * alongside the wrong one doesn't help — the ticker stays broken until this
 * runs once.
 *
 * Dry-run first, same convention as ledgerRebuild.ts: a report always comes
 * before any write, and Apply only ever acts on findings the caller passed
 * back (never a hidden full-database sweep at write time).
 *
 * The repair: retract the wrongly-sourced SellExecution fact and its
 * now-stale SellAllocationDecision, then write a replacement decision with
 * the EXACT SAME lot allocations pointing at the correctly-sourced fact
 * instead. Which lots were closed and how many shares never changes — only
 * which SellExecution fact the ledger resolves the sell to.
 *
 * Deliberately narrow: only ever repairs a decision whose CURRENTLY
 * referenced fact has `source: "manual"` (the exact, known value the old
 * bug always wrote, never anything else) and where a different, unclaimed,
 * non-"manual"-sourced twin exists for the identical value. This can never
 * touch a genuinely manual sell (Lot Manager, hand-typed) unless one
 * happens to have an unclaimed, differently-sourced twin of the exact same
 * value sitting around — which only happens when the same real execution
 * really was also recorded from an authoritative document, i.e. exactly the
 * case this repair exists to fix.
 */

export interface ProvenanceRepairFinding {
  ticker: string;
  portfolioId?: string;
  decisionId: string;
  decisionAllocations: SellAllocationDecisionPayload["allocations"];
  wrongFactId: string;
  wrongSource: RawTransactionSource;
  correctFactId: string;
  correctSource: RawTransactionSource;
  executionDate: string;
  shares: number;
  price: number;
}

export interface ProvenanceRepairReport {
  findings: ProvenanceRepairFinding[];
}

export async function dryRunProvenanceRepair(repos: CommitEngineRepos): Promise<ProvenanceRepairReport> {
  const all = await repos.rawTransactions.getAll();
  const findings: ProvenanceRepairFinding[] = [];

  const liveDecisions = all.filter((t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id));
  for (const decision of liveDecisions) {
    const decisionPayload = decision.payload as SellAllocationDecisionPayload;
    const currentFact = all.find((t) => t.id === decisionPayload.sellExecutionId && t.kind === "SellExecution");
    if (!currentFact || isRetracted(all, currentFact.id)) continue;
    if (currentFact.source !== "manual") continue; // not the old bug's exact, known signature
    const resolvedTicker = resolveCurrentTicker(all, currentFact);
    if (resolvedTicker === undefined) continue;

    // Resolved through any live Correction, not read from currentFact.ticker
    // directly — otherwise a wrongly-sourced fact written under a
    // since-corrected ticker name would search for its correct twin under
    // the OLD name, never finding it under the ticker it was renamed to.
    const ticker = normalizeTicker(resolvedTicker);
    const factPayload = currentFact.payload as SellExecutionPayload;

    // Excludes currentFact itself (already claimed by this very decision) —
    // only ever returns a DIFFERENT, still-unclaimed twin of the same value.
    const better = findUnclaimedSellExecutionFact(all, {
      ticker,
      executionDate: factPayload.executionDate,
      shares: factPayload.shares,
      price: factPayload.price,
    });
    if (!better || better.source === "manual") continue;

    findings.push({
      ticker,
      portfolioId: decision.portfolioId,
      decisionId: decision.id,
      decisionAllocations: decisionPayload.allocations,
      wrongFactId: currentFact.id,
      wrongSource: currentFact.source,
      correctFactId: better.id,
      correctSource: better.source,
      executionDate: factPayload.executionDate,
      shares: factPayload.shares,
      price: factPayload.price,
    });
  }

  return { findings };
}

export interface ProvenanceRepairResult {
  repaired: number;
  /** Findings skipped because the underlying facts changed since the dry-run report was generated (already retracted by something else) — never acted on blindly. */
  skipped: ProvenanceRepairFinding[];
}

export async function applyProvenanceRepair(
  repos: CommitEngineRepos,
  findings: ProvenanceRepairFinding[],
): Promise<ProvenanceRepairResult> {
  let repaired = 0;
  const skipped: ProvenanceRepairFinding[] = [];

  for (const finding of findings) {
    const all = await repos.rawTransactions.getAll();
    const stillLiveWrongFact = all.some((t) => t.id === finding.wrongFactId && !isRetracted(all, t.id));
    const stillLiveDecision = all.some((t) => t.id === finding.decisionId && !isRetracted(all, t.id));
    const correctFactStillUnclaimed = !all.some(
      (t) => t.kind === "SellAllocationDecision" && !isRetracted(all, t.id) && (t.payload as SellAllocationDecisionPayload).sellExecutionId === finding.correctFactId,
    );
    if (!stillLiveWrongFact || !stillLiveDecision || !correctFactStillUnclaimed) {
      skipped.push(finding);
      continue;
    }

    await retractRawTransaction(
      repos,
      finding.wrongFactId,
      "Provenance repair: superseded by the correctly-sourced fact already on file for this sell.",
    );
    await retractRawTransaction(
      repos,
      finding.decisionId,
      "Provenance repair: re-pointed at the correctly-sourced SellExecution fact.",
    );

    const replacementPayload: SellAllocationDecisionPayload = {
      sellExecutionId: finding.correctFactId,
      allocations: finding.decisionAllocations,
    };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({
        kind: "SellAllocationDecision",
        source: "manual",
        portfolioId: finding.portfolioId,
        ticker: finding.ticker,
        payload: replacementPayload,
      }),
    );
    repaired += 1;
  }

  return { repaired, skipped };
}

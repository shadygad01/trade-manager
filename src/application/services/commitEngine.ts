import type { RawTransactionRepository, CommittedLedgerRepository, DiagnosticsRecorder } from "@domain/repositories";
import type { Trade } from "@domain/entities/Trade";
import {
  createRawTransaction,
  type RawTransaction,
  type PortfolioAssignmentPayload,
  type CorrectionPayload,
  type RetractionPayload,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { generateId } from "@domain/value-objects/id";
import { verifyAll } from "./verificationEngine";
import { generateLedgerEvents } from "./ledgerEngine";
import { generateAllocations } from "./allocationEngine";
import { isRetracted, resolveCurrentTicker } from "./rawTransactionFolds";
import { ensureLegacyFactsExist, projectLegacyTicker, type LegacyLedgerRepos } from "./ledgerProjection";
import { canonicalKey } from "./ledgerRebuild";
import { authorityRank } from "./evidenceAuthority";
import { timesConflict } from "./duplicateDetection";

/**
 * Commit Engine: the only code path that ever writes to ledgerCache /
 * allocationsCache. There is no separate "rebuild" command — `commitTicker`
 * IS the rebuild, and it always runs in full: delete every cached row for
 * (portfolioId, ticker) and regenerate from scratch, never an incremental
 * patch. `shouldCommit` is the trigger condition a caller evaluates after
 * appending any RawTransaction that touches a ticker: commit only once
 * every Buy/Sell transaction for that ticker has reached a terminal
 * verdict (Verified or Rejected) — a "Needs Review" transaction blocks the
 * whole ticker's commit until it's resolved.
 *
 * Scope note: this reads the CURRENT raw-transaction set as-is except for
 * PortfolioAssignment (see resolveCurrentPortfolioId), a Correction's
 * `ticker` patch (see resolveCurrentTicker), and any Retraction (see
 * isRetracted) — those three are resolved/folded before a transaction is
 * ever considered relevant to a ticker's commit. Folding the REST of the
 * Correction vocabulary (date/price/fees/etc.) into "the current view of a
 * fact" is a later increment, not yet wired in here. Documented rather than
 * silently assumed correct.
 */

export interface CommitEngineRepos {
  rawTransactions: RawTransactionRepository;
  committedLedger: CommittedLedgerRepository;
}

/**
 * docs/DIAGNOSTICS_CENTER_SPEC.md Part 5.2 — `appendAndMaybeCommit` is the
 * single choke point every real execution-fact writer already routes
 * through, so it's also the single place a Writer Trace event is emitted
 * for a `rawTransactions` append (valueSource "reference" — see Part 2.3
 * §A: the row is already permanent and canonical the moment it's appended,
 * so nothing beyond its own `id` needs capturing). `WriterContext` is how
 * the TRUE originating caller (TradeService.ensureBuyFact, not
 * commitEngine.ts itself) stays attributable through this shared choke
 * point — every caller that wants accurate Writer Trace attribution passes
 * its own identity; a caller that passes neither `diagnostics` nor
 * `writerContext` behaves exactly as before this parameter existed.
 */
export interface WriterContext {
  writer: string;
  function: string;
  file: string;
  reason: string;
}

const NON_SUBJECT_KINDS = new Set(["PortfolioAssignment", "Correction", "Retraction"]);

/**
 * A raw transaction's own `portfolioId` field is set once, at write time,
 * and never changes (immutability) — a LATER portfolio assignment (e.g.
 * Import picking a portfolio for a ticker after the fact) is its own
 * separate PortfolioAssignment raw transaction referencing the original by
 * id, not an edit to it. This resolves "what portfolio does this
 * transaction currently belong to", folding in the latest (highest `seq`)
 * PortfolioAssignment targeting it, if any — falling back to the
 * transaction's own field when none exists.
 *
 * Exported so a caller upgrading which fact represents an execution (see
 * ImportPage.tsx's exact-duplicate auto-skip effect) can carry the OLD
 * fact's resolved portfolio over to the NEW one via `assignPortfolioToFact`
 * before retracting the old one — otherwise the surviving fact stays
 * unassigned, `relevantTradeTransactions` excludes it from the next commit,
 * and `projectLegacyTicker` deletes the ticker's real Trade row as "stale"
 * (a real, reproduced bug this export exists to let callers avoid).
 */
export function resolveCurrentPortfolioId(all: RawTransaction[], transaction: RawTransaction): string | undefined {
  const assignments = all.filter(
    (t) => t.kind === "PortfolioAssignment" && (t.payload as PortfolioAssignmentPayload).targetId === transaction.id
  );
  if (assignments.length === 0) return transaction.portfolioId;
  const latest = assignments.reduce((a, b) => (b.seq > a.seq ? b : a));
  return (latest.payload as PortfolioAssignmentPayload).portfolioId;
}

// resolveCurrentTicker moved to rawTransactionFolds.ts (a shared leaf module)
// so reconciliation.ts's isTickerFullyOfficialBrokerExcelSourced can fold
// through a ticker correction too, without this file depending on that one.

/** Exported for lotManager.ts, which needs the identical "what facts currently belong to this ticker" resolution (portfolio/ticker folds, retraction exclusion) but reads ALL of them regardless of import-verification verdict — a Lot Manager action is the user's own direct, deliberate statement, not an OCR read awaiting corroboration. */
export async function relevantTradeTransactions(repos: CommitEngineRepos, portfolioId: string, ticker: string) {
  const normalizedTicker = normalizeTicker(ticker);
  // Can't use getByPortfolio here: a transaction's OWN portfolioId field may
  // still be undefined even though it's now effectively assigned via a
  // PortfolioAssignment — resolution has to run over the full set. Bounded
  // by the same small-N assumption the rest of this system already accepts.
  const all = await repos.rawTransactions.getAll();
  return all.filter((t) => {
    if (NON_SUBJECT_KINDS.has(t.kind)) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== normalizedTicker) return false;
    return resolveCurrentPortfolioId(all, t) === portfolioId;
  });
}

/**
 * `commitTicker`/`shouldCommit` always verify the COMPLETE relevant
 * transaction set for a ticker together, as one batch — never an
 * incremental "just this new row" check against a prior baseline. So unlike
 * a caller that's verifying one new pending transaction against already-
 * settled history, there is no "shares already on the ledger before this
 * batch" here: the batch already covers everything. Reading the cache's
 * current holdings as that baseline would double-count (the cache reflects
 * a PRIOR commit computed from a subset of these same transactions), which
 * is exactly what caused a full-history wipe on re-commit before this was
 * fixed — caught by commitEngine.test.ts's re-commit test, not by review.
 */
const NO_EXISTING_POSITIONS: never[] = [];

export async function shouldCommit(repos: CommitEngineRepos, portfolioId: string, ticker: string): Promise<boolean> {
  const relevant = await relevantTradeTransactions(repos, portfolioId, ticker);
  if (!relevant.some((t) => t.kind === "BuyExecution" || t.kind === "SellExecution")) return false;

  // The FULL relevant set goes to verifyAll, not just Buy/Sell: the engine
  // itself only ever produces verdicts for Buy/Sell rows, but it reads
  // PositionVerificationCapture/OrderEvidenceCapture facts as corroboration
  // — without them here, a broker screenshot that reconciles a ticker
  // exactly could never terminal-ize its commit (Phase 9.8 fix; before it,
  // only closed-position/invoice/cross-verified paths ever fired here).
  const verdicts = verifyAll({ transactions: relevant, positions: NO_EXISTING_POSITIONS });
  return [...verdicts.values()].every((v) => v.verdict !== "Needs Review");
}

/** Verdict counts as one short string, e.g. "2 Verified, 1 Needs Review" — never the verdicts/evidence themselves (docs/DIAGNOSTICS_CENTER_SPEC.md Part 5.7/2.3: a decision record's inputSummary/outputSummary are counts and labels, never a copy of the business objects they summarize). */
function summarizeVerdicts(verdicts: Map<string, { verdict: string }>): string {
  const counts = new Map<string, number>();
  for (const v of verdicts.values()) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  if (counts.size === 0) return "no transactions to verify";
  return [...counts.entries()].map(([verdict, n]) => `${n} ${verdict}`).join(", ");
}

export async function commitTicker(
  repos: CommitEngineRepos & Partial<LegacyLedgerRepos>,
  portfolioId: string,
  ticker: string,
  diagnostics?: DiagnosticsRecorder
): Promise<void> {
  const normalizedTicker = normalizeTicker(ticker);
  const correlationId = generateId();

  // Phase 9.8: when the caller's repos bundle carries the legacy tables (the
  // app's real singleton always does; bare CommitEngineRepos test bundles
  // don't), the commit ALSO projects its output onto Trade/TradeAllocation —
  // the tables the UI reads — making the legacy ledger a derived view that
  // auto-corrects whenever better historical facts reach a terminal verdict.
  // Gap-backfill runs FIRST so any legacy row that predates its fact writer
  // gets a fact before projection could ever mistake it for stale data; if
  // that step fails, projection is skipped entirely (never run against a
  // possibly-incomplete fact set), while the cache commit proceeds as always.
  let projection: (CommitEngineRepos & LegacyLedgerRepos) | undefined =
    repos.trades !== undefined && repos.allocations !== undefined ? (repos as CommitEngineRepos & LegacyLedgerRepos) : undefined;
  if (projection) {
    try {
      await ensureLegacyFactsExist(projection, portfolioId, normalizedTicker);
    } catch (err) {
      console.error("ensureLegacyFactsExist failed — skipping legacy projection for this commit:", err);
      projection = undefined;
    }
  }

  // Converges any live facts of this ticker left duplicated by a writer
  // other than Import's own duplicateMatch/upgradeFact path — most notably
  // ensureLegacyFactsExist just above, which has no reconciliation step of
  // its own. Runs before verification reads the fact set, so a converged
  // ticker's Verification/Replay/Allocation decisions this same commit never
  // see the now-retracted loser. Never fatal, same isolation as
  // ensureLegacyFactsExist/projectLegacyTicker.
  try {
    await reconcileDuplicateAuthority(projection ?? repos, normalizedTicker);
  } catch (err) {
    console.error("reconcileDuplicateAuthority failed — continuing commit with facts as-is:", err);
  }

  const relevant = await relevantTradeTransactions(repos, portfolioId, normalizedTicker);
  const tradeTransactions = relevant.filter((t) => t.kind === "BuyExecution" || t.kind === "SellExecution");
  const decisionTransactions = relevant.filter((t) => t.kind === "SellAllocationDecision");

  // Full relevant set, same reason as shouldCommit: capture facts are
  // corroboration inputs; verdicts still only ever cover Buy/Sell rows.
  const verdicts = verifyAll({ transactions: relevant, positions: NO_EXISTING_POSITIONS });
  const verifiedTransactions = tradeTransactions.filter((t) => verdicts.get(t.id)?.verdict === "Verified");
  const factSeqCursor = relevant.reduce((max, t) => Math.max(max, t.seq), 0);

  diagnostics?.recordDecision({
    decisionType: "Verification",
    correlationId,
    portfolioId,
    ticker: normalizedTicker,
    reader: "commitEngine.ts",
    function: "commitTicker",
    decision: summarizeVerdicts(verdicts),
    inputSummary: `${relevant.length} relevant facts (${tradeTransactions.length} Buy/Sell)`,
    outputSummary: `${verdicts.size} verdicts: ${summarizeVerdicts(verdicts)}`,
    factSeqCursor,
  });

  const events = generateLedgerEvents(verifiedTransactions);

  diagnostics?.recordDecision({
    decisionType: "Replay",
    correlationId,
    portfolioId,
    ticker: normalizedTicker,
    reader: "commitEngine.ts",
    function: "commitTicker",
    decision: `${events.length} ledger events`,
    inputSummary: `${verifiedTransactions.length} verified Buy/Sell transactions`,
    outputSummary: `${events.filter((e) => e.type === "LotOpened").length} LotOpened, ${events.filter((e) => e.type === "SellRecorded").length} SellRecorded`,
    factSeqCursor,
  });

  const allocations = generateAllocations(events, decisionTransactions);

  diagnostics?.recordDecision({
    decisionType: "Allocation",
    correlationId,
    portfolioId,
    ticker: normalizedTicker,
    reader: "commitEngine.ts",
    function: "commitTicker",
    decision: `${allocations.length} allocations`,
    inputSummary: `${events.length} ledger events, ${decisionTransactions.length} allocation decisions`,
    outputSummary:
      allocations.length === 0 && decisionTransactions.length > 0
        ? "0 allocations produced from a nonzero number of decisions — at least one decision's referenced lot could not be resolved"
        : `${allocations.length} allocations produced`,
    factSeqCursor,
  });

  // Never fatal, same isolation as ensureLegacyFactsExist/projectLegacyTicker
  // just below: a real, reproduced bug under concurrent commits (many
  // tickers committing at once, or two commits for the same ticker firing
  // in close succession) is a transient Dexie write-contention error here
  // (bulkDelete/bulkAdd on ledgerCache/allocationsCache) — before this fix,
  // that error propagated all the way up through this function's own
  // caller (recordBuy/recordSell/retractRawTransaction/assignPortfolioToFact
  // etc., none of which catch it), silently aborting the CALLER's own
  // bookkeeping (e.g. recordSell never reaching its own addedKeys update,
  // permanently stranding a Sell row on "still pending") and skipping
  // projectLegacyTicker below entirely — even though events/allocations
  // were already computed and don't depend on this cache write succeeding.
  try {
    await repos.committedLedger.commitTicker({ portfolioId, ticker: normalizedTicker, events, allocations });
  } catch (err) {
    console.error("committedLedger.commitTicker failed (cache commit skipped, legacy projection still proceeds):", err);
  }

  // Projection only ever runs on a TERMINAL verdict set. commitTicker is
  // also force-called on Retraction/Correction regardless of shouldCommit
  // (to clear a stale cache), and in that path a still-Needs-Review fact
  // produces no lot — projecting then would delete a legitimate legacy row
  // merely because its corroboration hasn't arrived yet. An empty set is
  // terminal (everything retracted IS a settled state); an undecided one is
  // not.
  const terminal = [...verdicts.values()].every((v) => v.verdict !== "Needs Review");
  if (projection && terminal) {
    try {
      await projectLegacyTicker(projection, portfolioId, normalizedTicker, events, allocations);
    } catch (err) {
      console.error("projectLegacyTicker failed (cache commit already applied, legacy rows unchanged):", err);
    }
  }
}

/**
 * The reactive trigger: append a raw transaction, then commit its ticker if
 * that just made the whole ticker's verification state terminal. This is
 * the ONLY place a commit is ever triggered — no scheduled job, no manual
 * "rebuild" button, matching the Ledger rewrite's "no rebuild command"
 * rule. Every writer should call this instead of `rawTransactions.append`
 * directly once it's ready to participate in the new architecture.
 *
 * A PortfolioAssignment's own envelope carries no portfolioId/ticker (it
 * targets another row by id) — its trigger check has to look up what it
 * just assigned instead. Any other transaction with no portfolioId (e.g.
 * everything Import writes today, before an assignment exists) or no
 * ticker has nothing to commit yet: a correct, expected no-op, not a gap.
 */
export async function appendAndMaybeCommit(
  repos: CommitEngineRepos,
  transaction: Omit<RawTransaction, "seq">,
  diagnostics?: DiagnosticsRecorder,
  writerContext?: WriterContext,
  options?: { deferCommit?: boolean },
): Promise<RawTransaction> {
  const appended = await repos.rawTransactions.append(transaction);

  diagnostics?.recordWrite({
    writer: writerContext?.writer ?? "commitEngine.ts",
    function: writerContext?.function ?? "appendAndMaybeCommit",
    file: writerContext?.file ?? "src/application/services/commitEngine.ts",
    table: "rawTransactions",
    objectId: appended.id,
    valueSource: "reference",
    reason: writerContext?.reason ?? `Appended a ${appended.kind} fact`,
    portfolioId: appended.portfolioId,
    ticker: appended.ticker,
  });

  if (options?.deferCommit) return appended;

  if (appended.kind === "PortfolioAssignment") {
    const { targetId, portfolioId } = appended.payload as PortfolioAssignmentPayload;
    const target = await repos.rawTransactions.getById(targetId);
    if (target?.ticker !== undefined && (await shouldCommit(repos, portfolioId, target.ticker))) {
      await commitTicker(repos, portfolioId, target.ticker, diagnostics);
    }
  } else if (appended.kind === "Correction") {
    // A ticker correction moves its target between two tickers' relevant
    // sets — unlike the shouldCommit-gated branches below, both the ticker
    // it just left and the ticker it just joined must re-derive their cache
    // immediately (never left stale), regardless of whether every other
    // pending row on either ticker has reached a terminal verdict yet.
    const { targetId, patch } = appended.payload as CorrectionPayload;
    if (patch.ticker !== undefined) {
      const target = await repos.rawTransactions.getById(targetId);
      if (target) {
        const all = await repos.rawTransactions.getAll();
        const resolvedPortfolioId = resolveCurrentPortfolioId(all, target);
        if (resolvedPortfolioId !== undefined) {
          const priorTicker = resolveCurrentTicker(all, target, appended.id);
          const currentTicker = resolveCurrentTicker(all, target);
          const affectedTickers = new Set([priorTicker, currentTicker].filter((t): t is string => t !== undefined));
          for (const affectedTicker of affectedTickers) {
            await commitTicker(repos, resolvedPortfolioId, affectedTicker, diagnostics);
          }
        }
      }
    }
  } else if (appended.kind === "Retraction") {
    // Same reasoning as Correction above: a retraction must force its
    // ticker's cache to drop the retracted row right away, even if the rest
    // of the ticker's batch isn't otherwise terminal.
    const { targetId } = appended.payload as RetractionPayload;
    const target = await repos.rawTransactions.getById(targetId);
    if (target?.ticker !== undefined) {
      const all = await repos.rawTransactions.getAll();
      const resolvedPortfolioId = resolveCurrentPortfolioId(all, target);
      const resolvedTicker = resolveCurrentTicker(all, target);
      if (resolvedPortfolioId !== undefined && resolvedTicker !== undefined) {
        await commitTicker(repos, resolvedPortfolioId, resolvedTicker, diagnostics);
      }
    }
  } else if (appended.portfolioId !== undefined && appended.ticker !== undefined) {
    if (await shouldCommit(repos, appended.portfolioId, appended.ticker)) {
      await commitTicker(repos, appended.portfolioId, appended.ticker, diagnostics);
    }
  }
  return appended;
}

/**
 * Assigns every still-unassigned raw transaction for `ticker` to
 * `portfolioId` — one PortfolioAssignment fact per target, never a batch
 * edit, so each stays independently traceable. This is what Import's
 * existing per-ticker portfolio picker calls once the user resolves which
 * portfolio a ticker's extracted rows belong to; it's the only place a
 * freshly-imported (portfolioId-less) raw transaction ever gets one.
 */
export async function assignPortfolio(
  repos: CommitEngineRepos,
  ticker: string,
  portfolioId: string,
  diagnostics?: DiagnosticsRecorder,
  options?: { deferCommit?: boolean },
): Promise<void> {
  const normalizedTicker = normalizeTicker(ticker);
  const all = await repos.rawTransactions.getAll();
  const unassigned = all.filter((t) => {
    if (NON_SUBJECT_KINDS.has(t.kind)) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    if (resolvedTicker === undefined || normalizeTicker(resolvedTicker) !== normalizedTicker) return false;
    return resolveCurrentPortfolioId(all, t) === undefined;
  });

  for (const target of unassigned) {
    const payload: PortfolioAssignmentPayload = { targetId: target.id, portfolioId };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ kind: "PortfolioAssignment", source: "manual", payload }),
      diagnostics,
      { writer: "commitEngine.ts", function: "assignPortfolio", file: "src/application/services/commitEngine.ts", reason: "Assigned a still-unassigned fact to a portfolio (ticker-wide sweep)" },
      options,
    );
  }
}

/**
 * Assigns exactly ONE fact to `portfolioId` — the single-target counterpart
 * to `assignPortfolio`'s ticker-wide sweep, for a caller that just
 * adopted/created that one specific fact and has no business touching any
 * of its ticker's OTHER still-pending siblings.
 *
 * Real, reproduced bug this exists to fix: `ensureBuyFact`/`ensureSellFacts`
 * used to call the ticker-wide `assignPortfolio` here instead — harmless for
 * a ticker with a single Buy/Sell, but for a ticker with TWO OR MORE
 * still-pending Buys in the same commit batch (e.g. two Excel-sourced Buys
 * imported together), assigning the FIRST one's fact swept up the SECOND
 * one's still-unprocessed fact too (it looked "unassigned", same as any
 * genuine gap `assignPortfolio` exists to close) — which reactively fired
 * `appendAndMaybeCommit`'s own commit trigger for the second fact BEFORE its
 * own `recordBuy` call had run, materializing a legacy Trade for it straight
 * from the raw fact via `projectLegacyTicker`. That phantom Trade then raced
 * the second candidate's own, genuine `recordBuy` call moments later,
 * producing two Trade rows for one real execution, and the genuine
 * candidate's own RawTransaction fact got auto-skipped/retracted as an
 * apparent "exact duplicate" of the phantom — permanently losing its
 * official-broker-excel provenance the same shape as the single-Buy race
 * this same investigation found and fixed in `ImportPage.tsx`. Scoping the
 * assignment to exactly the fact just adopted/created closes this off at
 * the source: no other still-pending sibling is ever touched.
 */
export async function assignPortfolioToFact(
  repos: CommitEngineRepos,
  targetId: string,
  portfolioId: string,
  diagnostics?: DiagnosticsRecorder,
  options?: { deferCommit?: boolean },
): Promise<void> {
  const all = await repos.rawTransactions.getAll();
  const target = all.find((t) => t.id === targetId);
  if (!target || isRetracted(all, target.id) || resolveCurrentPortfolioId(all, target) !== undefined) return;
  const payload: PortfolioAssignmentPayload = { targetId, portfolioId };
  await appendAndMaybeCommit(
    repos,
    createRawTransaction({ kind: "PortfolioAssignment", source: "manual", payload }),
    diagnostics,
    { writer: "commitEngine.ts", function: "assignPortfolioToFact", file: "src/application/services/commitEngine.ts", reason: "Assigned exactly one adopted/created fact to a portfolio" },
    options,
  );
}

/**
 * Retracts one raw transaction — used when the pre-migration UI deletes or
 * voids a fact directly (e.g. TradeService.deleteTrade), so the new
 * architecture's next commit for that ticker can't resurrect something the
 * user just removed. `targetId` must be the RawTransaction's own id, not a
 * derived LedgerEvent id.
 */
export async function retractRawTransaction(
  repos: CommitEngineRepos,
  targetId: string,
  reason?: string,
  diagnostics?: DiagnosticsRecorder
): Promise<void> {
  const payload: RetractionPayload = { targetId, reason };
  await appendAndMaybeCommit(
    repos,
    createRawTransaction({ kind: "Retraction", source: "manual", payload }),
    diagnostics,
    { writer: "commitEngine.ts", function: "retractRawTransaction", file: "src/application/services/commitEngine.ts", reason: reason ?? "Retracted a raw transaction" }
  );
}

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
 * imports this file for `retractRawTransaction`/`appendAndMaybeCommit`).
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
        // Two compatible legacy trades means the facts still cannot be
        // tied to one business execution safely (including an unknown-time
        // backfill), so retain the conservative twin-lot behavior.
        if (compatibleTrades.length >= 2) continue;
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

        if (kind === "SellExecution") {
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

  return convergedCount;
}

/**
 * Corrects every still-live raw transaction currently resolving to
 * `oldTicker` (Buy/Sell executions, evidence, verifications, dividends —
 * anything ticker-bearing) over to `newTicker` — the raw-transaction twin of
 * TradeService.renameTickerEverywhere, so a ticker rename in the
 * pre-migration UI doesn't leave this architecture's copy permanently
 * orphaned under the old, now-corrected-away ticker.
 */
export async function renameRawTransactionsTicker(
  repos: CommitEngineRepos,
  oldTicker: string,
  newTicker: string,
  diagnostics?: DiagnosticsRecorder
): Promise<number> {
  const normalizedOld = normalizeTicker(oldTicker);
  const normalizedNew = normalizeTicker(newTicker);
  if (!normalizedNew || normalizedNew === normalizedOld) return 0;

  const all = await repos.rawTransactions.getAll();
  const targets = all.filter((t) => {
    if (t.ticker === undefined) return false;
    if (isRetracted(all, t.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, t);
    return resolvedTicker !== undefined && normalizeTicker(resolvedTicker) === normalizedOld;
  });

  for (const target of targets) {
    const payload: CorrectionPayload = { targetId: target.id, patch: { ticker: normalizedNew } };
    await appendAndMaybeCommit(
      repos,
      createRawTransaction({ kind: "Correction", source: "manual", payload }),
      diagnostics,
      { writer: "commitEngine.ts", function: "renameRawTransactionsTicker", file: "src/application/services/commitEngine.ts", reason: `Corrected ticker ${normalizedOld} -> ${normalizedNew}` }
    );
  }
  return targets.length;
}

import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { createPortfolio } from "@domain/entities/Portfolio";
import { generateId } from "@domain/value-objects/id";
import { recordBuy, recordSell, type RecordSellInput } from "@application/services/TradeService";
import { assignPortfolio, type CommitEngineRepos } from "@application/services/commitEngine";
import { runSerialized } from "@application/services/serialize";
import { dryRunLedgerRebuild } from "@application/services/ledgerRebuild";
import { recordImportedRawTransactions } from "@application/services/importRecording";
import { computeSystemSnapshot, type SnapshotRepos, type SystemSnapshot } from "@application/services/systemSnapshot";
import type { AppRepositories } from "@application/services/types";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

/**
 * The single, shared scenario both `determinism.e2e.test.ts` (which asserts
 * against it) and `scripts/regenerate-determinism-golden.ts` (which
 * regenerates the golden reference from it) run — kept in exactly one place
 * so the test can never silently drift from what actually produced the
 * committed golden file. Never import this from application-layer code:
 * it pulls in `@infrastructure/db` directly, which `application-no-infrastructure-or-presentation`
 * (.dependency-cruiser.cjs) structurally forbids — it lives in
 * `src/presentation/` for exactly that reason, same as `excelWorkflowEndToEnd.test.ts`.
 */

export const TICKER = "ABUK";
export const PORTFOLIO_ID = "det-test-portfolio";

interface CandidateBuy {
  shares: number;
  price: number;
  date: string;
  time: string;
}
interface CandidateSell {
  shares: number;
  price: number;
  date: string;
  time: string;
}

/**
 * ABUK-equivalent (3 Buys totaling 100 shares, 1 Sell of 73, net OPEN
 * remainder of 27) — the exact real-world shape this codebase's own
 * incident history (docs/ROADMAP.md) proved hardest to keep deterministic
 * (twin-lot/coarse-key bugs), making it the right shape to pin down here,
 * not an arbitrary choice. Reused from excelWorkflowEndToEnd.test.ts.
 */
export const BUYS: CandidateBuy[] = [
  { shares: 40, price: 40, date: "2026-01-01", time: "09:00AM" },
  { shares: 30, price: 40.5, date: "2026-01-05", time: "09:10AM" },
  { shares: 30, price: 41, date: "2026-01-10", time: "09:20AM" },
];
export const SELLS: CandidateSell[] = [{ shares: 73, price: 42, date: "2026-02-01", time: "10:30AM" }];

export function reposOn(db: PortfolioOsDatabase): AppRepositories & CommitEngineRepos & SnapshotRepos {
  const base = createRepositories(db);
  return { ...base, allocations: base.tradeAllocations } as unknown as AppRepositories & CommitEngineRepos & SnapshotRepos;
}

/** Stage 2 — Import Official Broker Excel. */
async function importOfficialExcel(repos: AppRepositories & CommitEngineRepos, buys: CandidateBuy[], sells: CandidateSell[]) {
  const uploadId = generateId();
  const candidates: ParsedTradeCandidate[] = [
    ...buys.map((b) => ({ ticker: TICKER, side: "BUY" as const, shares: b.shares, price: b.price, date: b.date, time: b.time, confidence: "high" as const, source: "official-broker-excel" as const })),
    ...sells.map((s) => ({ ticker: TICKER, side: "SELL" as const, shares: s.shares, price: s.price, date: s.date, time: s.time, confidence: "high" as const, source: "official-broker-excel" as const })),
  ];
  await repos.uploads.save({
    id: uploadId,
    fileName: `${TICKER}-orders.xlsx`,
    fileHash: `hash-${uploadId}`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    status: "parsed",
    candidates,
    createdAt: new Date().toISOString(),
    parsedAt: new Date().toISOString(),
  });
  await recordImportedRawTransactions(repos, {
    sourceUploadId: uploadId,
    candidates: candidates.map((c) => ({ key: generateId(), candidate: c })),
    verifications: [],
    dividends: [],
    orderEvidences: [],
    cancelledOrders: [],
  });
}

/** Stage 3 — Confirm. */
async function confirmBuys(repos: AppRepositories & CommitEngineRepos, buys: CandidateBuy[]) {
  const key = `${PORTFOLIO_ID}|${TICKER}`;
  await runSerialized(key, async () => {
    for (const b of buys) {
      await recordBuy(repos, { portfolioId: PORTFOLIO_ID, ticker: TICKER, shares: b.shares, entryPrice: b.price, executionDate: b.date, executionTime: b.time });
    }
    await assignPortfolio(repos, TICKER, PORTFOLIO_ID);
  });
}

/** Stage 4 — Smart Allocate. */
async function smartAllocateAllSells(repos: AppRepositories & CommitEngineRepos, sells: CandidateSell[]) {
  const key = `${PORTFOLIO_ID}|${TICKER}`;
  const allocateOne = async (s: CandidateSell) => {
    const allTrades = await repos.trades.getByPortfolio(PORTFOLIO_ID);
    const openLots = allTrades
      .filter((t) => t.ticker === TICKER && t.remainingShares > 0)
      .sort((a, b) => a.executionDate.localeCompare(b.executionDate));
    let remaining = s.shares;
    const lines: { tradeId: string; shares: number }[] = [];
    for (const lot of openLots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.remainingShares, remaining);
      if (take <= 0) continue;
      lines.push({ tradeId: lot.id, shares: take });
      remaining -= take;
    }
    if (remaining > 0) throw new Error(`Not enough open shares to Smart Allocate for ${TICKER}`);
    const input: RecordSellInput = {
      portfolioId: PORTFOLIO_ID,
      ticker: TICKER,
      allocations: lines.map((l) => ({ tradeId: l.tradeId, shares: l.shares, exitPrice: s.price })),
      executionDate: s.date,
      executionTime: s.time,
      source: "official-broker-excel",
    };
    await recordSell(repos, input);
  };
  await Promise.all(sells.map((s) => runSerialized(key, () => allocateOne(s))));
}

export interface DeterminismFlowResult {
  snapshot: SystemSnapshot;
  /** Non-zero would mean the scenario itself is inconsistent, not a determinism finding — callers should assert this is 0 before trusting `snapshot`. */
  rebuildIssueCount: number;
  hasTickerAfterRefresh: boolean;
}

/**
 * Runs the full Reset -> Import -> Confirm -> Smart Allocate -> Commit ->
 * Refresh -> Rebuild -> Restart -> Snapshot flow against a fresh, uniquely-
 * named real Dexie database.
 */
export async function runDeterminismFlow(dbNameSuffix: string): Promise<DeterminismFlowResult> {
  // Stage 1 — Reset: a brand-new database, never touched before.
  const dbName = `determinism-e2e-${dbNameSuffix}`;
  const db = new PortfolioOsDatabase(dbName);
  const repos = reposOn(db);
  await repos.portfolios.save(createPortfolio({ id: PORTFOLIO_ID, name: "Determinism Test Portfolio", kind: "Trading", initialCash: 10_000_000 }));

  // Stage 2 — Import Official Broker Excel.
  await importOfficialExcel(repos, BUYS, SELLS);

  // Stage 3 — Confirm.
  await confirmBuys(repos, BUYS);

  // Stage 4 — Smart Allocate.
  await smartAllocateAllSells(repos, SELLS);

  // Stage 5 — Commit: already happened reactively inside every write above
  // (appendAndMaybeCommit's own trigger — see commitEngine.ts).

  // Stage 6 — Refresh: re-read fresh from the same handle (no in-memory
  // state anywhere in this architecture survives a read — see
  // holdingsEngine.ts's own "no persistence, no cache" doc comment).
  const refreshedTrades = await repos.trades.getByPortfolio(PORTFOLIO_ID);
  const hasTickerAfterRefresh = refreshedTrades.some((t) => t.ticker === TICKER);

  // Stage 7 — Rebuild: the real "Data -> Rebuild Ledger" dry run.
  const rebuildReport = await dryRunLedgerRebuild(repos);
  const rebuildIssueCount = [
    ...rebuildReport.tradesToAdd.filter((e) => e.canonical.ticker === TICKER),
    ...rebuildReport.tradesToRemove.filter((e) => e.trade.ticker === TICKER),
    ...rebuildReport.tradesToModify.filter((e) => e.trade.ticker === TICKER),
    ...rebuildReport.sellsToAdd.filter((e) => e.canonical.ticker === TICKER),
    ...rebuildReport.sellsExtraneous.filter((e) => e.ticker === TICKER),
    ...rebuildReport.sellsModified.filter((e) => e.ticker === TICKER),
    ...rebuildReport.holdingsMismatches.filter((e) => e.ticker === TICKER),
  ].length;

  // Stage 8 — Restart: a brand-new database HANDLE for the SAME name — not
  // the same JS objects the write side held, so nothing in-memory can leak
  // into the snapshot; only genuinely persisted state.
  const restarted = reposOn(new PortfolioOsDatabase(dbName));

  // Stage 9 — Snapshot.
  const snapshot = await computeSystemSnapshot(restarted, PORTFOLIO_ID, [TICKER]);

  return { snapshot, rebuildIssueCount, hasTickerAfterRefresh };
}

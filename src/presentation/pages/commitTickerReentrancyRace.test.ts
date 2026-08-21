import { describe, it, expect, vi, afterEach } from "vitest";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { createRepositories } from "@infrastructure/db/repositories";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createTrade } from "@domain/entities/Trade";
import { commitTicker, type CommitEngineRepos } from "@application/services/commitEngine";
import { runSerialized } from "@application/services/serialize";
import type { LegacyLedgerRepos } from "@application/services/ledgerProjection";
import type { AppRepositories } from "@application/services/types";

/**
 * Real, reproduced bug (POUL, a real user's own Thndr "Your Orders" export,
 * driven through a real Chromium session against real IndexedDB): two
 * `commitTicker` calls for the SAME (portfolio, ticker), run concurrently
 * instead of serialized, each independently run
 * `ledgerProjection.ensureLegacyFactsExist`'s gap-backfill pass against the
 * same stale-at-the-time raw-transaction snapshot, compute the identical
 * missing fact (deterministic id, reused from the legacy Trade row it's
 * backfilling), and both attempt `rawTransactions.append` with that id.
 * Against a real Dexie database, the loser throws "Key already exists in
 * the object store" (a ConstraintError) — `commitTicker` catches it and
 * silently skips legacy projection for that call, which can leave the
 * ticker's legacy Trade/TradeAllocation rows stale (open) even though the
 * canonical fact log already nets to zero — the exact "closed position
 * still shows open" defect class this codebase has chased for multiple
 * sprints (see docs/ROADMAP.md).
 *
 * In the real app this reentrancy was reachable because ImportPage.tsx's
 * "auto-skip an exact ledger duplicate" effect fired an un-awaited
 * `retractRawTransaction` for an UNRELATED pending candidate the instant a
 * ticker's own commit landed its Trade write — `retractRawTransaction`'s
 * own reactive `commitTicker` call (via `commitEngine.appendAndMaybeCommit`'s
 * unconditional Retraction branch) was never routed through the SAME
 * per-(portfolio, ticker) `runSerialized` queue `commitTickerGroup` already
 * locks its own explicit commit behind — so the two calls could genuinely
 * overlap. Fixed by routing that effect's retraction (`ImportPage.tsx`'s
 * new `retractRawTransactionKeyForTicker`) through the identical
 * `runSerialized` key.
 *
 * This test isolates the underlying safety property those two call sites
 * both rely on, directly: two `commitTicker` calls for the same ticker,
 * unserialized, CAN corrupt each other; routed through the same
 * `runSerialized` key (exactly what the real fix does), they cannot. A
 * hand-rolled in-memory fake repository never enforces primary-key
 * uniqueness the way real IndexedDB does (`Map.set` silently overwrites),
 * so — like this codebase's other real-IndexedDB race regressions — this
 * test wires up a real Dexie database (fake-indexeddb) rather than the
 * usual plain-object test repos.
 */

function reposOn(db: PortfolioOsDatabase): AppRepositories & CommitEngineRepos & LegacyLedgerRepos {
  const base = createRepositories(db);
  return { ...base, allocations: base.tradeAllocations } as unknown as AppRepositories & CommitEngineRepos & LegacyLedgerRepos;
}

/** Seeds a legacy Trade with NO matching live RawTransaction fact at all — the classic pre-migration gap `ensureLegacyFactsExist` exists to backfill, guaranteed to make every fresh snapshot decide to append. */
async function seedBackfillGap(repos: AppRepositories & CommitEngineRepos & LegacyLedgerRepos, portfolioId: string, ticker: string) {
  await repos.portfolios.save(createPortfolio({ id: portfolioId, name: "Main", kind: "Trading", initialCash: 1_000_000 }));
  await repos.trades.save(
    createTrade({
      id: "trade-A",
      portfolioId,
      ticker,
      shares: 10,
      entryPrice: 40,
      fees: 0,
      taxes: 0,
      executionDate: "2026-01-01",
      executionTime: "09:00AM",
    }),
  );
}

describe("commitTicker reentrancy: two concurrent calls for the same (portfolio, ticker)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
  });

  it("unserialized: can throw a Dexie ConstraintError and skip legacy projection for the loser", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new PortfolioOsDatabase(`commit-reentrancy-unserialized-${Math.random()}`);
    const repos = reposOn(db);
    const portfolioId = "p1";
    const ticker = "POUL";
    await seedBackfillGap(repos, portfolioId, ticker);

    // No runSerialized here — the exact pre-fix shape: a fire-and-forget
    // reactive commit racing an explicit one for the same ticker.
    await Promise.all([commitTicker(repos, portfolioId, ticker), commitTicker(repos, portfolioId, ticker)]);

    const legacyProjectionSkipped = consoleErrorSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("ensureLegacyFactsExist failed")),
    );
    expect(legacyProjectionSkipped).toBe(true);
  });

  it("serialized through the same runSerialized key commitTickerGroup uses: never throws, legacy projection never skipped", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new PortfolioOsDatabase(`commit-reentrancy-serialized-${Math.random()}`);
    const repos = reposOn(db);
    const portfolioId = "p1";
    const ticker = "POUL";
    await seedBackfillGap(repos, portfolioId, ticker);

    const key = `${portfolioId}|${ticker}`;
    // The fixed shape: both calls queue behind the identical
    // per-(portfolio, ticker) key instead of running concurrently.
    await Promise.all([
      runSerialized(key, () => commitTicker(repos, portfolioId, ticker)),
      runSerialized(key, () => commitTicker(repos, portfolioId, ticker)),
    ]);

    const legacyProjectionSkipped = consoleErrorSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("ensureLegacyFactsExist failed")),
    );
    expect(legacyProjectionSkipped).toBe(false);

    const trades = await repos.trades.getByPortfolio(portfolioId);
    const pouTrades = trades.filter((t) => t.ticker === ticker);
    expect(pouTrades).toHaveLength(1);
    expect(pouTrades[0].remainingShares).toBe(10);
  });
});

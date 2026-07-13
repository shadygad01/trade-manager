import { db as defaultDb, type PortfolioOsDatabase } from "./db";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { Money } from "@domain/value-objects/Money";

/**
 * Hard factory-reset operations, deliberately NOT part of any domain
 * repository interface: the RawTransaction log is append-only by design
 * (corrections/retractions, never physical deletes), and these two
 * functions are the single sanctioned exception — a user-initiated "start
 * over" that erases history outright rather than folding it. They operate
 * on the Dexie database directly, as storage-level maintenance, so the
 * append-only contract every application service codes against stays intact.
 */

/**
 * Exported (only) so `purge.test.ts` can assert this list never silently
 * drifts from the live Dexie schema — see that test's own doc comment. A
 * table added to db.ts's schema and forgotten here previously shipped as a
 * real bug (`pendingExecutions` was missing for a time, leaving orphaned
 * rows behind after a "Reset" — see docs/ROADMAP.md's "Reset All Data
 * audit" entry). No other file should import this — every other caller
 * goes through purgeTickerData/purgeAllData.
 *
 * Deliberately EXCLUDES `diagnosticEvents`/`diagnosticCases`
 * (docs/DIAGNOSTICS_CENTER_SPEC.md Part 3.1) — "Reset" is itself a recorded
 * workflow step, and the whole point of the Diagnostics Center is to
 * survive as a record of what led up to and including a Reset, not be
 * erased by the very action it's recording. `purge.test.ts` checks this
 * exclusion is intentional, not drift, the same way it checks every other
 * table's inclusion is intentional.
 */
export const allTables = (db: PortfolioOsDatabase) => [
  db.portfolios,
  db.trades,
  db.tradeAllocations,
  db.timelineEvents,
  db.journalEntries,
  db.verifications,
  db.uploads,
  db.rawTransactions,
  db.ledgerCache,
  db.allocationsCache,
  db.pendingExecutions,
];

/**
 * Erases every record of one ticker — trades, allocations, timeline events,
 * journal entries, verifications, raw transactions (including the
 * retraction/correction rows that pointed at them), ledger caches, pending
 * (unconfirmed partial-fill) executions, and any upload whose candidates
 * carried the ticker (so re-uploading the same file isn't blocked by its
 * hash) — leaving the app looking like the ticker was never imported. Each
 * portfolio's cash is adjusted by reversing the ticker's net timeline cash
 * impact (buys are negative amounts, sells/dividends positive), so balances
 * also read as if it never traded.
 */
export async function purgeTickerData(tickerRaw: string, db: PortfolioOsDatabase = defaultDb): Promise<void> {
  const ticker = normalizeTicker(tickerRaw);
  const matchesTicker = (value: string | undefined) => value !== undefined && normalizeTicker(value) === ticker;

  await db.transaction("rw", allTables(db), async () => {
    const trades = (await db.trades.toArray()).filter((t) => matchesTicker(t.ticker));
    const tradeIds = new Set(trades.map((t) => t.id));
    const timelineEvents = (await db.timelineEvents.toArray()).filter((e) => matchesTicker(e.ticker));

    const cashDeltas = new Map<string, Money>();
    for (const event of timelineEvents) {
      if (event.amount === undefined) continue;
      cashDeltas.set(event.portfolioId, (cashDeltas.get(event.portfolioId) ?? Money.zero()).add(Money.from(event.amount)));
    }
    for (const [portfolioId, delta] of cashDeltas) {
      const portfolio = await db.portfolios.get(portfolioId);
      if (portfolio) {
        await db.portfolios.put({ ...portfolio, cash: Money.from(portfolio.cash).subtract(delta).toNumber() });
      }
    }

    const allocationIds = (await db.tradeAllocations.toArray()).filter((a) => matchesTicker(a.ticker)).map((a) => a.id);
    const journalIds = (await db.journalEntries.toArray()).filter((j) => tradeIds.has(j.tradeId)).map((j) => j.id);
    const verificationIds = (await db.verifications.toArray()).filter((v) => matchesTicker(v.ticker)).map((v) => v.id);
    const uploadIds = (await db.uploads.toArray())
      .filter((u) => u.candidates.some((c) => matchesTicker(c.ticker)))
      .map((u) => u.id);

    const allRaw = await db.rawTransactions.toArray();
    const purgedRawIds = new Set(allRaw.filter((r) => matchesTicker(r.ticker)).map((r) => r.id));
    // Retractions/corrections carry no ticker of their own — follow
    // targetId/supersedes chains to a fixpoint so none survive as orphans
    // pointing at facts that no longer exist.
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of allRaw) {
        if (purgedRawIds.has(row.id)) continue;
        const targetId = (row.payload as { targetId?: string }).targetId;
        if ((targetId !== undefined && purgedRawIds.has(targetId)) || (row.supersedes !== undefined && purgedRawIds.has(row.supersedes))) {
          purgedRawIds.add(row.id);
          grew = true;
        }
      }
    }

    const ledgerRowIds = (await db.ledgerCache.toArray()).filter((r) => matchesTicker(r.ticker)).map((r) => r.id);
    const allocationRowIds = (await db.allocationsCache.toArray()).filter((r) => matchesTicker(r.ticker)).map((r) => r.id);
    const pendingExecutionIds = (await db.pendingExecutions.toArray()).filter((p) => matchesTicker(p.ticker)).map((p) => p.id);

    await Promise.all([
      db.trades.bulkDelete([...tradeIds]),
      db.tradeAllocations.bulkDelete(allocationIds),
      db.timelineEvents.bulkDelete(timelineEvents.map((e) => e.id)),
      db.journalEntries.bulkDelete(journalIds),
      db.verifications.bulkDelete(verificationIds),
      db.uploads.bulkDelete(uploadIds),
      db.rawTransactions.bulkDelete([...purgedRawIds]),
      db.ledgerCache.bulkDelete(ledgerRowIds),
      db.allocationsCache.bulkDelete(allocationRowIds),
      db.pendingExecutions.bulkDelete(pendingExecutionIds),
    ]);
  });
}

/** Erases everything in every table — portfolios included. The app afterwards is indistinguishable from a fresh install. */
export async function purgeAllData(db: PortfolioOsDatabase = defaultDb): Promise<void> {
  await db.transaction("rw", allTables(db), async () => {
    await Promise.all(allTables(db).map((table) => table.clear()));
  });
}

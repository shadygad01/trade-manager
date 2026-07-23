import {
  createRawTransaction,
  type RawTransaction,
  type BuyExecutionPayload,
  type SellExecutionPayload,
  type SellAllocationDecisionPayload,
} from "@domain/entities/RawTransaction";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { generateId } from "@domain/value-objects/id";
import { isRetracted, resolveCurrentTicker } from "./rawTransactionFolds";
import { canonicalKey } from "./ledgerRebuild";
import { parseTimeToMinutes } from "./duplicateDetection";
import { type CommitEngineRepos, resolveCurrentPortfolioId } from "./commitEngine";

/**
 * Every write below goes straight to `repos.rawTransactions.append` — never
 * `retractRawTransaction`/`appendAndMaybeCommit` — because these functions
 * run INSIDE `commitTicker` (see commitEngine.ts's own `commitTicker`,
 * `options.repairOfficialBrokerAllocations` branch), and
 * `appendAndMaybeCommit` reactively re-triggers `commitTicker` on every
 * append. A recursive re-entrant commit here would interleave with the
 * outer call's own projection run.
 */
function executionOrder(
  a: RawTransaction & { payload: BuyExecutionPayload | SellExecutionPayload },
  b: RawTransaction & { payload: BuyExecutionPayload | SellExecutionPayload },
): number {
  const ap = a.payload;
  const bp = b.payload;
  const byDate = ap.executionDate.localeCompare(bp.executionDate);
  if (byDate !== 0) return byDate;
  const aMinutes = parseTimeToMinutes(ap.executionTime ?? "") ?? 0;
  const bMinutes = parseTimeToMinutes(bp.executionTime ?? "") ?? 0;
  return aMinutes - bMinutes || a.seq - b.seq;
}

function buyKey(ticker: string, payload: BuyExecutionPayload): string {
  return canonicalKey({
    side: "BUY",
    ticker,
    date: payload.executionDate,
    shares: payload.shares,
    price: payload.price,
  });
}

function sellKey(ticker: string, payload: SellExecutionPayload): string {
  return canonicalKey({
    side: "SELL",
    ticker,
    date: payload.executionDate,
    shares: payload.shares,
    price: payload.price,
  });
}

function lotWasOpenBeforeSell(buy: BuyExecutionPayload, sell: SellExecutionPayload): boolean {
  if (buy.executionDate !== sell.executionDate) return buy.executionDate < sell.executionDate;
  const buyMinutes = parseTimeToMinutes(buy.executionTime ?? "");
  const sellMinutes = parseTimeToMinutes(sell.executionTime ?? "");
  return buyMinutes === undefined || sellMinutes === undefined || buyMinutes <= sellMinutes;
}

/**
 * The broker workbook is authoritative for each execution it contains.
 * Older clients can also represent that same execution as a derived
 * legacy/backfill fact. The generic reconciler deliberately preserves
 * ambiguous twin lots, but retaining a lower-authority copy beside an
 * official fact counts one real execution twice.
 *
 * Only lower-authority facts with a matching official canonical execution
 * are retracted. Unmatched backfills remain live, preserving genuine opening
 * inventory from before the workbook's date range.
 */
export async function findOfficialBrokerDuplicateIds(
  repos: CommitEngineRepos,
  portfolioId: string,
  ticker: string,
): Promise<string[]> {
  const normalized = normalizeTicker(ticker);
  const all = await repos.rawTransactions.getAll();
  const liveHere = all.filter((transaction) => {
    if (transaction.kind !== "BuyExecution" && transaction.kind !== "SellExecution") return false;
    if (isRetracted(all, transaction.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, transaction);
    return (
      resolvedTicker !== undefined &&
      normalizeTicker(resolvedTicker) === normalized &&
      resolveCurrentPortfolioId(all, transaction) === portfolioId
    );
  }) as (RawTransaction & { payload: BuyExecutionPayload | SellExecutionPayload })[];

  // Legacy projection facts can represent a partial remainder or an
  // aggregate allocation, so both their share count and price can differ
  // from the authoritative execution rows. The broker workbook enumerates
  // every fill for that side/ticker/day; therefore a lower-authority fact on
  // the same side/day is derived overlap, while unmatched earlier dates
  // remain available as genuine opening inventory.
  const keyFor = (transaction: (typeof liveHere)[number]) => {
    const payload = transaction.payload as BuyExecutionPayload | SellExecutionPayload;
    return `${transaction.kind}|${normalized}|${payload.executionDate}`;
  };
  const officialKeys = new Set(
    liveHere
      .filter((transaction) => transaction.source === "official-broker-excel")
      .map(keyFor),
  );

  return liveHere
    .filter(
      (transaction) =>
        transaction.source !== "official-broker-excel" && officialKeys.has(keyFor(transaction)),
    )
    .map((transaction) => transaction.id);
}

export async function retractOfficialBrokerDuplicates(
  repos: CommitEngineRepos,
  duplicateIds: string[],
): Promise<number> {
  for (const targetId of duplicateIds) {
    await repos.rawTransactions.append(
      createRawTransaction({
        kind: "Retraction",
        source: "manual",
        payload: {
          targetId,
          reason: "Repair: official broker execution supersedes its derived legacy/backfill duplicate.",
        },
      }),
    );
  }
  return duplicateIds.length;
}

export async function convergeOfficialBrokerAuthority(
  repos: CommitEngineRepos,
  portfolioId: string,
  ticker: string,
): Promise<number> {
  return retractOfficialBrokerDuplicates(
    repos,
    await findOfficialBrokerDuplicateIds(repos, portfolioId, ticker),
  );
}

/**
 * Rebuilds the allocation decisions for official broker Excel sells using
 * the same strict-FIFO policy Import uses. This is deliberately narrow:
 * non-broker sells keep their explicit user decisions untouched. The repair
 * makes the immutable fact log self-healing when an older client marked an
 * Import row complete even though its SellAllocationDecision write failed,
 * or when a later provenance cleanup left that decision orphaned.
 */
export async function repairOfficialBrokerSellAllocations(
  repos: CommitEngineRepos,
  portfolioId: string,
  ticker: string,
  excludedFactIds: ReadonlySet<string> = new Set(),
): Promise<number> {
  const normalized = normalizeTicker(ticker);
  const all = await repos.rawTransactions.getAll();
  const belongsHere = (transaction: RawTransaction) => {
    if (excludedFactIds.has(transaction.id)) return false;
    if (isRetracted(all, transaction.id)) return false;
    const resolvedTicker = resolveCurrentTicker(all, transaction);
    return (
      resolvedTicker !== undefined &&
      normalizeTicker(resolvedTicker) === normalized &&
      resolveCurrentPortfolioId(all, transaction) === portfolioId
    );
  };

  const buys = all
    .filter(
      (transaction): transaction is RawTransaction & { payload: BuyExecutionPayload } =>
        transaction.kind === "BuyExecution" && belongsHere(transaction),
    )
    .sort(executionOrder);
  const sells = all
    .filter(
      (transaction): transaction is RawTransaction & { payload: SellExecutionPayload } =>
        transaction.kind === "SellExecution" && belongsHere(transaction),
    )
    .sort(executionOrder);
  if (!sells.some((sell) => sell.source === "official-broker-excel")) return 0;

  const decisions = all.filter(
    (transaction): transaction is RawTransaction & { payload: SellAllocationDecisionPayload } =>
      transaction.kind === "SellAllocationDecision" && belongsHere(transaction),
  );
  const buyByRef = new Map<string, (typeof buys)[number]>();
  for (const buy of buys) {
    buyByRef.set(buy.id, buy);
    const key = buyKey(normalized, buy.payload);
    if (!buyByRef.has(key)) buyByRef.set(key, buy);
  }
  const sellByRef = new Map<string, (typeof sells)[number]>();
  for (const sell of sells) {
    sellByRef.set(sell.id, sell);
    const key = sellKey(normalized, sell.payload);
    if (!sellByRef.has(key)) sellByRef.set(key, sell);
  }
  const decisionsBySell = new Map<string, (typeof decisions)[number][]>();
  for (const decision of decisions) {
    const sell = sellByRef.get(decision.payload.sellExecutionId);
    if (!sell) continue;
    const list = decisionsBySell.get(sell.id) ?? [];
    list.push(decision);
    decisionsBySell.set(sell.id, list);
  }

  const remainingByBuy = new Map(buys.map((buy) => [buy.id, buy.payload.shares]));
  const planned: {
    existing: (typeof decisions)[number][];
    sell: (typeof sells)[number];
    desired: SellAllocationDecisionPayload["allocations"];
  }[] = [];

  for (const sell of sells) {
    const existing = decisionsBySell.get(sell.id) ?? [];
    if (sell.source !== "official-broker-excel") {
      for (const decision of existing) {
        for (const allocation of decision.payload.allocations) {
          const buy = buyByRef.get(allocation.lotRef);
          if (!buy) continue;
          const remaining = remainingByBuy.get(buy.id) ?? 0;
          if (allocation.shares <= remaining) {
            remainingByBuy.set(buy.id, remaining - allocation.shares);
          }
        }
      }
      continue;
    }

    let remainingToAllocate = sell.payload.shares;
    const desired: SellAllocationDecisionPayload["allocations"] = [];
    for (const buy of buys) {
      if (remainingToAllocate <= 0) break;
      if (!lotWasOpenBeforeSell(buy.payload, sell.payload)) continue;
      const available = remainingByBuy.get(buy.id) ?? 0;
      if (available <= 0) continue;
      const shares = Math.min(available, remainingToAllocate);
      desired.push({ lotRef: buy.id, shares });
      remainingByBuy.set(buy.id, available - shares);
      remainingToAllocate -= shares;
    }
    // The repair is atomic per ticker. A previous implementation wrote the
    // decisions for early sells before discovering a later over-sell; that
    // left EGAS/EHDR half-repaired and opened phantom positions. If any sell
    // cannot be rebuilt, write nothing for this ticker.
    if (remainingToAllocate > 0) {
      return -1;
    }

    const existingNormalized = existing.flatMap((decision) =>
      decision.payload.allocations.flatMap((allocation) => {
        const buy = buyByRef.get(allocation.lotRef);
        return buy ? [{ lotRef: buy.id, shares: allocation.shares }] : [];
      }),
    );
    const alreadyCorrect =
      existing.length === 1 &&
      existingNormalized.length === desired.length &&
      existingNormalized.every(
        (allocation, index) =>
          allocation.lotRef === desired[index].lotRef && allocation.shares === desired[index].shares,
      );
    if (alreadyCorrect) continue;
    planned.push({ existing, sell, desired });
  }

  for (const change of planned) {
    for (const decision of change.existing) {
      await repos.rawTransactions.append(
        createRawTransaction({
          kind: "Retraction",
          source: "manual",
          payload: {
            targetId: decision.id,
            reason: "Repair: rebuilt official broker sell allocation from authoritative execution history.",
          },
        }),
      );
    }
    if (change.desired.length > 0) {
      await repos.rawTransactions.append(
        createRawTransaction({
          id: `${generateId()}|broker-allocation-repair`,
          kind: "SellAllocationDecision",
          source: "manual",
          portfolioId,
          ticker: normalized,
          payload: { sellExecutionId: change.sell.id, allocations: change.desired },
        }),
      );
    }
  }

  return planned.length;
}

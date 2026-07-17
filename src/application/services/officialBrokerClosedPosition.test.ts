import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import { createRawTransaction, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import {
  createFakeCommittedLedgerRepository,
  createFakeRawTransactionRepository,
  createFakeRepositories,
} from "@application/testUtils/fakeRepositories";
import { recordImportedRawTransactions } from "./importRecording";
import { assignPortfolio, commitTicker, type CommitEngineRepos } from "./commitEngine";
import { recordBuyBatch, recordSell } from "./TradeService";
import type { AppRepositories } from "./types";
import { isRetracted } from "./rawTransactionFolds";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

const portfolioId = "portfolio-elka";
const ticker = "ELKA";

function candidate(
  side: "BUY" | "SELL",
  shares: number,
  price: number,
  date: string,
  time: string,
): ParsedTradeCandidate {
  return { ticker, side, shares, price, date, time, confidence: "high", source: "official-broker-excel" };
}

const candidates = [
  candidate("SELL", 1500, 1.16, "2022-10-30", "10:00AM"),
  candidate("SELL", 1864, 1.16, "2022-10-27", "11:56AM"),
  candidate("SELL", 500, 1.17, "2022-10-27", "11:17AM"),
  candidate("SELL", 2500, 1.2, "2022-10-27", "11:13AM"),
  candidate("BUY", 1500, 1.11, "2022-10-26", "11:22AM"),
  candidate("BUY", 900, 1.11, "2022-10-25", "11:06AM"),
  candidate("BUY", 500, 1.12, "2022-10-20", "2:02PM"),
  candidate("BUY", 500, 1.12, "2022-10-20", "2:01PM"),
  candidate("BUY", 900, 1.13, "2022-10-18", "12:22PM"),
  candidate("BUY", 145, 1.15, "2022-10-16", "1:43PM"),
  candidate("BUY", 200, 1.15, "2022-10-16", "1:42PM"),
  candidate("BUY", 250, 1.16, "2022-10-16", "1:03PM"),
  candidate("BUY", 270, 1.16, "2022-10-16", "11:54AM"),
  candidate("BUY", 199, 1.16, "2022-10-16", "10:49AM"),
  candidate("BUY", 1000, 1.18, "2022-10-16", "10:03AM"),
];

describe("official broker closed-position import", () => {
  const originalTrackingStart = getTrackingStartDate();
  beforeAll(() => setTrackingStartDate("2020-01-01"));
  afterAll(() => setTrackingStartDate(originalTrackingStart));

  it("replays ELKA's 6,364 buys and 6,364 FIFO sells to zero open shares", async () => {
    const base = createFakeRepositories({
      portfolios: [createPortfolio({ id: portfolioId, name: "Old School", kind: "Investment", initialCash: 100_000 })],
    });
    const repos = {
      ...base,
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    } as AppRepositories & CommitEngineRepos;
    const entries = candidates.map((item, index) => ({ key: `elka-${index}`, candidate: item }));

    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-elka",
      candidates: entries,
      verifications: [],
      dividends: [],
      orderEvidences: [],
      cancelledOrders: [],
    });

    const buys = candidates.filter((item) => item.side === "BUY");
    await recordBuyBatch(
      repos,
      buys.map((item) => ({
        portfolioId,
        ticker,
        shares: item.shares,
        entryPrice: item.price,
        executionDate: item.date,
        executionTime: item.time!,
        source: item.source,
        deferCommit: true,
      })),
    );
    await assignPortfolio(repos, ticker, portfolioId, undefined, { deferCommit: true });

    const sells = candidates
      .filter((item) => item.side === "SELL")
      .sort((a, b) => a.date.localeCompare(b.date) || a.time!.localeCompare(b.time!));
    for (const sell of sells) {
      const lots = (await repos.trades.getByPortfolio(portfolioId))
        .filter((trade) => trade.ticker === ticker && trade.remainingShares > 0)
        .sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.executionTime.localeCompare(b.executionTime));
      let remaining = sell.shares;
      const allocations: { tradeId: string; shares: number; exitPrice: number }[] = [];
      for (const lot of lots) {
        if (remaining <= 0) break;
        const shares = Math.min(lot.remainingShares, remaining);
        allocations.push({ tradeId: lot.id, shares, exitPrice: sell.price });
        remaining -= shares;
      }
      expect(remaining).toBe(0);
      await recordSell(repos, {
        portfolioId,
        ticker,
        allocations,
        executionDate: sell.date,
        executionTime: sell.time!,
        source: sell.source,
        deferCommit: true,
      });
    }
    await commitTicker(repos, portfolioId, ticker, undefined, { repairOfficialBrokerAllocations: true });

    const trades = await repos.trades.getByPortfolio(portfolioId);
    expect(trades.reduce((sum, trade) => sum + trade.remainingShares, 0)).toBe(0);
    const all = await repos.rawTransactions.getAll();
    const liveDecisions = all.filter(
      (fact) => fact.kind === "SellAllocationDecision" && !isRetracted(all, fact.id),
    );
    expect(liveDecisions).toHaveLength(4);
    expect(
      liveDecisions.reduce(
        (sum, fact) =>
          sum +
          (fact.payload as SellAllocationDecisionPayload).allocations.reduce(
            (allocationSum, allocation) => allocationSum + allocation.shares,
            0,
          ),
        0,
      ),
    ).toBe(6364);
  });

  it("self-heals a completed import whose broker sells have no allocation decisions", async () => {
    const base = createFakeRepositories({
      portfolios: [createPortfolio({ id: portfolioId, name: "Old School", kind: "Investment", initialCash: 100_000 })],
    });
    const repos = {
      ...base,
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    } as AppRepositories & CommitEngineRepos;
    const entries = candidates.map((item, index) => ({ key: `missing-decision-${index}`, candidate: item }));
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-missing-decisions",
      candidates: entries,
      verifications: [],
      dividends: [],
      orderEvidences: [],
      cancelledOrders: [],
    });
    await assignPortfolio(repos, ticker, portfolioId, undefined, { deferCommit: true });

    await commitTicker(repos, portfolioId, ticker, undefined, { repairOfficialBrokerAllocations: true });

    const all = await repos.rawTransactions.getAll();
    const decisions = all.filter(
      (fact) => fact.kind === "SellAllocationDecision" && !isRetracted(all, fact.id),
    );
    expect(decisions).toHaveLength(4);
    expect(
      decisions.reduce(
        (sum, fact) =>
          sum +
          (fact.payload as SellAllocationDecisionPayload).allocations.reduce(
            (allocationSum, allocation) => allocationSum + allocation.shares,
            0,
          ),
        0,
      ),
    ).toBe(6364);
    const trades = await repos.trades.getByPortfolio(portfolioId);
    expect(trades.reduce((sum, trade) => sum + trade.remainingShares, 0)).toBe(0);

    const factCountAfterRepair = all.length;
    await commitTicker(repos, portfolioId, ticker, undefined, { repairOfficialBrokerAllocations: true });
    expect((await repos.rawTransactions.getAll()).length).toBe(factCountAfterRepair);
  });

  it("removes lower-authority legacy copies before repairing the official closed position", async () => {
    const base = createFakeRepositories({
      portfolios: [createPortfolio({ id: portfolioId, name: "Old School", kind: "Investment", initialCash: 100_000 })],
    });
    const repos = {
      ...base,
      rawTransactions: createFakeRawTransactionRepository(),
      committedLedger: createFakeCommittedLedgerRepository(),
    } as AppRepositories & CommitEngineRepos;
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-official-with-backfills",
      candidates: candidates.map((item, index) => ({ key: `official-${index}`, candidate: item })),
      verifications: [],
      dividends: [],
      orderEvidences: [],
      cancelledOrders: [],
    });
    await assignPortfolio(repos, ticker, portfolioId, undefined, { deferCommit: true });

    for (const [index, item] of candidates.entries()) {
      await repos.rawTransactions.append(
        createRawTransaction({
          id: `legacy-copy-${index}`,
          kind: item.side === "BUY" ? "BuyExecution" : "SellExecution",
          source: "backfill",
          portfolioId,
          ticker,
          payload: {
            ticker,
            shares: item.shares,
            price: item.price,
            executionDate: item.date,
            executionTime: item.time,
          },
        }),
      );
    }

    const result = await commitTicker(repos, portfolioId, ticker, undefined, {
      repairOfficialBrokerAllocations: true,
    });
    expect(result.officialBrokerDuplicatesRetracted).toBe(candidates.length);
    expect(result.officialBrokerAllocationsRepaired).toBe(4);
    expect(
      (await repos.trades.getByPortfolio(portfolioId)).reduce(
        (sum, trade) => sum + trade.remainingShares,
        0,
      ),
    ).toBe(0);

    const second = await commitTicker(repos, portfolioId, ticker, undefined, {
      repairOfficialBrokerAllocations: true,
    });
    expect(second).toEqual({
      officialBrokerDuplicatesRetracted: 0,
      officialBrokerAllocationsRepaired: 0,
    });
  });
});

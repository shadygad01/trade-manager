import { describe, expect, it } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createTrade } from "@domain/entities/Trade";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { computeCanonicalPositions } from "./canonicalHoldings";
import { findUnallocatedSellExecutions } from "./rawTransactionFolds";
import { compareLotsForSell } from "@presentation/pages/ImportPage";

function withSeq(...facts: Omit<RawTransaction, "seq">[]): RawTransaction[] {
  return facts.map((fact, index) => ({ ...fact, seq: index + 1 }));
}

describe("ESRS complex regression matrix", () => {
  it("treats a broker SETTLED sell as a live execution that still needs allocation", () => {
    const sell = createRawTransaction({
      id: "esrs-settled-sell",
      kind: "SellExecution",
      source: "official-broker-excel",
      portfolioId: "old-import",
      ticker: "ESRS",
      payload: {
        ticker: "ESRS",
        shares: 437,
        price: 24.32,
        executionDate: "2023-01-25",
        executionTime: "10:14AM",
        transactionNumber: "ESRS-SELL-437",
      },
    });
    expect(findUnallocatedSellExecutions(withSeq(sell), "ESRS").map((fact) => fact.id)).toEqual(["esrs-settled-sell"]);
  });

  it("does not mark a split sell as resolved until all allocation decisions cover the exact sell", () => {
    const sell = createRawTransaction({
      id: "esrs-sell-437",
      kind: "SellExecution",
      source: "official-broker-excel",
      portfolioId: "p1",
      ticker: "ESRS",
      payload: { ticker: "ESRS", shares: 437, price: 24.32, executionDate: "2023-01-25", executionTime: "10:14AM" },
    });
    const partA = createRawTransaction({
      id: "allocation-a",
      kind: "SellAllocationDecision",
      source: "manual",
      portfolioId: "p1",
      ticker: "ESRS",
      payload: { sellExecutionId: "esrs-sell-437", allocations: [{ lotRef: "lot-a", shares: 220 }] },
    });
    const partB = createRawTransaction({
      id: "allocation-b",
      kind: "SellAllocationDecision",
      source: "manual",
      portfolioId: "p1",
      ticker: "ESRS",
      payload: { sellExecutionId: "esrs-sell-437", allocations: [{ lotRef: "lot-b", shares: 217 }] },
    });
    expect(findUnallocatedSellExecutions(withSeq(sell, partA), "ESRS")).toHaveLength(1);
    expect(findUnallocatedSellExecutions(withSeq(sell, partA, partB), "ESRS")).toHaveLength(0);
  });

  it("resolves buy and sell facts through PortfolioAssignment from a legacy import portfolio", async () => {
    const portfolio = createPortfolio({ id: "p-old-school", name: "Old School", kind: "Investment", initialCash: 100_000 });
    const staleTrade = createTrade({ id: "stale-esrs", portfolioId: portfolio.id, ticker: "ESRS", shares: 370, entryPrice: 33.44, executionDate: "2023-01-16", executionTime: "10:00" });
    const base = createFakeRepositories({ portfolios: [portfolio], trades: [staleTrade] });
    const rawTransactions = createFakeRawTransactionRepository();
    const committedLedger = createFakeCommittedLedgerRepository();
    const repos = { ...base, rawTransactions, committedLedger };
    await rawTransactions.append(createRawTransaction({ id: "buy-old", kind: "BuyExecution", source: "official-broker-excel", portfolioId: "legacy-import", ticker: "ESRS", payload: { ticker: "ESRS", shares: 370, price: 33.44, executionDate: "2023-01-16", executionTime: "10:00" } }));
    await rawTransactions.append(createRawTransaction({ id: "sell-old", kind: "SellExecution", source: "official-broker-excel", portfolioId: "legacy-import", ticker: "ESRS", payload: { ticker: "ESRS", shares: 370, price: 24.32, executionDate: "2023-01-25", executionTime: "10:14AM" } }));
    await rawTransactions.append(createRawTransaction({ id: "assign-buy", kind: "PortfolioAssignment", source: "manual", payload: { targetId: "buy-old", portfolioId: portfolio.id } }));
    await rawTransactions.append(createRawTransaction({ id: "assign-sell", kind: "PortfolioAssignment", source: "manual", payload: { targetId: "sell-old", portfolioId: portfolio.id } }));
    const positions = await computeCanonicalPositions(repos, portfolio.id, {});
    expect(positions.find((position) => position.ticker === "ESRS")).toBeUndefined();
  });

  it("orders same-day ESRS lots by numeric broker time and keeps the result deterministic", () => {
    const early = { id: "lot-9am", executionDate: "2023-01-25", executionTime: "9:00AM" };
    const late = { id: "lot-11am", executionDate: "2023-01-25", executionTime: "11:00AM" };
    expect(compareLotsForSell(early, late)).toBeLessThan(0);
    expect(compareLotsForSell(late, early)).toBeGreaterThan(0);
    expect(compareLotsForSell(early, { ...early, id: "lot-zz" })).toBeLessThan(0);
  });
});

// This file intentionally uses only the append-only facts and pure projection
// helpers. It does not depend on browser state, making the ESRS guardrails run
// in CI and preventing regressions in local-first IndexedDB sessions.

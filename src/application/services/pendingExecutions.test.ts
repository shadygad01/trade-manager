import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import { createPendingExecutionRecord, confirmPendingExecution, completeSellAllocationForPendingExecution } from "./pendingExecutions";
import { recordBuy, recordSell, computePositions } from "./TradeService";

/**
 * Proves the fix for the bug this module exists to fix: a partial-fill
 * ("Needs Confirmation") execution must NOT create a Ledger Entry (Trade/
 * TradeAllocation) or affect Holdings/cost basis/cash until the broker
 * invoice is confirmed — see the audit's own "VERIFY" checklist.
 */

function seedPortfolio(cash: number) {
  return createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: cash });
}

describe("createPendingExecutionRecord", () => {
  it("records the execution as pending — needs confirmation, pending verification — without touching Trade/cash/Holdings", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });

    const pending = await createPendingExecutionRecord(repos, {
      portfolioId: "p1",
      ticker: "ABUK",
      side: "BUY",
      originalShares: 29,
      originalPrice: 41.17,
      executionDate: "2026-02-26",
      executionTime: "10:54",
      brokerStatus: "Partially filled, canceled",
    });

    expect(pending.verificationStatus).toBe("needs-confirmation");
    expect(pending.executionStatus).toBe("pending-verification");
    expect(pending.brokerStatus).toBe("Partially filled, canceled");

    // No Ledger Entry: zero trades exist for this ticker.
    expect(await repos.trades.getAll()).toEqual([]);

    // No Holdings impact: computePositions sees nothing for ABUK.
    const positions = await computePositions(repos, "p1", {});
    expect(positions).toEqual([]);

    // No cash impact: portfolio balance is untouched.
    const portfolio = await repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBe(10_000);
  });
});

describe("confirmPendingExecution — BUY", () => {
  it("creates the Ledger Entry (Trade) for the first time only now, debits cash for the confirmed total, and updates the SAME PendingExecution row — never a second one", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const pending = await createPendingExecutionRecord(repos, {
      portfolioId: "p1",
      ticker: "ABUK",
      side: "BUY",
      originalShares: 29,
      originalPrice: 41.17,
      executionDate: "2026-02-26",
      executionTime: "10:54",
      brokerStatus: "Partially filled",
    });

    // Before confirmation: no Ledger Entry, no Holdings.
    expect(await repos.trades.getAll()).toHaveLength(0);
    expect(await computePositions(repos, "p1", {})).toEqual([]);

    const { pendingExecution, trade } = await confirmPendingExecution(repos, pending.id, {
      shares: 30,
      price: 41.5,
      fees: 5,
      taxes: 2,
      invoiceNumber: "INV-001",
      brokerReference: "N000000000001",
    });

    expect(pendingExecution.id).toBe(pending.id); // same row, never duplicated
    expect(pendingExecution.verificationStatus).toBe("verified");
    expect(pendingExecution.executionStatus).toBe("executed");
    expect(pendingExecution.invoiceNumber).toBe("INV-001");
    expect(pendingExecution.brokerReference).toBe("N000000000001");
    expect(pendingExecution.confirmedShares).toBe(30);
    expect(pendingExecution.resultingTradeId).toBe(trade?.id);

    // Ledger Entry created only now.
    const trades = await repos.trades.getAll();
    expect(trades).toHaveLength(1);
    expect(trades[0].shares).toBe(30);
    expect(trades[0].entryPrice).toBe(41.5);

    // Holdings now reflect it.
    const positions = await computePositions(repos, "p1", {});
    expect(positions).toHaveLength(1);
    expect(positions[0].totalShares).toBe(30);

    // Cash debited by the confirmed total, not the original estimate.
    const portfolio = await repos.portfolios.getById("p1");
    expect(portfolio?.cash).toBeCloseTo(10_000 - (30 * 41.5 + 5 + 2));

    // The PendingExecution table still has exactly one row for this execution.
    expect(await repos.pendingExecutions.getAll()).toHaveLength(1);
  });

  it("refuses a second confirmation once already verified — never duplicates the Ledger Entry", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const pending = await createPendingExecutionRecord(repos, {
      portfolioId: "p1",
      ticker: "COMI",
      side: "BUY",
      originalShares: 10,
      originalPrice: 50,
      executionDate: "2026-01-05",
      brokerStatus: "Partially filled",
    });
    await confirmPendingExecution(repos, pending.id, { shares: 10, price: 50 });

    await expect(confirmPendingExecution(repos, pending.id, { shares: 10, price: 50 })).rejects.toThrow(/already verified/i);
    expect(await repos.trades.getAll()).toHaveLength(1); // still exactly one — no duplicate
  });

  it("throws for an unknown pending execution id", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    await expect(confirmPendingExecution(repos, "does-not-exist", { shares: 10, price: 50 })).rejects.toThrow(/not found/i);
  });
});

describe("confirmPendingExecution — SELL", () => {
  it("marks the pending execution verified but does NOT create a TradeAllocation or affect Holdings — allocation is still an explicit, separate step (ADR-002)", async () => {
    const repos = createFakeRepositories({ portfolios: [seedPortfolio(10_000)] });
    const { trade } = await recordBuy(repos, {
      portfolioId: "p1",
      ticker: "ABUK",
      shares: 190,
      entryPrice: 40,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });
    const pending = await createPendingExecutionRecord(repos, {
      portfolioId: "p1",
      ticker: "ABUK",
      side: "SELL",
      originalShares: 29,
      originalPrice: 41.17,
      executionDate: "2026-02-26",
      executionTime: "10:54",
      brokerStatus: "Partially filled, canceled",
    });

    const { pendingExecution, trade: tradeResult } = await confirmPendingExecution(repos, pending.id, {
      shares: 30,
      price: 41.5,
      fees: 5,
      taxes: 2,
    });

    expect(pendingExecution.verificationStatus).toBe("verified");
    // Still not "executed" — no allocation has happened yet.
    expect(pendingExecution.executionStatus).toBe("pending-verification");
    expect(tradeResult).toBeUndefined();

    // No TradeAllocation exists yet — Holdings are exactly what they were
    // before confirmation (the full 190-share Buy, untouched).
    expect(await repos.allocations.getAll()).toEqual([]);
    const positions = await computePositions(repos, "p1", {});
    expect(positions).toHaveLength(1);
    expect(positions[0].totalShares).toBe(190);

    // completeSellAllocationForPendingExecution is what finally creates the
    // Ledger Entry, once the user picks which lot(s) it closes.
    const sellResult = await recordSell(repos, {
      portfolioId: "p1",
      ticker: "ABUK",
      allocations: [{ tradeId: trade.id, shares: 30, exitPrice: 41.5, fees: 5, taxes: 2 }],
      executionDate: "2026-02-26",
      executionTime: "10:54",
    });
    const executed = await completeSellAllocationForPendingExecution(repos, pending.id, sellResult);

    expect(executed.executionStatus).toBe("executed");
    expect(executed.resultingSellGroupId).toBe(sellResult.allocations[0].sellGroupId);
    expect(await repos.pendingExecutions.getAll()).toHaveLength(1); // same row throughout

    const finalPositions = await computePositions(repos, "p1", {});
    expect(finalPositions[0].totalShares).toBe(160); // 190 - 30, now that the Ledger Entry exists
  });
});

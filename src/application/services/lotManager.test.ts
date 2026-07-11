import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories, createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { recordBuy } from "./TradeService";
import {
  recordSellTransaction,
  setSellAllocation,
  resetSellAllocation,
  proposeFifoAllocation,
  isTemporallyValid,
  getLotManagerSnapshot,
  type LotManagerRepos,
} from "./lotManager";

function fullRepos(cash = 10_000_000) {
  const base = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: cash })] });
  return { ...base, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() } as LotManagerRepos;
}

async function buy(repos: LotManagerRepos, shares: number, price: number, date: string, time = "10:00") {
  const { trade } = await recordBuy(repos, { portfolioId: "p1", ticker: "COMI", shares, entryPrice: price, executionDate: date, executionTime: time });
  return trade;
}

describe("lotManager — Pending Sell workflow (record without allocating, then allocate separately)", () => {
  it("a recorded Sell starts Pending with no allocation, and cash is realized immediately regardless of allocation", async () => {
    const repos = fullRepos();
    await buy(repos, 100, 40, "2026-01-01");
    const before = (await repos.portfolios.getById("p1"))!.cash;

    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 60, price: 50, executionDate: "2026-02-01" });

    const snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    const sell = snap.sells.find((s) => s.id === sellId)!;
    expect(sell.status).toBe("pending");
    expect(sell.allocatedShares).toBe(0);
    expect(sell.remainingShares).toBe(60);

    const after = (await repos.portfolios.getById("p1"))!.cash;
    expect(after - before).toBeCloseTo(60 * 50); // proceeds realized at execution, not allocation
  });

  it("multiple Buys, multiple Sells, partial allocation across stages — inventory always equals Buy quantity minus SUM of that lot's own allocations", async () => {
    const repos = fullRepos();
    const lotA = await buy(repos, 100, 40, "2026-01-01");
    const lotB = await buy(repos, 200, 42, "2026-01-05");
    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 150, price: 50, executionDate: "2026-02-01" });

    // Stage 1: partially allocate against lot A only.
    await setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: lotA.id, shares: 100 }]);
    let snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    let sell = snap.sells.find((s) => s.id === sellId)!;
    expect(sell.status).toBe("partial");
    expect(sell.remainingShares).toBe(50);
    expect(snap.buyLots.find((l) => l.id === lotA.id)!.remainingShares).toBe(0);
    expect(snap.buyLots.find((l) => l.id === lotB.id)!.remainingShares).toBe(200);

    // Stage 2 (Continue): add the remaining 50 shares against lot B, keeping lot A's line.
    await setSellAllocation(repos, "p1", "COMI", sellId, [
      { buyLotId: lotA.id, shares: 100 },
      { buyLotId: lotB.id, shares: 50 },
    ]);
    snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    sell = snap.sells.find((s) => s.id === sellId)!;
    expect(sell.status).toBe("completed");
    expect(sell.remainingShares).toBe(0);
    expect(snap.buyLots.find((l) => l.id === lotB.id)!.remainingShares).toBe(150);
  });

  it("Continue FIFO resumes from the last partially-allocated lot, never restarting from the first lot", async () => {
    const repos = fullRepos();
    const lotA = await buy(repos, 50, 40, "2026-01-01");
    const lotB = await buy(repos, 50, 41, "2026-01-02");
    const lotC = await buy(repos, 50, 42, "2026-01-03");
    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 120, price: 50, executionDate: "2026-02-01" });

    // First FIFO pass over the sell's initial (empty) state proposes lot A and
    // lot B fully (50 each), then partially lot C (20 of its 50) to reach 120.
    let snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    let proposal = proposeFifoAllocation(snap, sellId);
    expect(proposal).toEqual([
      { buyLotId: lotA.id, buyLotExecutionDate: "2026-01-01", shares: 50 },
      { buyLotId: lotB.id, buyLotExecutionDate: "2026-01-02", shares: 50 },
      { buyLotId: lotC.id, buyLotExecutionDate: "2026-01-03", shares: 20 },
    ]);
    // Confirm only the first two lines (deliberately leaving lot C's share unconfirmed, to exercise staged/Continue allocation).
    const firstStage = proposal.slice(0, 2);
    await setSellAllocation(repos, "p1", "COMI", sellId, firstStage.map((p) => ({ buyLotId: p.buyLotId, shares: p.shares })));

    // Continue FIFO: must pick up exactly where the confirmed allocation left
    // off (lot C, the next lot with remaining capacity) — never re-propose
    // lot A or lot B, both already fully claimed by this sell.
    snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    proposal = proposeFifoAllocation(snap, sellId);
    expect(proposal.find((p) => p.buyLotId === lotA.id)).toBeUndefined();
    expect(proposal.find((p) => p.buyLotId === lotB.id)).toBeUndefined();
    expect(proposal).toEqual([{ buyLotId: lotC.id, buyLotExecutionDate: "2026-01-03", shares: 20 }]);
    const fullyMerged = [...firstStage, ...proposal].map((p) => ({ buyLotId: p.buyLotId, shares: p.shares }));
    await setSellAllocation(repos, "p1", "COMI", sellId, fullyMerged);

    snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    const sell = snap.sells.find((s) => s.id === sellId)!;
    expect(sell.status).toBe("completed");
    expect(snap.buyLots.find((l) => l.id === lotA.id)!.status).toBe("closed");
    expect(snap.buyLots.find((l) => l.id === lotB.id)!.status).toBe("closed");
    expect(snap.buyLots.find((l) => l.id === lotC.id)!.status).toBe("partial"); // only 20 of its 50 shares closed
  });

  it("temporal validation: a Buy lot dated after the Sell stays visible but is never allocatable, even via a direct call", async () => {
    const repos = fullRepos();
    const earlyLot = await buy(repos, 50, 40, "2026-01-01");
    const futureLot = await buy(repos, 50, 41, "2026-03-01"); // after the sell
    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, price: 50, executionDate: "2026-02-01" });

    const snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    const sell = snap.sells.find((s) => s.id === sellId)!;
    const future = snap.buyLots.find((l) => l.id === futureLot.id)!;
    expect(isTemporallyValid(future, sell)).toBe(false);
    expect(snap.buyLots.map((l) => l.id)).toContain(futureLot.id); // never hidden

    await expect(setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: futureLot.id, shares: 50 }])).rejects.toThrow(
      /occurred after the selected Sell/,
    );

    // The valid, earlier lot still allocates fine.
    void earlyLot;
    await setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: earlyLot.id, shares: 50 }]);
    const after = await getLotManagerSnapshot(repos, "p1", "COMI");
    expect(after.sells.find((s) => s.id === sellId)!.status).toBe("completed");
  });

  it("rejects over-allocation, duplicate lot lines, and over-committing a lot's own remaining balance", async () => {
    const repos = fullRepos();
    const lotA = await buy(repos, 50, 40, "2026-01-01");
    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 30, price: 50, executionDate: "2026-02-01" });

    await expect(setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: lotA.id, shares: 40 }])).rejects.toThrow(
      /only closed 30/,
    );
    await expect(
      setSellAllocation(repos, "p1", "COMI", sellId, [
        { buyLotId: lotA.id, shares: 10 },
        { buyLotId: lotA.id, shares: 10 },
      ]),
    ).rejects.toThrow(/Duplicate allocation/);

    const lotB = await buy(repos, 10, 41, "2026-01-02");
    await expect(setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: lotB.id, shares: 20 }])).rejects.toThrow(
      /only 10 available/,
    );
  });

  it("a Pending sell surfaces a missing-allocation validation issue; allocating it clears the issue", async () => {
    const repos = fullRepos();
    const lotA = await buy(repos, 50, 40, "2026-01-01");
    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, price: 50, executionDate: "2026-02-01" });

    let snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    expect(snap.issues.some((i) => i.code === "missing-allocation" && i.sellId === sellId)).toBe(true);

    await setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: lotA.id, shares: 50 }]);
    snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    expect(snap.issues.some((i) => i.code === "missing-allocation")).toBe(false);
  });

  it("deterministic rebuild: recomputing the snapshot from the same facts always reproduces identical results", async () => {
    const repos = fullRepos();
    const lotA = await buy(repos, 50, 40, "2026-01-01");
    const { sellId } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, price: 50, executionDate: "2026-02-01" });
    await setSellAllocation(repos, "p1", "COMI", sellId, [{ buyLotId: lotA.id, shares: 50 }]);

    const first = await getLotManagerSnapshot(repos, "p1", "COMI");
    const second = await getLotManagerSnapshot(repos, "p1", "COMI");
    expect(second).toEqual(first);
  });

  it("Reset Allocation never auto-closes a lot or a sell it doesn't touch — only the targeted Sell's own state changes", async () => {
    const repos = fullRepos();
    const lotA = await buy(repos, 50, 40, "2026-01-01");
    const lotB = await buy(repos, 50, 41, "2026-01-02");
    const { sellId: sellX } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, price: 50, executionDate: "2026-02-01" });
    const { sellId: sellY } = await recordSellTransaction(repos, { portfolioId: "p1", ticker: "COMI", shares: 50, price: 55, executionDate: "2026-02-05" });
    await setSellAllocation(repos, "p1", "COMI", sellX, [{ buyLotId: lotA.id, shares: 50 }]);
    await setSellAllocation(repos, "p1", "COMI", sellY, [{ buyLotId: lotB.id, shares: 50 }]);

    await resetSellAllocation(repos, "p1", "COMI", sellX);

    const snap = await getLotManagerSnapshot(repos, "p1", "COMI");
    expect(snap.sells.find((s) => s.id === sellX)!.status).toBe("pending");
    expect(snap.buyLots.find((l) => l.id === lotA.id)!.status).toBe("open");
    // sellY/lotB completely untouched.
    expect(snap.sells.find((s) => s.id === sellY)!.status).toBe("completed");
    expect(snap.buyLots.find((l) => l.id === lotB.id)!.status).toBe("closed");
  });
});

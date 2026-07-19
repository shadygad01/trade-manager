import { describe, it, expect } from "vitest";
import { createRawTransaction, type RawTransaction, type SellExecutionPayload, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import { resolveCurrentTicker, findUnclaimedSellExecutionFact, findUnallocatedSellExecutions } from "./rawTransactionFolds";

function sellFact(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 60, executionDate: "2026-02-01", executionTime: "11:00", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "official-broker-excel", ticker: payload.ticker, payload }), seq: 1 };
}

describe("findUnclaimedSellExecutionFact", () => {
  it("finds an unclaimed fact under its current, corrected ticker even though it was written under the old name", () => {
    const fact = sellFact({ id: "s1", ticker: "CLHOA" });
    const correction = {
      ...createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId: "s1", patch: { ticker: "CLHO" } } }),
      seq: 2,
    };
    const all = [fact, correction];

    const found = findUnclaimedSellExecutionFact(all, { ticker: "CLHO", executionDate: "2026-02-01", shares: 100, price: 60 });
    expect(found?.id).toBe("s1");

    // The OLD ticker name no longer matches this fact at all.
    expect(findUnclaimedSellExecutionFact(all, { ticker: "CLHOA", executionDate: "2026-02-01", shares: 100, price: 60 })).toBeUndefined();
  });

  it("does not match a fact whose resolved ticker differs from the requested one", () => {
    const fact = sellFact({ id: "s1", ticker: "COMI" });
    const found = findUnclaimedSellExecutionFact([fact], { ticker: "HRHO", executionDate: "2026-02-01", shares: 100, price: 60 });
    expect(found).toBeUndefined();
  });
});

describe("resolveCurrentTicker", () => {
  it("returns the fact's own ticker when no correction targets it", () => {
    const fact = sellFact({ id: "s1", ticker: "COMI" });
    expect(resolveCurrentTicker([fact], fact)).toBe("COMI");
  });
});

// Root-cause regression coverage (docs/ROADMAP.md's investigation): the
// canonical, fact-log-derived answer to "does this ticker still need a lot
// allocation" — the exact signal that was previously missing everywhere
// checkTickerMatch's "matched" verdict (pure net-share arithmetic) was
// mistaken for "fully processed."
describe("findUnallocatedSellExecutions", () => {
  function decisionFact(sellExecutionId: string, overrides: Partial<RawTransaction> = {}): RawTransaction {
    const payload: SellAllocationDecisionPayload = { sellExecutionId, allocations: [{ lotRef: "buy-1", shares: 100 }] };
    return { ...createRawTransaction({ kind: "SellAllocationDecision", source: "manual", ticker: "COMI", payload, ...overrides }), seq: 2 };
  }

  it("returns a live SellExecution fact with no SellAllocationDecision pointed at it", () => {
    const sell = sellFact({ id: "s1", ticker: "COMI" });
    expect(findUnallocatedSellExecutions([sell], "COMI")).toEqual([sell]);
  });

  it("excludes a SellExecution fact a live SellAllocationDecision already claims", () => {
    const sell = sellFact({ id: "s1", ticker: "COMI" });
    const decision = decisionFact("s1");
    expect(findUnallocatedSellExecutions([sell, decision], "COMI")).toEqual([]);
  });

  it("counts the sell as unallocated again once its decision fact is itself retracted", () => {
    const sell = sellFact({ id: "s1", ticker: "COMI" });
    const decision = { ...decisionFact("s1"), id: "d1" };
    const retraction = {
      ...createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: "d1", reason: "test" } }),
      seq: 3,
    };
    expect(findUnallocatedSellExecutions([sell, decision, retraction], "COMI")).toEqual([sell]);
  });

  it("never returns a retracted SellExecution fact, allocated or not", () => {
    const sell = { ...sellFact({ id: "s1", ticker: "COMI" }) };
    const retraction = {
      ...createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: "s1", reason: "test" } }),
      seq: 2,
    };
    expect(findUnallocatedSellExecutions([sell, retraction], "COMI")).toEqual([]);
  });

  it("resolves a sell under its current, corrected ticker, same as findUnclaimedSellExecutionFact", () => {
    const sell = sellFact({ id: "s1", ticker: "CLHOA" });
    const correction = {
      ...createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId: "s1", patch: { ticker: "CLHO" } } }),
      seq: 2,
    };
    expect(findUnallocatedSellExecutions([sell, correction], "CLHO").map((t) => t.id)).toEqual(["s1"]);
    expect(findUnallocatedSellExecutions([sell, correction], "CLHOA")).toEqual([]);
  });

  it("only reports the still-unallocated sells among several, not the whole ticker", () => {
    const allocatedSell = sellFact({ id: "s1", ticker: "COMI", shares: 100 });
    const unallocatedSell = sellFact({ id: "s2", ticker: "COMI", shares: 50 });
    const decision = decisionFact("s1");
    const result = findUnallocatedSellExecutions([allocatedSell, unallocatedSell, decision], "COMI");
    expect(result.map((t) => t.id)).toEqual(["s2"]);
  });

  it("returns an empty array for a ticker with no sells at all", () => {
    expect(findUnallocatedSellExecutions([], "COMI")).toEqual([]);
  });

  // Adversarial-review regression: lotManager.setSellAllocation legitimately
  // supports PARTIAL allocation of a sell (rejects totalRequested >
  // sell.shares, not !==) — an earlier version of this function treated "any
  // live decision exists" as "fully allocated," which silently reported a
  // sell with 40-of-100 shares allocated via the Lot Manager as resolved,
  // even though 60 shares of it were still genuinely unaccounted for.
  it("still reports a sell as unallocated when its only live decision covers FEWER shares than the sell itself (a Lot Manager partial allocation)", () => {
    const sell = sellFact({ id: "s1", ticker: "COMI", shares: 100 });
    const partialDecision = {
      ...createRawTransaction({
        kind: "SellAllocationDecision",
        source: "manual",
        ticker: "COMI",
        payload: { sellExecutionId: "s1", allocations: [{ lotRef: "buy-1", shares: 40 }] } satisfies SellAllocationDecisionPayload,
      }),
      seq: 2,
    };
    expect(findUnallocatedSellExecutions([sell, partialDecision], "COMI")).toEqual([sell]);
  });

  it("reports a sell as fully allocated once several live decisions' shares SUM to its own share count", () => {
    const sell = sellFact({ id: "s1", ticker: "COMI", shares: 100 });
    const decisionA = {
      ...createRawTransaction({
        kind: "SellAllocationDecision",
        source: "manual",
        ticker: "COMI",
        payload: { sellExecutionId: "s1", allocations: [{ lotRef: "buy-1", shares: 40 }] } satisfies SellAllocationDecisionPayload,
      }),
      seq: 2,
    };
    const decisionB = {
      ...createRawTransaction({
        kind: "SellAllocationDecision",
        source: "manual",
        ticker: "COMI",
        payload: { sellExecutionId: "s1", allocations: [{ lotRef: "buy-2", shares: 60 }] } satisfies SellAllocationDecisionPayload,
      }),
      seq: 3,
    };
    expect(findUnallocatedSellExecutions([sell, decisionA, decisionB], "COMI")).toEqual([]);
  });
});

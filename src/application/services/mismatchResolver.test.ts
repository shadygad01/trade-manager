import { describe, it, expect } from "vitest";
import { suggestRemovalsToReconcile, type ReconcilableRow } from "./mismatchResolver";

function buy(key: string, shares: number, price: number, confidence?: ReconcilableRow["confidence"]): ReconcilableRow {
  return { key, side: "BUY", shares, price, confidence };
}

function sell(key: string, shares: number, price: number): ReconcilableRow {
  return { key, side: "SELL", shares, price };
}

describe("suggestRemovalsToReconcile", () => {
  it("finds the unique subset whose removal leaves exactly the broker's verified count", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("a", 30, 24.9, "high"), buy("b", 15, 24.73, "high"), buy("c", 8, 46.66, "low")],
      existingRemainingShares: 0,
      verifiedUnits: 45,
    });
    expect(suggestion).toBeDefined();
    expect(suggestion!.keysToRemove).toEqual(["c"]);
    expect(suggestion!.alternatives).toBe(0);
  });

  it("uses the broker's avg cost to pick between subsets that both reconcile the count", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("expensive", 10, 50, "high"), buy("cheap", 10, 10, "high"), buy("kept", 10, 50, "high")],
      existingRemainingShares: 0,
      verifiedUnits: 20,
      verifiedAvgCost: 50,
    });
    expect(suggestion!.keysToRemove).toEqual(["cheap"]);
    expect(suggestion!.alternatives).toBeGreaterThan(0);
    expect(suggestion!.rankedByAvgCost).toBe(true);
  });

  it("folds the existing lots' cost basis into the implied avg when the ticker already has shares on the ledger", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("a", 10, 60, "high"), buy("b", 10, 20, "high")],
      existingRemainingShares: 10,
      existingCostBasis: 200,
      verifiedUnits: 20,
      verifiedAvgCost: 20,
    });
    expect(suggestion!.keysToRemove).toEqual(["a"]);
    expect(suggestion!.rankedByAvgCost).toBe(true);
  });

  it("prefers removing the lower-confidence rows when the count and avg cost can't separate the options", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("anchored", 25, 22.77, "high"), buy("guessA", 10, 22.5, "medium"), buy("guessB", 15, 22.5, "low")],
      existingRemainingShares: 0,
      verifiedUnits: 25,
    });
    expect(suggestion!.keysToRemove).toEqual(["guessA", "guessB"]);
    expect(suggestion!.alternatives).toBe(1);
    expect(suggestion!.rankedByAvgCost).toBe(false);
  });

  it("handles a mixed Buy/Sell removal and skips avg-cost ranking when sells are in play", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("a", 30, 20, "high"), buy("b", 20, 21, "low"), sell("s", 10, 25)],
      existingRemainingShares: 0,
      verifiedUnits: 30,
      verifiedAvgCost: 20,
    });
    expect(suggestion!.keysToRemove).toEqual(["b", "s"]);
    expect(suggestion!.rankedByAvgCost).toBe(false);
  });

  it("returns undefined when no subset can reconcile the difference", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("a", 10, 20), buy("b", 25, 21)],
      existingRemainingShares: 0,
      verifiedUnits: 30,
    });
    expect(suggestion).toBeUndefined();
  });

  it("returns undefined when the count already matches — nothing to fix", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("a", 30, 20)],
      existingRemainingShares: 0,
      verifiedUnits: 30,
    });
    expect(suggestion).toBeUndefined();
  });

  it("never suggests emptying the batch — reconciling by removing every row is the alreadyFullyRecorded case, not a row fix", () => {
    const suggestion = suggestRemovalsToReconcile({
      rows: [buy("a", 10, 20), buy("b", 20, 21)],
      existingRemainingShares: 50,
      verifiedUnits: 50,
    });
    expect(suggestion).toBeUndefined();
  });
});

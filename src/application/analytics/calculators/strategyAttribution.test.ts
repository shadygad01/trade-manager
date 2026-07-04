import { describe, it, expect } from "vitest";
import { strategyAttribution } from "./strategyAttribution";
import { makeTrade, makeAllocation } from "./testFixtures";

describe("strategyAttribution", () => {
  it("returns nothing when no trade carries a strategy tag", () => {
    const trade = makeTrade({ id: "t1", strategyTags: [] });
    expect(strategyAttribution([trade], [])).toHaveLength(0);
  });

  it("attributes a trade's realized P/L to its strategy tag", () => {
    const trade = makeTrade({ id: "t1", shares: 100, entryPrice: 10, strategyTags: ["Swing"] });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 20 })];
    const [result] = strategyAttribution([trade], allocations);
    expect(result.tag).toBe("Swing");
    expect(result.tradeCount).toBe(1);
    expect(result.totalRealizedPnl).toBeCloseTo(100 * (20 - 10));
    expect(result.winRate).toBe(100);
  });

  it("attributes the same trade's P/L to every tag it carries", () => {
    const trade = makeTrade({ id: "t1", shares: 100, entryPrice: 10, strategyTags: ["Swing", "Momentum"] });
    const allocations = [makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 20 })];
    const results = strategyAttribution([trade], allocations);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tag).sort()).toEqual(["Momentum", "Swing"]);
    for (const r of results) {
      expect(r.totalRealizedPnl).toBeCloseTo(100 * (20 - 10));
    }
  });

  it("keeps separate strategies' stats independent", () => {
    const winner = makeTrade({ id: "t1", shares: 100, entryPrice: 10, strategyTags: ["Breakout"] });
    const loser = makeTrade({ id: "t2", shares: 100, entryPrice: 10, strategyTags: ["Value"] });
    const allocations = [
      makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 20 }),
      makeAllocation({ tradeId: "t2", sharesClosed: 100, exitPrice: 5 }),
    ];
    const results = strategyAttribution([winner, loser], allocations);
    const breakout = results.find((r) => r.tag === "Breakout")!;
    const value = results.find((r) => r.tag === "Value")!;
    expect(breakout.winRate).toBe(100);
    expect(value.winRate).toBe(0);
  });

  it("ranks strategies by total realized P/L, best first", () => {
    const best = makeTrade({ id: "t1", shares: 100, entryPrice: 10, strategyTags: ["Best"] });
    const worst = makeTrade({ id: "t2", shares: 100, entryPrice: 10, strategyTags: ["Worst"] });
    const allocations = [
      makeAllocation({ tradeId: "t1", sharesClosed: 100, exitPrice: 30 }),
      makeAllocation({ tradeId: "t2", sharesClosed: 100, exitPrice: 15 }),
    ];
    const results = strategyAttribution([best, worst], allocations);
    expect(results[0].tag).toBe("Best");
    expect(results[1].tag).toBe("Worst");
  });
});

import { describe, it, expect } from "vitest";
import { performanceCurve, bucketPerformance, performanceDrawdown } from "./performanceCurve";
import { makeTrade, makeAllocation } from "./testFixtures";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";

function depositEvent(timestamp: string, amount: number): TimelineEvent {
  return { id: `dep-${timestamp}`, portfolioId: "p1", type: "Deposit", timestamp, amount, attachments: [], createdAt: timestamp };
}

function dividendEvent(timestamp: string, amount: number): TimelineEvent {
  return { id: `div-${timestamp}`, portfolioId: "p1", type: "Dividend", timestamp, amount, attachments: [], createdAt: timestamp };
}

describe("performanceCurve", () => {
  it("returns a single today point at 0% when there's no history at all", () => {
    const curve = performanceCurve([], [], [], "2026-06-01");
    expect(curve).toEqual([{ date: "2026-06-01", realizedReturnPct: 0, dividendReturnPct: 0 }]);
  });

  it("computes realized return % against net contributed capital, never against raw cash", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocation = makeAllocation({ tradeId: "t1", sharesClosed: 10, exitPrice: 15, executionDate: "2026-02-01", executionTime: "10:00" });

    const curve = performanceCurve([trade], [allocation], [depositEvent("2026-01-01T09:00", 1000)], "2026-02-01");

    expect(curve).toEqual([
      { date: "2026-01-01", realizedReturnPct: 0, dividendReturnPct: 0 },
      { date: "2026-02-01", realizedReturnPct: 5, dividendReturnPct: 0 }, // 50 profit / 1000 contributed = 5%
    ]);
  });

  it("never lets a deposit landing mid-history read as a gain (the reported bug's root cause)", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocation = makeAllocation({ tradeId: "t1", sharesClosed: 10, exitPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" }); // breakeven sell, 0 realized P/L
    const events = [depositEvent("2026-01-01T09:00", 34), depositEvent("2026-07-01T09:00", 10000)];

    const curve = performanceCurve([trade], [allocation], events, "2026-07-05");
    const last = curve[curve.length - 1];
    expect(last.realizedReturnPct).toBe(0);
    expect(last.dividendReturnPct).toBe(0);
  });

  it("tracks dividend return % separately from realized return %", () => {
    const events = [depositEvent("2026-01-01T09:00", 2000), dividendEvent("2026-03-01T09:00", 100)];
    const curve = performanceCurve([], [], events, "2026-03-01");
    expect(curve[curve.length - 1]).toEqual({ date: "2026-03-01", realizedReturnPct: 0, dividendReturnPct: 5 });
  });

  it("does not append a duplicate point when a real event already lands on today", () => {
    const curve = performanceCurve([], [], [depositEvent("2026-01-01T09:00", 1000)], "2026-01-01");
    expect(curve).toEqual([{ date: "2026-01-01", realizedReturnPct: 0, dividendReturnPct: 0 }]);
  });
});

describe("bucketPerformance", () => {
  it("buckets each period's own realized P/L and dividends against capital already contributed before that period", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocation = makeAllocation({ tradeId: "t1", sharesClosed: 10, exitPrice: 15, executionDate: "2026-02-15", executionTime: "10:00" }); // +50
    const events = [depositEvent("2026-01-01T09:00", 1000), dividendEvent("2026-03-10T09:00", 20)];

    const periods = bucketPerformance([trade], [allocation], events, 7, {}, "2026-03-31");

    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 5, dividendReturnPct: 0, unrealizedReturnPct: 0 }, // 50/1000
      { period: "2026-03", realizedReturnPct: 0, dividendReturnPct: 2, unrealizedReturnPct: 0 }, // 20/1000
    ]);
  });

  it("uses capital already contributed before the period even started as the basis, not a same-period deposit", () => {
    // The Jan bucket's own first event is the very first deposit ever made —
    // capital "at the start of January" is genuinely 0 (nothing was
    // contributed yet before this period began), so this period's return
    // is 0% regardless of the +50 gain later that same month: there's no
    // pre-existing capital base to express it as a %, matching
    // portfolioReturn's own "no contributions yet" guard.
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocation = makeAllocation({ tradeId: "t1", sharesClosed: 10, exitPrice: 15, executionDate: "2026-01-05", executionTime: "10:00" }); // +50
    const events = [depositEvent("2026-01-01T09:00", 1000), depositEvent("2026-01-20T09:00", 50000)];

    const periods = bucketPerformance([trade], [allocation], events, 7, {}, "2026-01-31");
    expect(periods).toEqual([{ period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 }]);
  });

  it("does use capital contributed in an earlier period as the basis for a later period's own gain", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocation = makeAllocation({ tradeId: "t1", sharesClosed: 10, exitPrice: 15, executionDate: "2026-02-05", executionTime: "10:00" }); // +50
    const events = [depositEvent("2026-01-01T09:00", 1000)];

    const periods = bucketPerformance([trade], [allocation], events, 7, {}, "2026-02-28");
    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 5, dividendReturnPct: 0, unrealizedReturnPct: 0 },
    ]);
  });

  it("covers every calendar month up to today even when nothing happened in it — an open position sitting untouched still gets a bucket for its unrealized swing", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100, executionDate: "2026-01-01" });
    const events = [depositEvent("2026-01-01T09:00", 1000)];

    // No realized/dividend/deposit activity at all in Feb or March — under
    // the old event-driven bucketing these months wouldn't exist at all.
    const periods = bucketPerformance([trade], [], events, 7, {}, "2026-03-15");
    expect(periods.map((p) => p.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("computes each period's unrealized % as the CHANGE in mark-to-market during that period, using that period's own historical price — never blending today's price into every period (the original spike bug)", () => {
    const trade = makeTrade({ id: "t1", ticker: "COMI", entryPrice: 10, shares: 100, executionDate: "2026-01-01" });
    const events = [depositEvent("2026-01-01T09:00", 1000)];
    // Jan's own basis is 0 (the deposit lands on Jan's own calendar start —
    // see the "same-period deposit" rule above), so price movement is given
    // for Feb/Mar instead, where the deposit already counts toward basis.
    const priceHistory = { COMI: { "2026-02-28": 12, "2026-03-31": 14 } };

    const periods = bucketPerformance([trade], [], events, 7, priceHistory, "2026-03-31");

    // Feb: mark-to-market at Feb 28 = (12-10)*100 = 200, up from 0 → 200/1000 = 20%
    // Mar: mark-to-market at Mar 31 = (14-10)*100 = 400, up from 200 → 200/1000 = 20%
    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 20 },
      { period: "2026-03", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 20 },
    ]);
  });

  it("shifts a position's unrealized gain into realizedReturnPct once it's sold, without double-counting across periods", () => {
    const trade = makeTrade({ id: "t1", ticker: "COMI", entryPrice: 10, shares: 100, executionDate: "2026-01-01" });
    const allocation = makeAllocation({ tradeId: "t1", ticker: "COMI", sharesClosed: 100, exitPrice: 12, executionDate: "2026-03-10", executionTime: "10:00" });
    const events = [depositEvent("2026-01-01T09:00", 1000)];
    const priceHistory = { COMI: { "2026-02-28": 12 } };

    const periods = bucketPerformance([trade], [allocation], events, 7, priceHistory, "2026-03-31");

    // Feb: still open, mark-to-market at Feb 28 = (12-10)*100 = 200 → +20%
    // Mar: sold for (12-10)*100 = 200 realized; position now closed so
    // mark-to-market at Mar-end is 0 → unrealized delta = 0 - 200 = -200 → -20%
    // Total across all periods: 0 (Jan) + 20 (Feb unrealized) + 20 (Mar realized) - 20 (Mar unrealized reversal) = 20%,
    // matching the real total gain (200/1000 = 20%) exactly once.
    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 20 },
      { period: "2026-03", realizedReturnPct: 20, dividendReturnPct: 0, unrealizedReturnPct: -20 },
    ]);
  });

  it("reports 0 unrealized % for a period when no historical price is available for that ticker, rather than fabricating one", () => {
    const trade = makeTrade({ id: "t1", ticker: "COMI", entryPrice: 10, shares: 100, executionDate: "2026-01-01" });
    const events = [depositEvent("2026-01-01T09:00", 1000)];

    const periods = bucketPerformance([trade], [], events, 7, {}, "2026-02-28");
    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 },
    ]);
  });

  it("returns an empty array when there's no trade or event history at all", () => {
    expect(bucketPerformance([], [], [], 7, {}, "2026-03-31")).toEqual([]);
  });
});

describe("performanceDrawdown", () => {
  it("is 0 for a curve that only ever rises", () => {
    const curve = [
      { date: "2026-01-01", realizedReturnPct: 0, dividendReturnPct: 0 },
      { date: "2026-02-01", realizedReturnPct: 5, dividendReturnPct: 1 },
      { date: "2026-03-01", realizedReturnPct: 10, dividendReturnPct: 2 },
    ];
    expect(performanceDrawdown(curve)).toBe(0);
  });

  it("reports the max peak-to-trough decline in percentage points, never blowing out from a cash-flow artifact", () => {
    const curve = [
      { date: "2026-01-01", realizedReturnPct: 0, dividendReturnPct: 0 },
      { date: "2026-02-01", realizedReturnPct: 20, dividendReturnPct: 0 },
      { date: "2026-03-01", realizedReturnPct: 5, dividendReturnPct: 0 }, // -15 points off the 20 peak
      { date: "2026-04-01", realizedReturnPct: 12, dividendReturnPct: 0 },
    ];
    expect(performanceDrawdown(curve)).toBe(15);
  });
});

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

    const periods = bucketPerformance([trade], [allocation], events, 7);

    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 5, dividendReturnPct: 0 }, // 50/1000
      { period: "2026-03", realizedReturnPct: 0, dividendReturnPct: 2 }, // 20/1000
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

    const periods = bucketPerformance([trade], [allocation], events, 7);
    expect(periods).toEqual([{ period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0 }]);
  });

  it("does use capital contributed in an earlier period as the basis for a later period's own gain", () => {
    const trade = makeTrade({ id: "t1", entryPrice: 10, shares: 100 });
    const allocation = makeAllocation({ tradeId: "t1", sharesClosed: 10, exitPrice: 15, executionDate: "2026-02-05", executionTime: "10:00" }); // +50
    const events = [depositEvent("2026-01-01T09:00", 1000)];

    const periods = bucketPerformance([trade], [allocation], events, 7);
    expect(periods).toEqual([
      { period: "2026-01", realizedReturnPct: 0, dividendReturnPct: 0 },
      { period: "2026-02", realizedReturnPct: 5, dividendReturnPct: 0 },
    ]);
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

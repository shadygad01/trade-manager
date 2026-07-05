import { describe, it, expect } from "vitest";
import { equityCurve, cashFlowCurve } from "./equityCurve";
import type { TimelineEvent } from "@domain/entities/TimelineEvent";

function event(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, "timestamp" | "amount">): TimelineEvent {
  return {
    id: overrides.id ?? `evt-${overrides.timestamp}`,
    portfolioId: "p1",
    type: overrides.type ?? "Deposit",
    timestamp: overrides.timestamp,
    amount: overrides.amount,
    attachments: [],
    createdAt: overrides.timestamp,
  };
}

describe("equityCurve", () => {
  it("returns just today's mark when there are no timeline events", () => {
    const curve = equityCurve([], 5000, 1000, "2026-06-01");
    expect(curve).toEqual([{ date: "2026-06-01", equity: 6000, contributed: 0 }]);
  });

  it("builds cumulative cash-flow points and reconciles the final point with current cash + market value", () => {
    const events = [
      event({ timestamp: "2026-01-01T10:00", amount: 10000 }),
      event({ timestamp: "2026-01-15T10:00", amount: -2000, type: "Withdrawal" }),
    ];
    const curve = equityCurve(events, 8000, 3000, "2026-02-01");
    expect(curve).toEqual([
      { date: "2026-01-01", equity: 10000, contributed: 10000 },
      { date: "2026-01-15", equity: 8000, contributed: 8000 },
      { date: "2026-02-01", equity: 11000, contributed: 8000 },
    ]);
  });

  it("merges today's mark into the last point when an event already lands on today", () => {
    const events = [event({ timestamp: "2026-02-01T10:00", amount: 5000 })];
    const curve = equityCurve(events, 5000, 500, "2026-02-01");
    expect(curve).toEqual([{ date: "2026-02-01", equity: 5500, contributed: 5000 }]);
  });

  it("only counts Deposit/Withdrawal events toward contributed, not Buy/Sell/Dividend cash effects", () => {
    const events = [
      event({ timestamp: "2026-01-01T10:00", amount: 10000, type: "Deposit" }),
      event({ timestamp: "2026-01-05T10:00", amount: -3000, type: "Buy" }),
      event({ timestamp: "2026-01-10T10:00", amount: 500, type: "Dividend" }),
    ];
    const curve = equityCurve(events, 7500, 3000, "2026-01-10");
    expect(curve.map((p) => p.contributed)).toEqual([10000, 10000, 10000]);
  });
});

describe("cashFlowCurve", () => {
  it("never blends in market value at today's point, unlike equityCurve — no fake spike in whatever period contains today (the reported July bug)", () => {
    const events = [
      event({ timestamp: "2026-06-15T10:00", amount: -3000, type: "Buy" }),
      event({ timestamp: "2026-07-01T10:00", amount: -500, type: "Buy" }),
    ];
    // A big unrealized gain sitting in open positions — equityCurve would
    // dump this entirely into the last (July) point; cashFlowCurve must not.
    const blended = equityCurve(events, 6500, 50000, "2026-07-05");
    const cashOnly = cashFlowCurve(events, 6500, "2026-07-05");

    expect(blended[blended.length - 1].equity).toBe(56500);
    expect(cashOnly[cashOnly.length - 1].equity).toBe(6500);
    expect(cashOnly.map((p) => p.equity)).toEqual([7000, 6500, 6500]);
  });

  it("appends today at plain current cash when no event already lands on today", () => {
    const curve = cashFlowCurve([], 4200, "2026-06-01");
    expect(curve).toEqual([{ date: "2026-06-01", equity: 4200, contributed: 0 }]);
  });

  it("does not append a duplicate point when an event already lands on today", () => {
    const events = [event({ timestamp: "2026-02-01T10:00", amount: 5000 })];
    const curve = cashFlowCurve(events, 5000, "2026-02-01");
    expect(curve).toEqual([{ date: "2026-02-01", equity: 5000, contributed: 5000 }]);
  });
});

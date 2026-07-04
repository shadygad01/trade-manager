import { describe, it, expect } from "vitest";
import { equityCurve } from "./equityCurve";
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
    expect(curve).toEqual([{ date: "2026-06-01", equity: 6000 }]);
  });

  it("builds cumulative cash-flow points and reconciles the final point with current cash + market value", () => {
    const events = [
      event({ timestamp: "2026-01-01T10:00", amount: 10000 }),
      event({ timestamp: "2026-01-15T10:00", amount: -2000, type: "Withdrawal" }),
    ];
    const curve = equityCurve(events, 8000, 3000, "2026-02-01");
    expect(curve).toEqual([
      { date: "2026-01-01", equity: 10000 },
      { date: "2026-01-15", equity: 8000 },
      { date: "2026-02-01", equity: 11000 },
    ]);
  });

  it("merges today's mark into the last point when an event already lands on today", () => {
    const events = [event({ timestamp: "2026-02-01T10:00", amount: 5000 })];
    const curve = equityCurve(events, 5000, 500, "2026-02-01");
    expect(curve).toEqual([{ date: "2026-02-01", equity: 5500 }]);
  });
});

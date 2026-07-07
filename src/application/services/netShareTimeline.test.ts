import { describe, it, expect } from "vitest";
import { findLastBalancedDate } from "./netShareTimeline";

describe("findLastBalancedDate", () => {
  it("finds the last date the running net returns to 0 (the real ISPH shape: a clean Jan 2023 batch, then a 247-share gap opening in 2024 and never closing)", () => {
    const rows = [
      { key: "b1", side: "BUY" as const, shares: 2000, date: "2023-01-05" },
      { key: "b2", side: "BUY" as const, shares: 1000, date: "2023-01-05" },
      { key: "b3", side: "BUY" as const, shares: 1500, date: "2023-01-05" },
      { key: "b4", side: "BUY" as const, shares: 500, date: "2023-01-05" },
      { key: "b5", side: "BUY" as const, shares: 700, date: "2023-01-05" },
      { key: "s1", side: "SELL" as const, shares: 3200, date: "2023-01-09" },
      { key: "s2", side: "SELL" as const, shares: 2500, date: "2023-01-09" },
      { key: "b6", side: "BUY" as const, shares: 450, date: "2024-03-28" },
      { key: "b7", side: "BUY" as const, shares: 194, date: "2024-03-31" },
      { key: "b8", side: "BUY" as const, shares: 100, date: "2024-04-17" },
      { key: "b9", side: "BUY" as const, shares: 1, date: "2024-05-19" },
      { key: "b10", side: "BUY" as const, shares: 51, date: "2024-05-26" },
      { key: "b11", side: "BUY" as const, shares: 8, date: "2024-05-27" },
      { key: "b12", side: "BUY" as const, shares: 183, date: "2024-05-27" },
      { key: "s3", side: "SELL" as const, shares: 490, date: "2024-06-06" },
      { key: "b13", side: "BUY" as const, shares: 22, date: "2024-06-26" },
      { key: "b14", side: "BUY" as const, shares: 2, date: "2024-06-27" },
      { key: "b15", side: "BUY" as const, shares: 102, date: "2024-07-01" },
      { key: "s4", side: "SELL" as const, shares: 442, date: "2024-07-14" },
      { key: "b16", side: "BUY" as const, shares: 66, date: "2024-07-16" },
    ];

    const result = findLastBalancedDate({ rows, existingRemainingShares: 0 });
    expect(result?.date).toBe("2023-01-09");
    expect(result?.keysUpToHere).toEqual(["b1", "b2", "b3", "b4", "b5", "s1", "s2"]);
  });

  it("returns undefined when the imbalance starts from the very first row (no clean point to narrow down to)", () => {
    const rows = [
      { key: "b1", side: "BUY" as const, shares: 100, date: "2024-01-01" },
      { key: "b2", side: "BUY" as const, shares: 50, date: "2024-01-05" },
    ];
    expect(findLastBalancedDate({ rows, existingRemainingShares: 0 })).toBeUndefined();
  });

  it("returns undefined when the whole batch already balances (checkTickerMatch's own closed-position branch already covers this)", () => {
    const rows = [
      { key: "b1", side: "BUY" as const, shares: 100, date: "2024-01-01" },
      { key: "s1", side: "SELL" as const, shares: 100, date: "2024-01-05" },
    ];
    expect(findLastBalancedDate({ rows, existingRemainingShares: 0 })).toBeUndefined();
  });

  it("returns undefined for an empty batch", () => {
    expect(findLastBalancedDate({ rows: [], existingRemainingShares: 0 })).toBeUndefined();
  });

  it("starts the running total from existing on-ledger shares, not from 0", () => {
    // 30 already on the ledger; a pending Sell of 30 brings the true net to 0
    // right there, then a further pending Buy re-opens a gap that never closes.
    const rows = [
      { key: "s1", side: "SELL" as const, shares: 30, date: "2024-02-01" },
      { key: "b1", side: "BUY" as const, shares: 40, date: "2024-02-10" },
    ];
    const result = findLastBalancedDate({ rows, existingRemainingShares: 30 });
    expect(result?.date).toBe("2024-02-01");
    expect(result?.keysUpToHere).toEqual(["s1"]);
  });

  it("sorts out-of-order input rows chronologically before walking them", () => {
    const rows = [
      { key: "b2", side: "BUY" as const, shares: 20, date: "2024-03-01" },
      { key: "s1", side: "SELL" as const, shares: 10, date: "2024-01-01" },
      { key: "b1", side: "BUY" as const, shares: 10, date: "2024-01-01" },
    ];
    // Chronologically: b1(+10) -> s1(-10) -> 0, then b2(+20) -> 20, never returns to 0.
    const result = findLastBalancedDate({ rows, existingRemainingShares: 0 });
    expect(result?.date).toBe("2024-01-01");
    expect(result?.keysUpToHere.sort()).toEqual(["b1", "s1"]);
  });
});

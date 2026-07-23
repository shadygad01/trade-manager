// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { hasSharesToReconcile, isLotEligibleForSell } from "./ImportPage";

describe("hasSharesToReconcile", () => {
  it("does not treat a fully resolved zero-opening ticker as an uncorroborated closed position", () => {
    expect(hasSharesToReconcile(0, 0)).toBe(false);
  });

  it("still evaluates pending rows and existing open inventory", () => {
    expect(hasSharesToReconcile(1, 0)).toBe(true);
    expect(hasSharesToReconcile(0, 25)).toBe(true);
  });
});

describe("Smart Allocate chronology", () => {
  const sell = { ticker: "ABUK", side: "SELL" as const, shares: 190, price: 57.5, date: "2024-08-20", time: "11:00AM", confidence: "high" as const };

  it("never uses a purchase recorded after the sell", () => {
    expect(isLotEligibleForSell({ executionDate: "2026-06-28", executionTime: "10:00" }, sell)).toBe(false);
    expect(isLotEligibleForSell({ executionDate: "2024-08-20", executionTime: "11:01" }, sell)).toBe(false);
  });

  it("keeps earlier and unknown-time same-day purchases eligible", () => {
    expect(isLotEligibleForSell({ executionDate: "2024-08-20", executionTime: "10:59" }, sell)).toBe(true);
    expect(isLotEligibleForSell({ executionDate: "2024-08-20", executionTime: "00:00" }, sell)).toBe(true);
  });
});

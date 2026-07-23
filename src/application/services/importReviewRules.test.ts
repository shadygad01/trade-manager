import { describe, expect, it } from "vitest";
import { hasSharesToReconcile, isLotEligibleForSell, selectStillPendingCandidates } from "./importReviewRules";

describe("selectStillPendingCandidates", () => {
  const entries = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];

  it("keeps entries that are neither added, skipped, nor dismissed", () => {
    const result = selectStillPendingCandidates(entries, new Set(["a"]), new Set(["b"]), new Set(["c"]));
    expect(result).toEqual([{ key: "d" }]);
  });

  it("keeps everything when none of the sets match", () => {
    const result = selectStillPendingCandidates(entries, new Set(), new Set(), new Set());
    expect(result).toEqual(entries);
  });

  it("drops an entry present in more than one set without duplicating logic", () => {
    const result = selectStillPendingCandidates(entries, new Set(["a"]), new Set(["a"]), new Set());
    expect(result).toEqual([{ key: "b" }, { key: "c" }, { key: "d" }]);
  });
});

describe("hasSharesToReconcile", () => {
  it("is true when there are pending rows even with zero existing shares", () => {
    expect(hasSharesToReconcile(1, 0)).toBe(true);
  });

  it("is true when existing shares are non-trivial even with no pending rows", () => {
    expect(hasSharesToReconcile(0, 5)).toBe(true);
  });

  it("is false once both pending rows and existing shares are exhausted", () => {
    expect(hasSharesToReconcile(0, 0)).toBe(false);
  });
});

describe("isLotEligibleForSell", () => {
  it("rejects a lot bought after the sell's date", () => {
    expect(
      isLotEligibleForSell({ executionDate: "2026-01-02", executionTime: "10:00" }, { date: "2026-01-01" }),
    ).toBe(false);
  });

  it("accepts a lot bought before the sell's date", () => {
    expect(
      isLotEligibleForSell({ executionDate: "2026-01-01", executionTime: "10:00" }, { date: "2026-01-02" }),
    ).toBe(true);
  });

  it("on the same date, compares by time when both are known", () => {
    expect(
      isLotEligibleForSell(
        { executionDate: "2026-01-01", executionTime: "10:00" },
        { date: "2026-01-01", time: "09:00" },
      ),
    ).toBe(false);
    expect(
      isLotEligibleForSell(
        { executionDate: "2026-01-01", executionTime: "09:00" },
        { date: "2026-01-01", time: "10:00" },
      ),
    ).toBe(true);
  });
});

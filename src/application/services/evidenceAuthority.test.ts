import { describe, expect, it } from "vitest";
import { authorityRank, higherAuthority } from "./evidenceAuthority";

describe("evidenceAuthority", () => {
  it("ranks Invoice above Statement above Orders-screen above the shared Orders-timeline/Transactions/In-App-Invoice bucket", () => {
    expect(authorityRank("invoice")).toBeGreaterThan(authorityRank("statement"));
    expect(authorityRank("statement")).toBeGreaterThan(authorityRank("orders-screen"));
    expect(authorityRank("orders-screen")).toBeGreaterThan(authorityRank("orders-timeline"));
  });

  it("ranks manual/backfill lowest, and position-verification as unranked (never wins an execution-detail dispute)", () => {
    expect(authorityRank("manual")).toBe(0);
    expect(authorityRank("backfill")).toBe(0);
    expect(authorityRank("position-verification")).toBeLessThan(authorityRank("manual"));
  });

  it("higherAuthority picks Invoice over Statement for the same execution's fields", () => {
    expect(higherAuthority("invoice", "statement")).toBe("invoice");
    expect(higherAuthority("statement", "invoice")).toBe("invoice");
  });

  it("higherAuthority returns undefined for a tie (two reads of the same document type)", () => {
    expect(higherAuthority("statement", "statement")).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { computeCashProjection } from "./cashProjection";
import { createRawTransaction, type RawTransaction } from "@domain/entities/RawTransaction";

const PORTFOLIO = "p1";

function fact(seq: number, overrides: Partial<Omit<RawTransaction, "seq">> & Pick<RawTransaction, "kind" | "payload">): RawTransaction {
  return { ...createRawTransaction({ portfolioId: PORTFOLIO, source: "manual", ...overrides }), seq };
}

describe("computeCashProjection", () => {
  it("starts from zero and sums deposits/withdrawals when there is no CashReset", () => {
    const facts = [
      fact(1, { kind: "Deposit", payload: { amount: 1000, date: "2026-01-01" } }),
      fact(2, { kind: "Withdrawal", payload: { amount: 200, date: "2026-01-02" } }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBe(800);
  });

  it("subtracts a BuyExecution's full cost including fees and taxes", () => {
    const facts = [
      fact(1, { kind: "CashReset", payload: { amount: 10_000, asOfDate: "2026-01-01" } }),
      fact(2, { kind: "BuyExecution", payload: { ticker: "COMI", shares: 100, price: 40, fees: 10, taxes: 5, executionDate: "2026-01-05" } }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBe(10_000 - (100 * 40 + 10 + 5));
  });

  it("adds a SellExecution's net proceeds after fees and taxes", () => {
    const facts = [
      fact(1, { kind: "CashReset", payload: { amount: 0, asOfDate: "2026-01-01" } }),
      fact(2, { kind: "SellExecution", payload: { ticker: "COMI", shares: 50, price: 60, fees: 8, taxes: 2, executionDate: "2026-02-01" } }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBe(50 * 60 - 8 - 2);
  });

  it("adds DividendPayment and CashAdjustment amounts", () => {
    const facts = [
      fact(1, { kind: "CashReset", payload: { amount: 100, asOfDate: "2026-01-01" } }),
      fact(2, { kind: "DividendPayment", payload: { ticker: "PHAR", amount: 44.18, date: "2026-04-30" } }),
      fact(3, { kind: "CashAdjustment", payload: { amount: -50, notes: "bank fee", date: "2026-05-01" } }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBeCloseTo(100 + 44.18 - 50);
  });

  it("replays only facts strictly after the LATEST CashReset, ignoring everything before it", () => {
    const facts = [
      fact(1, { kind: "Deposit", payload: { amount: 5000, date: "2026-01-01" } }),
      fact(2, { kind: "CashReset", payload: { amount: 777, asOfDate: "2026-03-01" } }),
      fact(3, { kind: "Deposit", payload: { amount: 100, date: "2026-03-05" } }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBe(877);
  });

  it("uses the reset with the highest seq, not the one with the latest asOfDate, when multiple resets exist", () => {
    const facts = [
      fact(1, { kind: "CashReset", payload: { amount: 100, asOfDate: "2026-06-01" } }),
      fact(2, { kind: "CashReset", payload: { amount: 500, asOfDate: "2026-01-01" } }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBe(500);
  });

  it("ignores retracted facts entirely", () => {
    const dividend = fact(1, { kind: "DividendPayment", payload: { ticker: "PHAR", amount: 44.18, date: "2026-04-30" } });
    const retraction = fact(2, { kind: "Retraction", payload: { targetId: dividend.id, reason: "duplicate import" } });
    expect(computeCashProjection([dividend, retraction], PORTFOLIO)).toBe(0);
  });

  it("ignores facts belonging to a different portfolio", () => {
    const facts = [
      fact(1, { kind: "CashReset", payload: { amount: 100, asOfDate: "2026-01-01" }, portfolioId: "other" }),
      fact(2, { kind: "Deposit", payload: { amount: 5, date: "2026-01-02" }, portfolioId: "other" }),
    ];
    expect(computeCashProjection(facts, PORTFOLIO)).toBe(0);
  });

  it("returns 0 for a portfolio with no facts at all", () => {
    expect(computeCashProjection([], PORTFOLIO)).toBe(0);
  });
});

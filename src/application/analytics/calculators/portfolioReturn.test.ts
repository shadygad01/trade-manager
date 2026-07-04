import { describe, it, expect } from "vitest";
import { portfolioReturn } from "./portfolioReturn";

describe("portfolioReturn", () => {
  it("returns 0 when there have been no net contributions", () => {
    expect(portfolioReturn(0, 0, 0)).toBe(0);
  });

  it("computes a positive total return", () => {
    expect(portfolioReturn(1200, 1000, 0)).toBe(20);
  });

  it("computes a negative total return", () => {
    expect(portfolioReturn(800, 1000, 0)).toBe(-20);
  });

  it("nets withdrawals out of contributions before computing return", () => {
    expect(portfolioReturn(900, 1000, 200)).toBeCloseTo(((900 - 800) / 800) * 100);
  });
});

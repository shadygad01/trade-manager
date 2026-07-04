import { describe, it, expect } from "vitest";
import { cashRatio } from "./cashRatio";

describe("cashRatio", () => {
  it("returns 0 when total equity is 0", () => {
    expect(cashRatio(0, 0)).toBe(0);
  });

  it("returns 100 when fully in cash", () => {
    expect(cashRatio(1000, 1000)).toBe(100);
  });

  it("returns 0 when there is no cash", () => {
    expect(cashRatio(0, 1000)).toBe(0);
  });

  it("computes a partial cash ratio percentage", () => {
    expect(cashRatio(300, 1000)).toBe(30);
  });
});

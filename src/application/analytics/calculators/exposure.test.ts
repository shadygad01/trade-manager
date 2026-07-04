import { describe, it, expect } from "vitest";
import { exposure } from "./exposure";

describe("exposure", () => {
  it("returns 0 when total equity is 0", () => {
    expect(exposure(0, 0)).toBe(0);
  });

  it("returns 0 exposure when nothing is invested", () => {
    expect(exposure(0, 1000)).toBe(0);
  });

  it("returns 100 when fully invested", () => {
    expect(exposure(1000, 1000)).toBe(100);
  });

  it("computes a partial exposure percentage", () => {
    expect(exposure(250, 1000)).toBe(25);
  });
});

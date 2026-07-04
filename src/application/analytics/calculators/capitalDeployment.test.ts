import { describe, it, expect } from "vitest";
import { capitalDeployment } from "./capitalDeployment";

describe("capitalDeployment", () => {
  it("returns 0 when total equity is 0", () => {
    expect(capitalDeployment(0, 0)).toBe(0);
  });

  it("returns 0 when nothing is deployed", () => {
    expect(capitalDeployment(0, 5000)).toBe(0);
  });

  it("computes deployed capital as a percentage of equity", () => {
    expect(capitalDeployment(1500, 5000)).toBe(30);
  });
});

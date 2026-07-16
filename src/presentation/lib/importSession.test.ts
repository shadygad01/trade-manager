// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { importSession } from "./importSession";

describe("importSession terminal cleanup", () => {
  beforeEach(() => importSession.clear());

  it("clears and immediately persists a fully resolved session", () => {
    importSession.update((prev) => ({
      ...prev,
      pendingCandidates: [
        {
          key: "done-buy",
          candidate: {
            ticker: "COMI",
            side: "BUY",
            shares: 10,
            price: 50,
            date: "2026-07-01",
            confidence: "high",
            source: "official-broker-excel",
          },
        },
      ],
      addedKeys: ["done-buy"],
      filesProcessed: 1,
    }));

    expect(importSession.clearIfFullyResolved()).toBe(true);
    expect(importSession.getState().pendingCandidates).toEqual([]);
    expect(JSON.parse(localStorage.getItem("portfolio-os:import-session") ?? "{}").pendingCandidates).toEqual([]);
  });

  it("preserves the session when any actionable row is unresolved", () => {
    importSession.update((prev) => ({
      ...prev,
      pendingCandidates: [
        {
          key: "pending-buy",
          candidate: {
            ticker: "COMI",
            side: "BUY",
            shares: 10,
            price: 50,
            date: "2026-07-01",
            confidence: "high",
            source: "statement",
          },
        },
      ],
    }));

    expect(importSession.clearIfFullyResolved()).toBe(false);
    expect(importSession.getState().pendingCandidates).toHaveLength(1);
  });
});

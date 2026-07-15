// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { importJob } from "./importJob";

describe("importJob", () => {
  beforeEach(() => {
    importJob.clear();
    localStorage.clear();
  });

  it("persists resumable ticker progress and terminal status", () => {
    importJob.start(["ABUK", "ADIB"]);
    importJob.markTickerStarted("ABUK");
    importJob.markTickerComplete("ABUK");

    expect(importJob.getState()?.completedTickers).toEqual(["ABUK"]);
    expect(JSON.parse(localStorage.getItem("portfolio-os:import-job") ?? "{}").completedTickers).toEqual(["ABUK"]);

    importJob.complete();
    expect(importJob.getState()?.status).toBe("completed");
  });
});

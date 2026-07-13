// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { diagnosticCaseRepository } from "@presentation/lib/data";

describe("DiagnosticsPage", () => {
  it("shows the empty-state placeholder when no cases have been recorded (Phase 1: no detection engine runs yet)", async () => {
    render(<DiagnosticsPage />);

    expect(await screen.findByText("No diagnostic cases recorded yet.")).toBeInTheDocument();
  });

  it("lists recorded cases by severity and trigger type once any exist", async () => {
    await diagnosticCaseRepository.replaceForGroupKeys([
      {
        id: crypto.randomUUID(),
        groupKey: "g1",
        severity: "ERROR",
        triggerType: "Mismatch",
        firstOccurrenceEventSeq: 1,
        latestOccurrenceEventSeq: 1,
        occurrenceCount: 1,
        ticker: "COMI",
        context: { browser: "Chrome", browserVersion: "120", appVersion: "0.1.0", schemaVersion: 5, featureFlags: [] },
      },
    ]);

    render(<DiagnosticsPage />);

    expect(await screen.findByText(/ERROR/)).toBeInTheDocument();
    expect(await screen.findByText(/Mismatch/)).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { diagnosticCaseRepository, diagnosticEventRepository } from "@presentation/lib/data";
import type { SessionEventRecord, WriteTraceRecord } from "@domain/entities/diagnostics/DiagnosticEvent";

describe("DiagnosticsPage", () => {
  it("shows both empty-state placeholders when nothing has been recorded (Phase 1: no detection engine runs yet)", async () => {
    render(<DiagnosticsPage />);

    expect(await screen.findByText("No diagnostic cases recorded yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run reconciliation sweep" })).toBeInTheDocument();
    expect(
      await screen.findByText(/No events recorded yet/)
    ).toBeInTheDocument();
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

  it("lists recorded events, summarized by kind", async () => {
    const sessionEvent: Omit<SessionEventRecord, "seq"> = {
      id: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      sessionId: "s1",
      kind: "SessionEvent",
      workflowStep: "ManualEdit",
      label: "Record Buy submitted",
    };
    await diagnosticEventRepository.append(sessionEvent);

    const writeEvent: Omit<WriteTraceRecord, "seq"> = {
      id: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      sessionId: "s1",
      kind: "WriteTrace",
      writer: "TradeService.ts",
      function: "ensureBuyFact",
      file: "src/application/services/TradeService.ts",
      table: "rawTransactions",
      objectId: "t1",
      valueSource: "reference",
      reason: "Wrote the BuyExecution fact backing a manually-recorded Buy",
    };
    await diagnosticEventRepository.append(writeEvent);

    render(<DiagnosticsPage />);

    expect(await screen.findByText(/Record Buy submitted/)).toBeInTheDocument();
    expect(await screen.findByText(/ensureBuyFact/)).toBeInTheDocument();
  });
});

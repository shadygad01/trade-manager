// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CandidateRow } from "./ImportPage";
import type { CandidateEntry } from "@presentation/lib/importSession";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

function makeEntry(confidence: ParsedTradeCandidate["confidence"]): CandidateEntry {
  return {
    key: "k1",
    candidate: {
      ticker: "COMI",
      side: "SELL",
      shares: 10,
      price: 50,
      date: "2026-01-05",
      confidence,
    },
  };
}

// CandidateRow is Sell-only now — Buy/Dividend/Verification auto-commit
// (see ImportPage's AutoCommitRow instead). Allocating a sell always opens
// the allocation modal for review, so a low-confidence sell is flagged
// visually but the action stays clickable rather than gated behind a
// checkbox — the modal itself is the review step.
describe("CandidateRow — Sell allocation action", () => {
  it("is always clickable for a high-confidence candidate, with no low-confidence flag", () => {
    const onAction = vi.fn();
    render(
      <CandidateRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        actionLabel="Allocate Sell"
        actionClassName="bg-rose-500"
        onAction={onAction}
      />,
    );
    const button = screen.getByRole("button", { name: "Allocate Sell" });
    expect(button).toBeEnabled();
    expect(screen.queryByText("Low-confidence ticker guess")).not.toBeInTheDocument();
  });

  it("flags a low-confidence candidate visually but keeps the action clickable", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <CandidateRow
        entry={makeEntry("low")}
        match={undefined}
        added={false}
        actionLabel="Allocate Sell"
        actionClassName="bg-rose-500"
        onAction={onAction}
      />,
    );
    expect(screen.getByText("Low-confidence ticker guess")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Allocate Sell" });
    expect(button).toBeEnabled();

    await user.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("shows an Added status instead of the action once added", () => {
    render(
      <CandidateRow
        entry={makeEntry("high")}
        match={undefined}
        added
        actionLabel="Allocate Sell"
        actionClassName="bg-rose-500"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allocate Sell" })).not.toBeInTheDocument();
  });
});

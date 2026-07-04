// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoCommitRow } from "./ImportPage";
import type { CandidateEntry } from "@presentation/lib/importSession";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

function makeEntry(confidence: ParsedTradeCandidate["confidence"]): CandidateEntry {
  return {
    key: "k1",
    candidate: {
      ticker: "COMI",
      side: "BUY",
      shares: 10,
      price: 50,
      date: "2026-01-05",
      confidence,
    },
  };
}

describe("AutoCommitRow — Buy auto-commit status (no manual button)", () => {
  it("shows 'Waiting for portfolio' when the ticker's portfolio isn't resolved yet", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed={false}
        portfolioResolved={false}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Waiting for portfolio")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an 'Adding…' status once the portfolio resolves, with no button to click", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed={false}
        portfolioResolved
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Adding…")).toBeInTheDocument();
  });

  it("flags a low-confidence row visually and offers a delete action once added", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <AutoCommitRow
        entry={makeEntry("low")}
        match={undefined}
        added
        skipped={false}
        dismissed={false}
        portfolioResolved
        onDelete={onDelete}
      />,
    );
    expect(screen.getByText("Low-confidence ticker guess")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    const deleteButton = screen.getByTitle("Delete this trade and refund its cost");
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("does not offer a delete action for a high-confidence added row", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added
        skipped={false}
        dismissed={false}
        portfolioResolved
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByTitle("Delete this trade and refund its cost")).not.toBeInTheDocument();
  });

  it("shows 'Skipped — duplicate' for an exact-duplicate buy that was auto-skipped", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={{ matchType: "exact", matchedId: "t1" }}
        added={false}
        skipped
        dismissed={false}
        portfolioResolved
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Skipped — duplicate")).toBeInTheDocument();
  });

  it("shows 'Removed' after the user deletes an auto-added row", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed
        portfolioResolved
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });
});

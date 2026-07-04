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

describe("AutoCommitRow — Buy batch-commit status", () => {
  it("shows 'Blocked — needs verification' when the ticker hasn't matched a broker screenshot yet, with a manual remove button available", async () => {
    const user = userEvent.setup();
    const onDiscardPending = vi.fn();
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed={false}
        portfolioResolved
        matched={false}
        distributing={false}
        onDelete={vi.fn()}
        onDiscardPending={onDiscardPending}
      />,
    );
    expect(screen.getByText("Blocked — needs verification")).toBeInTheDocument();
    const removeButton = screen.getByTitle(/remove this row from the pending list/i);
    await user.click(removeButton);
    expect(onDiscardPending).toHaveBeenCalledTimes(1);
  });

  it("shows 'Waiting for portfolio' when matched but the ticker's portfolio isn't resolved yet", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed={false}
        portfolioResolved={false}
        matched
        distributing={false}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Waiting for portfolio")).toBeInTheDocument();
  });

  it("shows 'Ready — click Confirm above' once matched and portfolio-resolved, before the Confirm button is clicked", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed={false}
        portfolioResolved
        matched
        distributing={false}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Ready — click Confirm above")).toBeInTheDocument();
  });

  it("shows an 'Adding…' status while confirmAndDistributeAll is committing, with no button to click", () => {
    render(
      <AutoCommitRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        skipped={false}
        dismissed={false}
        portfolioResolved
        matched
        distributing
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
        matched
        distributing={false}
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
        matched
        distributing={false}
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
        matched
        distributing={false}
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
        matched
        distributing={false}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });
});

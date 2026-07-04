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
      side: "BUY",
      shares: 10,
      price: 50,
      date: "2026-01-05",
      confidence,
    },
  };
}

describe("CandidateRow — confidence-aware confirmation gate", () => {
  it("enables the action immediately for a high-confidence candidate", () => {
    const onAction = vi.fn();
    render(
      <CandidateRow
        entry={makeEntry("high")}
        match={undefined}
        added={false}
        actionLabel="Add as Trade"
        actionClassName="bg-emerald-500"
        onAction={onAction}
      />,
    );
    const button = screen.getByRole("button", { name: "Add as Trade" });
    expect(button).toBeEnabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("disables the action for a low-confidence candidate until the user confirms it", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <CandidateRow
        entry={makeEntry("low")}
        match={undefined}
        added={false}
        actionLabel="Add as Trade"
        actionClassName="bg-emerald-500"
        onAction={onAction}
      />,
    );
    const button = screen.getByRole("button", { name: "Add as Trade" });
    const checkbox = screen.getByRole("checkbox");
    expect(button).toBeDisabled();

    await user.click(button);
    expect(onAction).not.toHaveBeenCalled();

    await user.click(checkbox);
    expect(button).toBeEnabled();

    await user.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

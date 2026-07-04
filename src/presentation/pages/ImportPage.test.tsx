// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TickerGroupCard } from "./ImportPage";
import type { CandidateEntry } from "@presentation/lib/importSession";

const PORTFOLIOS = [
  { id: "p-smc", name: "smc test" },
  { id: "p-long", name: "long invest" },
];

function buyEntry(key: string): CandidateEntry {
  return {
    key,
    candidate: { ticker: "SKPC", side: "BUY", shares: 30, price: 14.97, date: "2026-01-13", confidence: "high" },
  };
}

function sellEntry(key: string): CandidateEntry {
  return {
    key,
    candidate: { ticker: "SKPC", side: "SELL", shares: 82, price: 15.49, date: "2026-01-27", confidence: "high" },
  };
}

describe("TickerGroupCard — portfolio picker for a brand-new ticker in more than one portfolio", () => {
  it("does not silently pre-select the first portfolio — shows an honest placeholder instead", () => {
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{ buys: [buyEntry("b1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId=""
        portfolioResolved={false}
        matchStatus={{ matched: true, reason: "closed-position", netShares: 0 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        onDeleteAutoAdded={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByText("Select a portfolio…")).toBeInTheDocument();
    expect(screen.getByText(/This ticker is new to more than one of your portfolios/)).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for portfolio").length).toBeGreaterThan(0);
  });

  it("picking a portfolio the user wants actually fires onPortfolioChange, even though it's the first option in the list", async () => {
    const user = userEvent.setup();
    const onPortfolioChange = vi.fn();
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{ buys: [buyEntry("b1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId=""
        portfolioResolved={false}
        matchStatus={{ matched: true, reason: "closed-position", netShares: 0 }}
        distributing={false}
        onPortfolioChange={onPortfolioChange}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        onDeleteAutoAdded={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "smc test");
    expect(onPortfolioChange).toHaveBeenCalledWith("p-smc");
  });

  it("blocks Allocate Sell until a portfolio is actually picked, even when the ticker's share count already matches", () => {
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{ buys: [], sells: [sellEntry("s1")], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId=""
        portfolioResolved={false}
        matchStatus={{ matched: true, reason: "matched", netShares: 82, verifiedUnits: 82 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        onDeleteAutoAdded={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    const button = screen.getByRole("button", { name: "Allocate Sell" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Pick a portfolio above first.");
  });

  it("once resolved, shows the picked portfolio selected and enables Allocate Sell", () => {
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{ buys: [], sells: [sellEntry("s1")], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: true, reason: "matched", netShares: 82, verifiedUnits: 82 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        onDeleteAutoAdded={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("p-smc");
    expect(screen.queryByText("Select a portfolio…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allocate Sell" })).not.toBeDisabled();
  });
});

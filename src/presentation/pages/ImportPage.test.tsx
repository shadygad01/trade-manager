// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TickerGroupCard } from "./ImportPage";
import type { CandidateEntry, OrderEvidenceEntry } from "@presentation/lib/importSession";

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

describe("TickerGroupCard — invoice-sourced Buy needs no separate broker screenshot", () => {
  it("shows 'Verified by invoice' and lets the row proceed straight to Ready, with no Mismatch/blocked messaging", () => {
    render(
      <TickerGroupCard
        ticker="ABUK"
        group={{ buys: [buyEntry("abuk-invoice")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: true, reason: "invoice-verified", netShares: 37 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Verified by invoice")).toBeInTheDocument();
    expect(screen.getByText("Ready — click Confirm above")).toBeInTheDocument();
    expect(screen.queryByText(/Mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No broker "My Position" screenshot/)).not.toBeInTheDocument();
    expect(screen.queryByText("Blocked — needs verification")).not.toBeInTheDocument();
  });
});

describe("TickerGroupCard — cross-verified (an OCR screenshot corroborated by an independent invoice, the ORHD case)", () => {
  it("shows 'Verified — two documents agree' and lets the rows proceed straight to Ready", () => {
    render(
      <TickerGroupCard
        ticker="ORHD"
        group={{ buys: [buyEntry("orhd-screenshot"), buyEntry("orhd-invoice")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: true, reason: "cross-verified", netShares: 10 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Verified — two documents agree")).toBeInTheDocument();
    expect(screen.getAllByText("Ready — click Confirm above").length).toBe(2);
    expect(screen.queryByText(/Mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByText("Blocked — needs verification")).not.toBeInTheDocument();
  });
});

describe("TickerGroupCard — a pending Sell exceeding the ledger's available shares (the SKPC shortfall case)", () => {
  it("badges 'Missing buy history' and explains the shortfall instead of asking for a My Position screenshot", () => {
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{ buys: [], sells: [sellEntry("s1")], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: false, reason: "no-verification", netShares: -70, existingRemainingShares: 12 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Missing buy history")).toBeInTheDocument();
    expect(screen.queryByText(/No broker "My Position" screenshot/)).not.toBeInTheDocument();
    expect(screen.getByText(/Pending Sell\(s\) for SKPC total 82 shares/)).toBeInTheDocument();
    expect(screen.getByText(/70 short/)).toBeInTheDocument();
  });
});

describe("TickerGroupCard — no-verification banner surfaces the current net share total", () => {
  it("shows the exact net so a user chasing a closed position can tell how far it is from 0", () => {
    render(
      <TickerGroupCard
        ticker="JUFO"
        group={{ buys: [buyEntry("b1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: false, reason: "no-verification", netShares: 236 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/Current net from the rows below: 236 shares/)).toBeInTheDocument();
  });

  it("also suggests the last fully-balanced date, narrowing the search to whatever's dated after it (the real ISPH shape)", () => {
    function entry(key: string, side: "BUY" | "SELL", shares: number, date: string): CandidateEntry {
      return { key, candidate: { ticker: "ISPH", side, shares, price: 2.5, date, confidence: "high" } };
    }
    render(
      <TickerGroupCard
        ticker="ISPH"
        group={{
          buys: [entry("b1", "BUY", 2000, "2023-01-05"), entry("b2", "BUY", 450, "2024-03-28")],
          sells: [entry("s1", "SELL", 2000, "2023-01-09")],
          verifications: [],
          dividends: [],
        }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: false, reason: "no-verification", netShares: 450 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/Current net from the rows below: 450 shares/)).toBeInTheDocument();
    expect(screen.getByText(/every row through .* already nets to exactly 0/)).toBeInTheDocument();
  });
});

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
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
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
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
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
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
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
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
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

describe("TickerGroupCard — within-batch duplicate candidates (the PHAR mismatch case)", () => {
  it("flags a still-pending Buy suggested as a within-batch duplicate, and Discard removes just that row", async () => {
    const user = userEvent.setup();
    const onDiscardPending = vi.fn();
    const keep = buyEntry("keep");
    const dupe = buyEntry("dupe");
    render(
      <TickerGroupCard
        ticker="PHAR"
        group={{ buys: [keep, dupe], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 60, verifiedUnits: 30 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set(["dupe"])}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={onDiscardPending}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Suspected duplicate")).toBeInTheDocument();
    const discardButton = screen.getByRole("button", { name: /Discard/ });
    await user.click(discardButton);
    expect(onDiscardPending).toHaveBeenCalledWith(dupe);
  });

  it("flags a still-pending Sell suggested as a within-batch duplicate, and Discard removes just that row", async () => {
    const user = userEvent.setup();
    const onDiscardPending = vi.fn();
    const dupe = sellEntry("s-dupe");
    render(
      <TickerGroupCard
        ticker="PHAR"
        group={{ buys: [], sells: [dupe], verifications: [], dividends: [] }}
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
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set(["s-dupe"])}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={onDiscardPending}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Suspected duplicate")).toBeInTheDocument();
    const discardButton = screen.getByTitle("Discard this duplicate row — it was never committed, so there's nothing to refund");
    await user.click(discardButton);
    expect(onDiscardPending).toHaveBeenCalledWith(dupe);
  });

  it("shows Discard (not a redundant 'Suspected duplicate' badge) for a lone pending row that duplicates a trade already committed to the ledger (the ARCC case)", async () => {
    const user = userEvent.setup();
    const onDiscardPending = vi.fn();
    const arcc = buyEntry("arcc-1");
    render(
      <TickerGroupCard
        ticker="ARCC"
        group={{ buys: [arcc], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 84, verifiedUnits: 42 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => ({ matchType: "possible", matchedId: "existing-trade-1" })}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set(["arcc-1"])}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={onDiscardPending}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
    expect(screen.queryByText("Suspected duplicate")).not.toBeInTheDocument();
    const discardButton = screen.getByRole("button", { name: /Discard/ });
    await user.click(discardButton);
    expect(onDiscardPending).toHaveBeenCalledWith(arcc);
  });

  it("does not show a Suspected duplicate badge or Discard button for a clean (non-flagged) row", () => {
    render(
      <TickerGroupCard
        ticker="PHAR"
        group={{ buys: [buyEntry("clean")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: true, reason: "matched", netShares: 30, verifiedUnits: 30 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.queryByText("Suspected duplicate")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  it("lets the user manually remove any unflagged pending row on an otherwise-unresolvable Mismatch (the ORHD case)", async () => {
    const user = userEvent.setup();
    const onDiscardPending = vi.fn();
    const entry = buyEntry("orhd-suspect");
    render(
      <TickerGroupCard
        ticker="ORHD"
        group={{ buys: [entry], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 99, verifiedUnits: 74 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={onDiscardPending}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.queryByText("Suspected duplicate")).not.toBeInTheDocument();
    const removeButton = screen.getByTitle(/remove this row from the pending list/i);
    await user.click(removeButton);
    expect(onDiscardPending).toHaveBeenCalledWith(entry);
  });
});

describe("TickerGroupCard — a bulk re-upload the ledger already accounts for (the EAST/ORAS mismatch case)", () => {
  it("offers to discard every pending row at once when the ledger alone already reconciles with the broker", async () => {
    const user = userEvent.setup();
    const onDiscardAllPending = vi.fn();
    render(
      <TickerGroupCard
        ticker="EAST"
        group={{
          buys: [buyEntry("e1"), buyEntry("e2"), buyEntry("e3"), buyEntry("e4"), buyEntry("e5")],
          sells: [],
          verifications: [],
          dividends: [],
        }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 350, verifiedUnits: 175, alreadyFullyRecorded: true }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={onDiscardAllPending}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/already matches the broker's count on its own/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Discard all pending for EAST" });
    await user.click(button);
    expect(onDiscardAllPending).toHaveBeenCalledTimes(1);
  });

  it("shows the plain Mismatch banner (no bulk-discard offer) for a genuine mismatch the ledger doesn't already explain", () => {
    render(
      <TickerGroupCard
        ticker="ORHD"
        group={{ buys: [buyEntry("o1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 99, verifiedUnits: 74 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/upload an Orders screenshot to confirm the exact transaction count/)).toBeInTheDocument();
    expect(screen.queryByText("Discard all pending for ORHD")).not.toBeInTheDocument();
  });

  it("offers to replace an opening-balance placeholder with the batch's real dated rows instead of discarding them (the CSAG case)", async () => {
    const user = userEvent.setup();
    const onReplacePlaceholder = vi.fn();
    const onDiscardAllPending = vi.fn();
    render(
      <TickerGroupCard
        ticker="CSAG"
        group={{ buys: [buyEntry("real-1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{
          matched: false,
          reason: "mismatch",
          netShares: 408,
          existingRemainingShares: 204,
          verifiedUnits: 204,
          alreadyFullyRecorded: true,
        }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        placeholderReplacement
        onReplacePlaceholder={onReplacePlaceholder}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={onDiscardAllPending}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/recorded position is an opening-balance placeholder/)).toBeInTheDocument();
    expect(screen.queryByText("Discard all pending for CSAG")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replace placeholder with real rows" }));
    expect(onReplacePlaceholder).toHaveBeenCalledTimes(1);
    expect(onDiscardAllPending).not.toHaveBeenCalled();
  });
});

describe("TickerGroupCard — mismatch auto-reconcile suggestion (the ORHD 99-vs-74 case)", () => {
  it("highlights the solver's suggested rows and removes exactly them on one click", async () => {
    const user = userEvent.setup();
    const onDiscardPendingKeys = vi.fn();
    const keep = buyEntry("keep");
    const remove = buyEntry("remove");
    render(
      <TickerGroupCard
        ticker="ORHD"
        group={{ buys: [keep, remove], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 60, verifiedUnits: 30 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        reconcileSuggestion={{ keysToRemove: ["remove"], alternatives: 1, rankedByAvgCost: true }}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardPendingKeys={onDiscardPendingKeys}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/lands closest to the broker's avg cost/)).toBeInTheDocument();
    expect(screen.getByText(/1 other combination would also reconcile/)).toBeInTheDocument();
    expect(screen.getByText("Suggested removal")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Remove suggested row/ }));
    expect(onDiscardPendingKeys).toHaveBeenCalledWith(["remove"]);
  });

  it("badges a pending row that looks like another ticker's transaction read under a wrong ticker guess (the HRHO/Delta Sugar case)", () => {
    render(
      <TickerGroupCard
        ticker="HRHO"
        group={{ buys: [buyEntry("phantom")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: false, reason: "no-verification", netShares: 30 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        wrongTickerHints={new Map([["phantom", "SUGR"]])}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Likely SUGR's transaction")).toBeInTheDocument();
  });
});

describe("TickerGroupCard — reconciliation transparency and company-name-fallback rename", () => {
  it("shows the existing + batch = broker breakdown when a verified count includes invisible ledger shares (the ORHD 20+54=74 case)", () => {
    render(
      <TickerGroupCard
        ticker="ORHD"
        group={{ buys: [buyEntry("b1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: true, reason: "matched", netShares: 74, existingRemainingShares: 20, verifiedUnits: 74 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText(/20 already on the ledger \+ 54 in this batch = 74/)).toBeInTheDocument();
  });

  it("offers a one-click rename when the group's 'ticker' is a known company name (the DELTA SUGAR case)", async () => {
    const user = userEvent.setup();
    const onRenameTicker = vi.fn();
    render(
      <TickerGroupCard
        ticker="DELTA SUGAR"
        group={{ buys: [buyEntry("d1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: true, reason: "closed-position", netShares: 0 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={onRenameTicker}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
        knownTickerSuggestion="SUGR"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Rename to SUGR" }));
    expect(onRenameTicker).toHaveBeenCalledWith("SUGR");
  });

  it("excludes a committed sell's own allocations from its duplicate check (the MEDINET Added+Duplicate case)", () => {
    const duplicateMatch = vi.fn(() => undefined);
    const entry = sellEntry("s1");
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{ buys: [], sells: [entry], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-smc"
        portfolioResolved
        matchStatus={{ matched: true, reason: "matched", netShares: 0, verifiedUnits: 0 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set(["s1"])}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={duplicateMatch}
        addedTradeIds={{}}
        addedAllocationIds={{ s1: ["alloc-1", "alloc-2"] }}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={undefined}
        mergeSuggestion={undefined}
      />,
    );
    expect(duplicateMatch).toHaveBeenCalledWith(entry.candidate, undefined, ["alloc-1", "alloc-2"]);
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate")).not.toBeInTheDocument();
  });
});

describe("TickerGroupCard — per-ticker Confirm (the ORWE case: verified but blocked by an unrelated stuck ticker)", () => {
  it("shows a Confirm {ticker} button once matched and portfolio-resolved, independent of any other ticker", async () => {
    const user = userEvent.setup();
    const onConfirmTicker = vi.fn();
    render(
      <TickerGroupCard
        ticker="ORWE"
        group={{ buys: [buyEntry("o1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: true, reason: "matched", netShares: 177, verifiedUnits: 177 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={onConfirmTicker}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    const button = screen.getByRole("button", { name: "Confirm ORWE" });
    await user.click(button);
    expect(onConfirmTicker).toHaveBeenCalledTimes(1);
  });

  it("does not show a Confirm button while the ticker is still unmatched", () => {
    render(
      <TickerGroupCard
        ticker="ORHD"
        group={{ buys: [buyEntry("o1")], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 99, verifiedUnits: 74 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Confirm ORHD" })).not.toBeInTheDocument();
  });
});

describe("TickerGroupCard — an added Buy never shows a false self-duplicate badge", () => {
  it("passes the row's own committed trade id to duplicateMatch, so a successful commit excludes itself from the comparison", () => {
    const duplicateMatch = vi.fn(() => undefined);
    const added = buyEntry("added-1");
    render(
      <TickerGroupCard
        ticker="ORWE"
        group={{ buys: [added], sells: [], verifications: [], dividends: [] }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: true, reason: "matched", netShares: 177, verifiedUnits: 177 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set(["added-1"])}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={duplicateMatch}
        addedTradeIds={{ "added-1": "trade-abc" }}
        suspectedDuplicateKeys={new Set()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(duplicateMatch).toHaveBeenCalledWith(added.candidate, "trade-abc");
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate")).not.toBeInTheDocument();
  });
});

describe("TickerGroupCard — Orders timeline evidence", () => {
  function orderEvidenceEntry(key: string, overrides: Partial<OrderEvidenceEntry["evidence"]> = {}): OrderEvidenceEntry {
    return {
      key,
      evidence: {
        ticker: "SKPC",
        side: "BUY",
        orderType: "limit",
        shares: 30,
        price: 14.85,
        totalValue: 445.5,
        status: "fulfilled",
        confidence: "high",
        ...overrides,
      },
    };
  }

  it("shows 'Verified — matches Orders history' plus the evidence rows, with the corroborated Buy badged", () => {
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{
          buys: [buyEntry("skpc-b1")],
          sells: [],
          verifications: [],
          dividends: [],
          orderEvidences: [orderEvidenceEntry("skpc-o1"), orderEvidenceEntry("skpc-o2", { status: "cancelled" })],
        }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: true, reason: "orders-verified", netShares: 30 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        orderConfirmedKeys={new Set(["skpc-b1"])}
        onDiscardOrderEvidence={vi.fn()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Verified — matches Orders history")).toBeInTheDocument();
    expect(screen.getByText("Matches Orders history")).toBeInTheDocument();
    expect(screen.getByText("Ready — click Confirm above")).toBeInTheDocument();
    expect(screen.getByText("Fulfilled")).toBeInTheDocument();
    // Cancelled orders never render during manual review — a struck-through
    // BUY/SELL line still reads like a transaction and invites recording
    // something that never executed.
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching order")).not.toBeInTheDocument();
  });

  it("on a mismatch, badges the row no fulfilled order matches and lets a misread evidence row be discarded", async () => {
    const user = userEvent.setup();
    const onDiscardOrderEvidence = vi.fn();
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{
          buys: [buyEntry("skpc-good"), buyEntry("skpc-extra")],
          sells: [],
          verifications: [],
          dividends: [],
          orderEvidences: [orderEvidenceEntry("skpc-o1")],
        }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "mismatch", netShares: 60, verifiedUnits: 30 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        orderConfirmedKeys={new Set(["skpc-good"])}
        onDiscardOrderEvidence={onDiscardOrderEvidence}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Matches Orders history")).toBeInTheDocument();
    expect(screen.getByText("No matching order")).toBeInTheDocument();
    await user.click(screen.getByTitle(/Remove this order row if it was misread/));
    expect(onDiscardOrderEvidence).toHaveBeenCalledWith(expect.objectContaining({ key: "skpc-o1" }));
  });

  it("also badges the unconfirmed row on a no-verification ticker (e.g. a closed position with no My Position screen to ever upload) — not just on a mismatch", () => {
    render(
      <TickerGroupCard
        ticker="SKPC"
        group={{
          buys: [buyEntry("skpc-good"), buyEntry("skpc-extra")],
          sells: [],
          verifications: [],
          dividends: [],
          orderEvidences: [orderEvidenceEntry("skpc-o1")],
        }}
        portfolios={PORTFOLIOS}
        portfolioId="p-long"
        portfolioResolved
        matchStatus={{ matched: false, reason: "no-verification", netShares: 60 }}
        distributing={false}
        onPortfolioChange={vi.fn()}
        addedKeys={new Set()}
        acceptedKeys={new Set()}
        skippedKeys={new Set()}
        dismissedKeys={new Set()}
        rowErrors={{}}
        duplicateMatch={() => undefined}
        addedTradeIds={{}}
        suspectedDuplicateKeys={new Set()}
        orderConfirmedKeys={new Set(["skpc-good"])}
        onDiscardOrderEvidence={vi.fn()}
        onDeleteAutoAdded={vi.fn()}
        onDiscardPending={vi.fn()}
        onDiscardAllPending={vi.fn()}
        onConfirmTicker={vi.fn()}
        onAllocateSell={vi.fn()}
        onRenameTicker={vi.fn()}
        existingPortfolioHint={{ multiple: false, names: ["long invest"] }}
        mergeSuggestion={undefined}
      />,
    );
    expect(screen.getByText("Matches Orders history")).toBeInTheDocument();
    expect(screen.getByText("No matching order")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import { createTrade } from "@domain/entities/Trade";
import type { Upload, ParsedTradeCandidate } from "@domain/entities/Upload";
import type { Portfolio } from "@domain/entities/Portfolio";
import { RebuildLedgerPanel } from "./RebuildLedgerPanel";

function upload(id: string, candidates: ParsedTradeCandidate[]): Upload {
  return { id, fileName: `${id}.png`, fileHash: id, contentType: "image/png", status: "parsed", candidates, createdAt: "2026-01-01T00:00:00Z" };
}
function portfolio(id = "p1"): Portfolio {
  return { id, name: "Main", kind: "Investment", currency: "EGP", cash: 100_000, createdAt: "2026-01-01T00:00:00Z" };
}

let fakeRepos: ReturnType<typeof createFakeRepositories>;

vi.mock("@presentation/lib/data", () => ({
  get repos() {
    return fakeRepos;
  },
}));

describe("RebuildLedgerPanel", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a missing trade after Dry Run, adds it once a portfolio is chosen and Apply is confirmed", async () => {
    const user = userEvent.setup();
    fakeRepos = createFakeRepositories({
      portfolios: [portfolio()],
      uploads: [upload("u1", [{ ticker: "COMI", side: "BUY", shares: 100, price: 10, date: "2026-01-05" }])],
    });
    render(<RebuildLedgerPanel />);

    await user.click(screen.getByText("Run Dry Run"));
    expect(await screen.findByText(/Trades missing from the ledger \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/COMI · Buy 100/)).toBeInTheDocument();

    const applyButton = screen.getByText("Apply Reviewed Changes");
    expect(applyButton).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox"), "p1");
    expect(applyButton).toBeEnabled();

    await user.click(applyButton);
    await waitFor(() => expect(screen.getByText(/Added 1, removed 0, corrected 0/)).toBeInTheDocument());

    const trades = await fakeRepos.trades.getAll();
    expect(trades).toHaveLength(1);
    expect(trades[0].ticker).toBe("COMI");
  });

  it("never offers an Apply action for sell-side findings — they render as informational text only", async () => {
    const user = userEvent.setup();
    fakeRepos = createFakeRepositories({
      portfolios: [portfolio()],
      uploads: [upload("u1", [{ ticker: "COMI", side: "SELL", shares: 100, price: 12, date: "2026-01-10" }])],
    });
    render(<RebuildLedgerPanel />);
    await user.click(screen.getByText("Run Dry Run"));
    expect(await screen.findByText(/Sell orders missing from the ledger \(1\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/never inferred by FIFO or average cost/).length).toBeGreaterThan(0);
    // No checkbox/select is rendered for the sell finding itself.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("pre-checks only auto-applicable trade corrections, leaving a cash-affecting one unchecked and disabled", async () => {
    const user = userEvent.setup();
    const safeTrade = createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", companyName: "Old", shares: 100, entryPrice: 10, executionDate: "2026-01-05", executionTime: "10:00" });
    const cashTrade = createTrade({ id: "t2", portfolioId: "p1", ticker: "EAST", shares: 50, entryPrice: 99, executionDate: "2026-02-01", executionTime: "10:00" });
    fakeRepos = createFakeRepositories({
      portfolios: [portfolio()],
      trades: [safeTrade, cashTrade],
      uploads: [
        upload("u1", [
          { ticker: "COMI", side: "BUY", shares: 100, price: 10, date: "2026-01-05", companyName: "Commercial International Bank" },
          { ticker: "EAST", side: "BUY", shares: 50, price: 20, date: "2026-02-01" },
        ]),
      ],
    });
    render(<RebuildLedgerPanel />);
    await user.click(screen.getByText("Run Dry Run"));
    expect(await screen.findByText(/Trades whose recorded fields disagree.*\(2\)/)).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const checked = checkboxes.filter((c) => c.checked);
    const disabled = checkboxes.filter((c) => c.disabled);
    expect(checked).toHaveLength(1);
    expect(disabled).toHaveLength(1);
  });
});

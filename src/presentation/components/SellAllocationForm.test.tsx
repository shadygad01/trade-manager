// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";

/** Same mocking seam PortfolioDetailPage.test.tsx/PortfoliosPage.test.tsx use: mock the module-level `repos` singleton so recordSell (real, unmocked) runs against in-memory arrays instead of a real IndexedDB. */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  allocations: [] as TradeAllocation[],
}));

vi.mock("@presentation/lib/data", () => ({
  diagnostics: { recordSessionEvent() {}, recordWrite() {}, recordRead() {}, recordDecision() {}, recordRuleExecution() {}, recordPerfSample() {} },
  repos: {
    portfolios: {
      getById: (id: string) => Promise.resolve(state.portfolios.find((p) => p.id === id)),
      getAll: () => Promise.resolve(state.portfolios),
      save: (p: Portfolio) => {
        const i = state.portfolios.findIndex((existing) => existing.id === p.id);
        if (i >= 0) state.portfolios[i] = p;
        else state.portfolios.push(p);
        return Promise.resolve();
      },
    },
    trades: {
      getByPortfolio: (portfolioId: string) => Promise.resolve(state.trades.filter((t) => t.portfolioId === portfolioId)),
      getAll: () => Promise.resolve(state.trades),
      getById: (id: string) => Promise.resolve(state.trades.find((t) => t.id === id)),
      save: (t: Trade) => {
        const i = state.trades.findIndex((existing) => existing.id === t.id);
        if (i >= 0) state.trades[i] = t;
        else state.trades.push(t);
        return Promise.resolve();
      },
      saveRemainingShares: (id: string, remainingShares: number) => {
        const t = state.trades.find((existing) => existing.id === id);
        if (t) t.remainingShares = remainingShares;
        return Promise.resolve();
      },
    },
    allocations: {
      getByPortfolio: (portfolioId: string) => Promise.resolve(state.allocations.filter((a) => a.portfolioId === portfolioId)),
      save: (a: TradeAllocation) => {
        state.allocations.push(a);
        return Promise.resolve();
      },
    },
    timeline: { save: () => Promise.resolve() },
  },
}));

const { SellAllocationForm } = await import("./SellAllocationForm");

function seedTwoLots() {
  state.portfolios = [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1_000_000 })];
  state.trades = [
    createTrade({
      id: "t-300",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 300,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:00",
    }),
    createTrade({
      id: "t-700",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 700,
      entryPrice: 52,
      executionDate: "2026-01-06",
      executionTime: "10:00",
    }),
  ];
  state.allocations = [];
}

describe("SellAllocationForm — splitting one sell across multiple open lots", () => {
  it("lets the user check both lots, edit each lot's close-shares independently, and records both allocations on submit", async () => {
    seedTwoLots();
    const user = userEvent.setup();
    const onDone = vi.fn();

    render(
      <SellAllocationForm
        portfolioId="p1"
        ticker="COMI"
        onDone={onDone}
        initial={{ exitPrice: 60 }}
      />,
    );

    // Both open lots must be visible.
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
    const checkboxes = screen.getAllByRole("checkbox");

    // Check the first lot — its close-shares input should auto-fill with its full remaining (300).
    await user.click(checkboxes[0]);
    const rows = screen.getAllByRole("row").slice(1); // skip header row
    const input0 = rows[0].querySelector('input[type="number"]') as HTMLInputElement;
    expect(input0.disabled).toBe(false);
    expect(input0.value).toBe("300");

    // Check the second lot too — this is the exact scenario reported: can the
    // user select BOTH lots for one sell and edit their split independently?
    await user.click(checkboxes[1]);
    const input1 = rows[1].querySelector('input[type="number"]') as HTMLInputElement;
    expect(input1.value).toBe("700");

    // Total selected across both lots should read 1,000.
    expect(screen.getByText(/1,000 of 1,000/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Record Sell/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.allocations).toHaveLength(2);
    expect(state.allocations.map((a) => a.sharesClosed).sort((a, b) => a - b)).toEqual([300, 700]);
    expect(new Set(state.allocations.map((a) => a.sellGroupId)).size).toBe(1); // one sell order, shared sellGroupId
    const t300 = state.trades.find((t) => t.id === "t-300")!;
    const t700 = state.trades.find((t) => t.id === "t-700")!;
    expect(t300.remainingShares).toBe(0);
    expect(t700.remainingShares).toBe(0);
  });

  it("lets the user override the auto-filled max and split a lot's shares (not just take the whole lot)", async () => {
    seedTwoLots();
    const user = userEvent.setup();
    const onDone = vi.fn();

    render(<SellAllocationForm portfolioId="p1" ticker="COMI" onDone={onDone} initial={{ exitPrice: 60 }} />);

    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]); // the 700-share lot

    const rows = screen.getAllByRole("row").slice(1);
    const input1 = rows[1].querySelector('input[type="number"]') as HTMLInputElement;
    expect(input1.value).toBe("700");

    // Manually reduce it to a partial close (only sell 400 of the 700 lot).
    await user.clear(input1);
    await user.type(input1, "400");
    expect(input1.value).toBe("400");

    await user.click(screen.getByRole("button", { name: /Record Sell/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(state.allocations).toHaveLength(1);
    expect(state.allocations[0].sharesClosed).toBe(400);
    const t700 = state.trades.find((t) => t.id === "t-700")!;
    expect(t700.remainingShares).toBe(300); // 700 - 400
  });
});

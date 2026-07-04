// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * Same mocking seam as PortfoliosPage.test.tsx: mock the module-level `repos`
 * singleton so computePositions/reconcilePositions/deleteTrade (all real,
 * unmocked) run against in-memory arrays instead of a real IndexedDB.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  verifications: [] as PositionVerification[],
}));

vi.mock("@presentation/lib/data", () => ({
  repos: {
    portfolios: {
      getById: (id: string) => Promise.resolve(state.portfolios.find((p) => p.id === id)),
      save: (p: Portfolio) => {
        const i = state.portfolios.findIndex((existing) => existing.id === p.id);
        if (i >= 0) state.portfolios[i] = p;
        else state.portfolios.push(p);
        return Promise.resolve();
      },
    },
    trades: {
      getByPortfolio: (portfolioId: string) => Promise.resolve(state.trades.filter((t) => t.portfolioId === portfolioId)),
      getById: (id: string) => Promise.resolve(state.trades.find((t) => t.id === id)),
      save: (t: Trade) => {
        const i = state.trades.findIndex((existing) => existing.id === t.id);
        if (i >= 0) state.trades[i] = t;
        else state.trades.push(t);
        return Promise.resolve();
      },
      delete: (id: string) => {
        state.trades = state.trades.filter((t) => t.id !== id);
        return Promise.resolve();
      },
    },
    allocations: { getByPortfolio: () => Promise.resolve([]) },
    verifications: {
      getByPortfolio: (portfolioId: string) => Promise.resolve(state.verifications.filter((v) => v.portfolioId === portfolioId)),
    },
    timeline: {
      getByPortfolio: () => Promise.resolve([]),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    journal: { getByTrade: () => Promise.resolve(undefined) },
    prices: { getAllPrices: () => Promise.resolve({}), getSnapshotInfo: () => Promise.resolve(undefined) },
  },
}));

const { PortfolioDetailPage } = await import("./PortfolioDetailPage");

function renderPage(portfolioId: string) {
  const { hook, searchHook } = memoryLocation({ path: `/portfolios/${portfolioId}`, static: true });
  return render(
    <Router hook={hook} searchHook={searchHook}>
      <Route path="/portfolios/:id">
        <PortfolioDetailPage />
      </Route>
    </Router>,
  );
}

describe("PortfolioDetailPage — Clear all suspected duplicates", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Dup Test", kind: "Trading", initialCash: 1_000_000 })];
    state.trades = [];
    state.verifications = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("resolves every mismatched ticker in one click, keeping the higher-priced trade", async () => {
    state.trades = [
      createTrade({ id: "comi-hi", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 50, executionDate: "2026-01-05", executionTime: "10:00" }),
      createTrade({ id: "comi-lo", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 48, executionDate: "2026-01-05", executionTime: "10:00" }),
      createTrade({ id: "hrho-hi", portfolioId: "p1", ticker: "HRHO", shares: 50, entryPrice: 30, executionDate: "2026-01-06", executionTime: "10:00" }),
      createTrade({ id: "hrho-lo", portfolioId: "p1", ticker: "HRHO", shares: 50, entryPrice: 29, executionDate: "2026-01-06", executionTime: "10:00" }),
    ];
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-06-01T00:00", source: "screenshot" },
      { id: "v2", portfolioId: "p1", ticker: "HRHO", units: 50, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];

    const user = userEvent.setup();
    renderPage("p1");

    const clearButton = await screen.findByRole("button", { name: /clear all suspected duplicates \(2\)/i });
    await user.click(clearButton);

    await waitFor(() => {
      expect(state.trades.map((t) => t.id).sort()).toEqual(["comi-hi", "hrho-hi"]);
    });
    expect(state.portfolios[0].cash).toBeCloseTo(1_000_000 + 100 * 48 + 50 * 29);
    expect(screen.queryByRole("button", { name: /clear all suspected duplicates/i })).not.toBeInTheDocument();
  });

  it("clears every duplicate for a ticker with more than one, in a single click", async () => {
    // Same real 100-share buy imported three times: one real trade (kept,
    // highest price) plus two duplicates that both must go in one pass.
    state.trades = [
      createTrade({ id: "keep", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 50, executionDate: "2026-01-05", executionTime: "10:00" }),
      createTrade({ id: "dup1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 48, executionDate: "2026-01-05", executionTime: "10:00" }),
      createTrade({ id: "dup2", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 47, executionDate: "2026-01-05", executionTime: "10:00" }),
    ];
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];

    const user = userEvent.setup();
    renderPage("p1");

    const clearButton = await screen.findByRole("button", { name: /clear all suspected duplicates \(2\)/i });
    await user.click(clearButton);

    await waitFor(() => {
      expect(state.trades.map((t) => t.id)).toEqual(["keep"]);
    });
    expect(await screen.findByText("Matches broker")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear all suspected duplicates/i })).not.toBeInTheDocument();
  });

  it("does not show the button when no ticker is mismatched", async () => {
    state.trades = [
      createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 100, entryPrice: 50, executionDate: "2026-01-05", executionTime: "10:00" }),
    ];
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "COMI", units: 100, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];

    renderPage("p1");

    await screen.findByText("COMI");
    expect(screen.queryByRole("button", { name: /clear all suspected duplicates/i })).not.toBeInTheDocument();
  });
});

describe("PortfolioDetailPage — Record opening balance for a verified-but-untracked position", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Opening Balance Test", kind: "Trading", initialCash: 1_000 })];
    state.trades = [];
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "TMGH", units: 35, avgCost: 76.68, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("books a Trade at the tracking floor using the broker's units/avg cost", async () => {
    const user = userEvent.setup();
    renderPage("p1");

    const recordButton = await screen.findByRole("button", { name: /record as opening balance/i });
    await user.click(recordButton);

    await waitFor(() => {
      expect(state.trades).toHaveLength(1);
    });
    const [trade] = state.trades;
    expect(trade.ticker).toBe("TMGH");
    expect(trade.shares).toBe(35);
    expect(trade.entryPrice).toBeCloseTo(76.68);
    expect(trade.executionDate).toBe("2026-01-01");
    expect(state.portfolios[0].cash).toBeCloseTo(1_000 - 35 * 76.68);
    expect(screen.queryByRole("button", { name: /record as opening balance/i })).not.toBeInTheDocument();
  });

  it("has no action when the broker screenshot didn't include an average cost", async () => {
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "TMGH", units: 35, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];
    renderPage("p1");

    await screen.findByText(/TMGH/);
    expect(screen.queryByRole("button", { name: /record as opening balance/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/no average cost/i)).toBeInTheDocument();
  });
});

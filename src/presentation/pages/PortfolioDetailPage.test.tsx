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
      delete: (id: string) => {
        state.verifications = state.verifications.filter((v) => v.id !== id);
        return Promise.resolve();
      },
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

describe("PortfolioDetailPage — a verified-but-untracked position points at Import, never a placeholder", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Opening Balance Test", kind: "Trading", initialCash: 1_000 })];
    state.trades = [];
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "TMGH", units: 35, avgCost: 76.68, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];
  });

  it("lists the ticker with guidance to import its real dated buys — the opening-balance shortcut is gone", async () => {
    renderPage("p1");

    expect(await screen.findByText(/TMGH: the broker screenshot shows/)).toBeInTheDocument();
    expect(await screen.findByText(/upload this ticker's buy\s*invoices\/statement in Import/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record as opening balance/i })).not.toBeInTheDocument();
    expect(state.trades).toHaveLength(0);
  });

  it("discards a stray verification misfiled against this portfolio (the ABUK/Long Positions case)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage("p1");

    expect(await screen.findByText(/TMGH: the broker screenshot shows/)).toBeInTheDocument();

    await user.click(screen.getByTitle(/discard this verification/i));

    await waitFor(() => {
      expect(state.verifications).toHaveLength(0);
    });
  });

  it("discards every stray verification for the ticker, not just the single latest one shown", async () => {
    // Two separate misfiled readings for the same ticker — deleting only the
    // one reconcilePositions currently surfaces would leave the other behind
    // under the same ticker, and the banner row would look unchanged.
    state.verifications = [
      { id: "v1", portfolioId: "p1", ticker: "TMGH", units: 35, avgCost: 76.68, capturedAt: "2026-05-01T00:00", source: "screenshot" },
      { id: "v2", portfolioId: "p1", ticker: "TMGH", units: 35, avgCost: 76.68, capturedAt: "2026-06-01T00:00", source: "screenshot" },
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage("p1");

    expect(await screen.findByText(/TMGH: the broker screenshot shows/)).toBeInTheDocument();

    await user.click(screen.getByTitle(/discard this verification/i));

    await waitFor(() => {
      expect(state.verifications).toHaveLength(0);
    });
  });
});

describe("PortfolioDetailPage — Edit Cash", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Cash Edit Test", kind: "Trading", initialCash: 413_154.06 })];
    state.trades = [];
    state.verifications = [];
  });

  it("lets a cleared field be typed into without snapping back to the old balance", async () => {
    const user = userEvent.setup();
    renderPage("p1");

    await user.click(await screen.findByRole("button", { name: /edit cash/i }));
    const input = await screen.findByLabelText(/cash balance/i);
    expect(input).toHaveValue(413154.06);

    await user.clear(input);
    expect(input).toHaveValue(null); // cleared, not reverted to 413154.06
    await user.type(input, "500000");
    expect(input).toHaveValue(500000);
  });

  it("saves the newly typed balance, not the pre-fill", async () => {
    const user = userEvent.setup();
    renderPage("p1");

    await user.click(await screen.findByRole("button", { name: /edit cash/i }));
    const input = await screen.findByLabelText(/cash balance/i);
    await user.clear(input);
    await user.type(input, "500000");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(state.portfolios[0].cash).toBe(500000);
    });
  });
});

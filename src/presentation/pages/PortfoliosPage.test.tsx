// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTrade, type Trade } from "@domain/entities/Trade";
import type { PositionVerification } from "@domain/entities/PositionVerification";

/**
 * PortfoliosPage reads through the module-level `repos` singleton
 * (`@presentation/lib/data`), the same seam the app itself uses to swap a
 * real Dexie-backed implementation in at runtime — mocking that module is
 * the natural test boundary, rather than standing up a real IndexedDB.
 * `computePositions`/`consolidateTicker` (real, unmocked) still run against
 * the mocked repos, so this exercises the actual application-layer logic,
 * not a stub.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  trades: [] as Trade[],
  verifications: [] as PositionVerification[],
}));

vi.mock("@presentation/lib/data", () => ({
  repos: {
    portfolios: {
      getAll: () => Promise.resolve(state.portfolios),
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
      getAll: () => Promise.resolve(state.trades),
      getById: (id: string) => Promise.resolve(state.trades.find((t) => t.id === id)),
      save: (t: Trade) => {
        const i = state.trades.findIndex((existing) => existing.id === t.id);
        if (i >= 0) state.trades[i] = t;
        else state.trades.push(t);
        return Promise.resolve();
      },
    },
    allocations: { getByPortfolio: () => Promise.resolve([]) },
    timeline: { getByPortfolio: () => Promise.resolve([]), save: () => Promise.resolve() },
    verifications: {
      getAll: () => Promise.resolve(state.verifications),
      save: (v: PositionVerification) => {
        const i = state.verifications.findIndex((existing) => existing.id === v.id);
        if (i >= 0) state.verifications[i] = v;
        else state.verifications.push(v);
        return Promise.resolve();
      },
    },
    prices: { getAllPrices: () => Promise.resolve({}), getSnapshotInfo: () => Promise.resolve(undefined) },
  },
}));

const { PortfoliosPage } = await import("./PortfoliosPage");

function renderPage() {
  return render(
    <Router>
      <PortfoliosPage />
    </Router>,
  );
}

describe("PortfoliosPage", () => {
  beforeEach(() => {
    state.portfolios = [];
    state.trades = [];
    state.verifications = [];
  });

  it("shows the empty state when there are no portfolios", async () => {
    renderPage();
    expect(await screen.findByText("No portfolios yet")).toBeInTheDocument();
  });

  it("lists active portfolios and keeps archived ones collapsed behind a toggle", async () => {
    state.portfolios = [
      createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 }),
      { ...createPortfolio({ id: "p2", name: "Old Fund", kind: "Investment", initialCash: 500 }), archivedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Main")).toBeInTheDocument();
    expect(screen.queryByText("Old Fund")).not.toBeInTheDocument();
    expect(screen.getByText("Archived (1)")).toBeInTheDocument();

    await user.click(screen.getByText("Archived (1)"));
    expect(await screen.findByText("Old Fund")).toBeInTheDocument();
  });

  it("clicking Unarchive calls through to clear archivedAt on the right portfolio", async () => {
    // dexie-react-hooks' useLiveQuery reactivity depends on real Dexie
    // mutation events to know when to re-run — a plain mocked repos object
    // (by design, the seam this test mocks at) can't trigger that, so this
    // asserts the actual data effect of the click rather than a post-click
    // re-render, which would only be testing dexie-react-hooks/Dexie itself.
    state.portfolios = [
      { ...createPortfolio({ id: "p1", name: "Old Fund", kind: "Investment", initialCash: 500 }), archivedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText("Archived (1)"));
    await user.click(await screen.findByRole("button", { name: /unarchive/i }));

    expect(state.portfolios[0].archivedAt).toBeUndefined();
  });

  it("flags a ticker split across portfolios and consolidates it on click", async () => {
    state.portfolios = [
      createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 10_000 }),
      createPortfolio({ id: "p2", name: "Other", kind: "Trading", initialCash: 10_000 }),
    ];
    state.trades = [
      createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 50, entryPrice: 40, executionDate: "2026-01-05", executionTime: "10:00" }),
      createTrade({ id: "t2", portfolioId: "p2", ticker: "COMI", shares: 30, entryPrice: 42, executionDate: "2026-01-06", executionTime: "10:00" }),
    ];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Stocks split across portfolios")).toBeInTheDocument();
    expect(screen.getByText(/COMI/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /consolidate/i }));

    // Assert on the actual data effect (mirrors the Unarchive test's approach
    // above) rather than the banner's disappearance, since the mocked repos
    // can't trigger dexie-react-hooks' live-query re-run.
    await waitFor(() => {
      expect(state.trades.every((t) => t.portfolioId === "p1")).toBe(true);
    });
  });

  it("does not show the split-tickers banner when every ticker is in one portfolio", async () => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 10_000 })];
    state.trades = [
      createTrade({ id: "t1", portfolioId: "p1", ticker: "COMI", shares: 50, entryPrice: 40, executionDate: "2026-01-05", executionTime: "10:00" }),
    ];
    renderPage();

    await screen.findByText("Main");
    expect(screen.queryByText("Stocks split across portfolios")).not.toBeInTheDocument();
  });
});

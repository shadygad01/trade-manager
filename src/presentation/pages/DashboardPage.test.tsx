// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { createPortfolio } from "@domain/entities/Portfolio";

/**
 * Same seam PortfoliosPage.test.tsx mocks (@presentation/lib/data's repos
 * singleton) so computePositions/computeAnalytics/sectorAllocation all run
 * for real against fully-mocked repository objects, rather than a stub.
 *
 * jsdom reports zero layout size for recharts' ResponsiveContainer (see
 * setupTests.ts's ResizeObserver stub), so its actual pie slices/legend
 * text aren't reliably testable here — this file only covers the two
 * states that render independently of chart layout: the page-level empty
 * state and the panel's own "no positions" empty state.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as ReturnType<typeof import("@domain/entities/Portfolio").createPortfolio>[],
}));

vi.mock("@presentation/lib/data", () => ({
  repos: {
    portfolios: { getAll: () => Promise.resolve(state.portfolios) },
    trades: { getByPortfolio: () => Promise.resolve([]) },
    tradeAllocations: { getByPortfolio: () => Promise.resolve([]) },
    timeline: { getByPortfolio: () => Promise.resolve([]) },
    prices: { getAllPrices: () => Promise.resolve({}), getSnapshotInfo: () => Promise.resolve(undefined) },
  },
}));

const { DashboardPage, indexEquityCurve } = await import("./DashboardPage");

function renderPage() {
  return render(
    <Router>
      <DashboardPage />
    </Router>,
  );
}

describe("DashboardPage — Sector Allocation panel", () => {
  beforeEach(() => {
    state.portfolios = [];
  });

  it("shows the top-level empty state when there are no portfolios at all", async () => {
    renderPage();
    expect(await screen.findByText("No portfolios yet")).toBeInTheDocument();
  });

  it("shows a Sector Allocation empty state when a portfolio has no open positions", async () => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })];
    renderPage();

    expect(await screen.findByText("Sector Allocation")).toBeInTheDocument();
    expect(await screen.findByText("No open positions yet")).toBeInTheDocument();
  });
});

describe("indexEquityCurve — Portfolio Comparison's growth-% rebasing", () => {
  it("does not blow up into a many-thousand-percent spike when the account started near-zero and a real deposit lands later (the reported bug)", () => {
    // Mirrors the reported shape: an account effectively starting at ~34 EGP,
    // then a real 10,000 EGP deposit landing later with no trading gain/loss
    // in between — the old base-equity-ratio index would read this as
    // ~29,000%; contributed-capital indexing should read it as 0% (the
    // deposit is new capital, not a gain).
    const curve = [
      { date: "2026-01-08", equity: 33.58, contributed: 0 },
      { date: "2026-01-31", equity: 10033.58, contributed: 10000 },
    ];
    const indexed = indexEquityCurve(curve);
    expect(indexed[0].index).toBe(100);
    expect(indexed[1].index).toBeCloseTo(100.3358, 2);
  });

  it("stays at 100 while no capital has been contributed yet", () => {
    const curve = [{ date: "2026-01-08", equity: 33.58, contributed: 0 }];
    expect(indexEquityCurve(curve)).toEqual([{ date: "2026-01-08", index: 100 }]);
  });

  it("moves the index for a real gain/loss on already-contributed capital", () => {
    const curve = [
      { date: "2026-01-01", equity: 10000, contributed: 10000 },
      { date: "2026-02-01", equity: 11000, contributed: 10000 },
    ];
    const indexed = indexEquityCurve(curve);
    expect(indexed[0].index).toBe(100);
    expect(indexed[1].index).toBe(110);
  });
});

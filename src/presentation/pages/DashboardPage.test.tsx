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
    trades: { getByPortfolio: () => Promise.resolve([]), getAll: () => Promise.resolve([]) },
    tradeAllocations: { getByPortfolio: () => Promise.resolve([]) },
    timeline: { getByPortfolio: () => Promise.resolve([]) },
    prices: {
      getAllPrices: () => Promise.resolve({}),
      getSnapshotInfo: () => Promise.resolve(undefined),
      getPriceHistory: () => Promise.resolve({}),
    },
  },
}));

const { DashboardPage, mergeComparisonCurves, mergeMonthlyPerformance, UNREALIZED_AVG_KEY } = await import("./DashboardPage");

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

describe("mergeComparisonCurves — Portfolio Comparison, without any equity-curve indexing", () => {
  it("combines each portfolio's own realized + dividend return % directly, no rebasing needed", () => {
    const data = mergeComparisonCurves([
      {
        name: "Old School",
        curve: [
          { date: "2026-01-01", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 3 },
          { date: "2026-02-01", realizedReturnPct: 5, dividendReturnPct: 1, unrealizedReturnPct: 4 },
        ],
      },
      {
        name: "Long Positions",
        curve: [{ date: "2026-01-15", realizedReturnPct: 2, dividendReturnPct: 0, unrealizedReturnPct: 1 }],
      },
    ]);
    expect(data).toEqual([
      { date: "2026-01-01", "Old School": 0, [UNREALIZED_AVG_KEY]: 3 },
      { date: "2026-01-15", "Old School": 0, "Long Positions": 2, [UNREALIZED_AVG_KEY]: 2 },
      { date: "2026-02-01", "Old School": 6, "Long Positions": 2, [UNREALIZED_AVG_KEY]: 2.5 },
    ]);
  });
});

describe("mergeMonthlyPerformance — averages realized + dividend + unrealized % across portfolios", () => {
  it("never reads a deposit or a near-zero starting balance as a fake return (the reported bug)", () => {
    // Reproduces the reported shape at the merge level: a portfolio whose
    // performance curve never involves cash/equity at all can't spike from
    // a deposit landing mid-period — there's nothing here that touches cash.
    const merged = mergeMonthlyPerformance([
      [{ period: "2026-07", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 0 }],
      [{ period: "2026-07", realizedReturnPct: 4, dividendReturnPct: 1, unrealizedReturnPct: 0 }],
    ]);
    expect(merged).toEqual([{ period: "2026-07", returnPct: 2.5 }]);
  });

  it("includes each portfolio's own unrealized % in the average, not just realized+dividend", () => {
    const merged = mergeMonthlyPerformance([
      [{ period: "2026-07", realizedReturnPct: 0, dividendReturnPct: 0, unrealizedReturnPct: 10 }],
      [{ period: "2026-07", realizedReturnPct: 4, dividendReturnPct: 1, unrealizedReturnPct: 0 }],
    ]);
    expect(merged).toEqual([{ period: "2026-07", returnPct: 7.5 }]); // (10 + 5) / 2
  });
});

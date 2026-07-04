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

const { DashboardPage } = await import("./DashboardPage");

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

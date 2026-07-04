// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { createPortfolio } from "@domain/entities/Portfolio";

/**
 * PortfoliosPage reads through the module-level `repos` singleton
 * (`@presentation/lib/data`), the same seam the app itself uses to swap a
 * real Dexie-backed implementation in at runtime — mocking that module is
 * the natural test boundary, rather than standing up a real IndexedDB.
 * `computePositions` (real, unmocked) still runs against the mocked repos,
 * so this exercises the actual application-layer aggregation, not a stub.
 */
const state = vi.hoisted(() => ({ portfolios: [] as ReturnType<typeof import("@domain/entities/Portfolio").createPortfolio>[] }));

vi.mock("@presentation/lib/data", () => ({
  repos: {
    portfolios: {
      getAll: () => Promise.resolve(state.portfolios),
      getById: (id: string) => Promise.resolve(state.portfolios.find((p) => p.id === id)),
      save: (p: (typeof state.portfolios)[number]) => {
        const i = state.portfolios.findIndex((existing) => existing.id === p.id);
        if (i >= 0) state.portfolios[i] = p;
        else state.portfolios.push(p);
        return Promise.resolve();
      },
    },
    trades: { getByPortfolio: () => Promise.resolve([]) },
    prices: { getAllPrices: () => Promise.resolve({}) },
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
});

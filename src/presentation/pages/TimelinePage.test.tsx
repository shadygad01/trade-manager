// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { createPortfolio, type Portfolio } from "@domain/entities/Portfolio";
import { createTimelineEvent, type TimelineEvent } from "@domain/entities/TimelineEvent";

/**
 * Same mocking seam as PortfolioDetailPage.test.tsx: mock the module-level
 * `repos` singleton so deleteDividend (real, unmocked) runs against
 * in-memory arrays instead of a real IndexedDB.
 */
const state = vi.hoisted(() => ({
  portfolios: [] as Portfolio[],
  events: [] as TimelineEvent[],
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
    timeline: {
      getByPortfolio: (portfolioId: string) => Promise.resolve(state.events.filter((e) => e.portfolioId === portfolioId)),
      delete: (id: string) => {
        state.events = state.events.filter((e) => e.id !== id);
        return Promise.resolve();
      },
    },
  },
}));

const { TimelinePage } = await import("./TimelinePage");

function renderPage(portfolioId: string) {
  const { hook, searchHook } = memoryLocation({ path: `/portfolios/${portfolioId}/timeline`, static: true });
  return render(
    <Router hook={hook} searchHook={searchHook}>
      <Route path="/portfolios/:id/timeline">
        <TimelinePage />
      </Route>
    </Router>,
  );
}

describe("TimelinePage — dividend duplicates", () => {
  beforeEach(() => {
    state.portfolios = [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })];
    state.events = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("flags duplicate dividends and clears them all in one click, refunding cash", async () => {
    state.portfolios[0].cash = 1114;
    state.events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
    ];
    const user = userEvent.setup();
    renderPage("p1");

    expect(await screen.findAllByText("Suspected duplicate")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /clear duplicate dividends \(1\)/i }));

    // Assert the actual data effect (mirrors the other pages' bulk-clear
    // tests) rather than the button's disappearance, since the mocked repos
    // can't trigger dexie-react-hooks' live-query re-run.
    await waitFor(() => {
      expect(state.events).toHaveLength(1);
    });
    expect(state.portfolios[0].cash).toBe(1000);
  });

  it("deletes a single dividend via its row action and refunds cash", async () => {
    state.portfolios[0].cash = 1025;
    state.events = [createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 25 })];
    const user = userEvent.setup();
    renderPage("p1");

    await screen.findByText(/Dividend/);
    await user.click(screen.getByTitle(/delete this dividend/i));

    await waitFor(() => {
      expect(state.events).toHaveLength(0);
    });
    expect(state.portfolios[0].cash).toBe(1000);
  });

  it("does not flag or show a clear button when no dividends are duplicated", async () => {
    state.events = [createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 25 })];
    renderPage("p1");

    await screen.findByText(/Dividend/);
    expect(screen.queryByText("Suspected duplicate")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear duplicate dividends/i })).not.toBeInTheDocument();
  });
});

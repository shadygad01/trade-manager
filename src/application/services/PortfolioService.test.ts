import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import {
  createPortfolioAndSave,
  setCash,
  recordDividend,
  deleteDividend,
  recordCashAdjustment,
  recordSplit,
  recordRightsIssue,
  archivePortfolio,
  unarchivePortfolio,
  renamePortfolio,
} from "./PortfolioService";

describe("createPortfolioAndSave", () => {
  it("persists a new portfolio with initial cash and no timeline event at all", async () => {
    const repos = createFakeRepositories();
    const portfolio = await createPortfolioAndSave(repos, { name: "Main", kind: "Trading", initialCash: 5000 });
    expect(portfolio.cash).toBe(5000);
    expect(await repos.portfolios.getById(portfolio.id)).toEqual(portfolio);
    expect(await repos.timeline.getByPortfolio(portfolio.id)).toHaveLength(0);
  });
});

describe("archivePortfolio / unarchivePortfolio", () => {
  it("sets archivedAt without touching cash or any other field", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const archived = await archivePortfolio(repos, "p1");
    expect(archived.archivedAt).toBeDefined();
    expect(archived.cash).toBe(1000);
    expect((await repos.portfolios.getById("p1"))?.archivedAt).toBeDefined();
  });

  it("unarchiving clears archivedAt", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await archivePortfolio(repos, "p1");
    const unarchived = await unarchivePortfolio(repos, "p1");
    expect(unarchived.archivedAt).toBeUndefined();
    expect((await repos.portfolios.getById("p1"))?.archivedAt).toBeUndefined();
  });
});

describe("renamePortfolio", () => {
  it("updates the name without touching cash or any other field", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const renamed = await renamePortfolio(repos, "p1", "Retirement Fund");
    expect(renamed.name).toBe("Retirement Fund");
    expect(renamed.cash).toBe(1000);
    expect((await repos.portfolios.getById("p1"))?.name).toBe("Retirement Fund");
  });

  it("trims whitespace and rejects an empty name", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const renamed = await renamePortfolio(repos, "p1", "  Trading  ");
    expect(renamed.name).toBe("Trading");
    await expect(renamePortfolio(repos, "p1", "   ")).rejects.toThrow(/name/i);
  });
});

describe("setCash", () => {
  it("directly sets the cash balance to any value, with no timeline event at all", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const updated = await setCash(repos, "p1", 7500);
    expect(updated.cash).toBe(7500);
    expect((await repos.portfolios.getById("p1"))?.cash).toBe(7500);
    expect(await repos.timeline.getByPortfolio("p1")).toHaveLength(0);
  });

  it("allows setting cash to a negative value", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const updated = await setCash(repos, "p1", -200);
    expect(updated.cash).toBe(-200);
  });
});

describe("recordDividend", () => {
  it("adds cash and appends a Dividend event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const updated = await recordDividend(repos, "p1", { ticker: "comi.ca", amount: 25 });
    expect(updated.cash).toBe(1025);
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events[0].type).toBe("Dividend");
    expect(events[0].ticker).toBe("COMI");
  });

  it("dates the timeline event to a provided historical date instead of now", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await recordDividend(repos, "p1", { ticker: "EAST", amount: 64.98, date: "2026-06-28" });
    const [event] = await repos.timeline.getByPortfolio("p1");
    expect(event.timestamp).toBe("2026-06-28T00:00");
  });

  it("rejects a dividend dated before the 2026-01-01 tracking start", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await expect(recordDividend(repos, "p1", { ticker: "EAST", amount: 64.98, date: "2025-12-31" })).rejects.toThrow(
      /2026-01-01/
    );
  });
});

describe("deleteDividend", () => {
  it("refunds the dividend amount out of cash and removes the timeline event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await recordDividend(repos, "p1", { ticker: "COMI", amount: 25 });
    const [event] = await repos.timeline.getByPortfolio("p1");

    await deleteDividend(repos, event);

    expect((await repos.portfolios.getById("p1"))?.cash).toBe(1000);
    expect(await repos.timeline.getByPortfolio("p1")).toHaveLength(0);
  });

  it("rejects a non-Dividend event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await recordCashAdjustment(repos, "p1", 500, "top-up");
    const [event] = await repos.timeline.getByPortfolio("p1");

    await expect(deleteDividend(repos, event)).rejects.toThrow(/non-Dividend/i);
  });
});

describe("recordCashAdjustment", () => {
  it("applies a signed adjustment and appends a CashAdjustment event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const updated = await recordCashAdjustment(repos, "p1", -30, "broker fee correction");
    expect(updated.cash).toBe(970);
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events[0].type).toBe("CashAdjustment");
    expect(events[0].notes).toBe("broker fee correction");
  });
});

describe("recordSplit / recordRightsIssue", () => {
  it("records a Split as a timeline-only event without touching cash or trades", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await recordSplit(repos, "p1", { ticker: "COMI", notes: "2-for-1 split" });
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events[0].type).toBe("Split");
    expect(events[0].notes).toBe("2-for-1 split");
    expect((await repos.portfolios.getById("p1"))?.cash).toBe(1000);
  });

  it("records a RightsIssue as a timeline-only event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    await recordRightsIssue(repos, "p1", { ticker: "COMI", notes: "1-for-4 at 10 EGP" });
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events[0].type).toBe("RightsIssue");
  });
});

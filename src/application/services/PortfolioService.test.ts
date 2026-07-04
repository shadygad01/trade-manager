import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { createFakeRepositories } from "@application/testUtils/fakeRepositories";
import {
  createPortfolioAndSave,
  deposit,
  withdraw,
  recordDividend,
  recordCashAdjustment,
  recordSplit,
  recordRightsIssue,
} from "./PortfolioService";

describe("createPortfolioAndSave", () => {
  it("persists a new portfolio with initial cash", async () => {
    const repos = createFakeRepositories();
    const portfolio = await createPortfolioAndSave(repos, { name: "Main", kind: "Trading", initialCash: 5000 });
    expect(portfolio.cash).toBe(5000);
    expect(await repos.portfolios.getById(portfolio.id)).toEqual(portfolio);
  });
});

describe("deposit / withdraw", () => {
  it("deposit increases cash and appends a Deposit event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const updated = await deposit(repos, "p1", 500, "top-up");
    expect(updated.cash).toBe(1500);
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events[0].type).toBe("Deposit");
    expect(events[0].amount).toBe(500);
  });

  it("withdraw decreases cash and appends a Withdrawal event", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 1000 })] });
    const updated = await withdraw(repos, "p1", 400);
    expect(updated.cash).toBe(600);
    const events = await repos.timeline.getByPortfolio("p1");
    expect(events[0].type).toBe("Withdrawal");
    expect(events[0].amount).toBe(-400);
  });

  it("withdraw rejects an amount larger than available cash", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 100 })] });
    await expect(withdraw(repos, "p1", 200)).rejects.toThrow(/insufficient cash/i);
  });

  it("rejects non-positive amounts", async () => {
    const repos = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: 100 })] });
    await expect(deposit(repos, "p1", 0)).rejects.toThrow();
    await expect(withdraw(repos, "p1", -10)).rejects.toThrow();
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

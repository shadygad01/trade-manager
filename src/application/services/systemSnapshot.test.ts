import { describe, it, expect } from "vitest";
import { computeSystemSnapshot, type SnapshotRepos } from "./systemSnapshot";
import { createFakeRawTransactionRepository, createFakePortfolioRepository } from "@application/testUtils/fakeRepositories";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import { createPortfolio } from "@domain/entities/Portfolio";

const PORTFOLIO = "p1";

async function seedScenario(overrides: { sellShares?: number; portfolioName?: string } = {}): Promise<SnapshotRepos> {
  const rawTransactions = createFakeRawTransactionRepository();
  const portfolios = createFakePortfolioRepository([
    createPortfolio({ id: PORTFOLIO, name: overrides.portfolioName ?? "Main", kind: "Trading", initialCash: 10_000 }),
  ]);
  const repos: SnapshotRepos = { rawTransactions, portfolios };

  const buyPayload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 40, executionDate: "2026-01-15", executionTime: "10:00" };
  const buy = await rawTransactions.append(
    createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "COMI", payload: buyPayload })
  );

  const sellPayload: SellExecutionPayload = {
    ticker: "COMI",
    shares: overrides.sellShares ?? 40,
    price: 50,
    executionDate: "2026-02-01",
    executionTime: "11:00",
  };
  const sell = await rawTransactions.append(
    createRawTransaction({ kind: "SellExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "COMI", payload: sellPayload })
  );

  const decisionPayload: SellAllocationDecisionPayload = { sellExecutionId: sell.id, allocations: [{ lotRef: buy.id, shares: overrides.sellShares ?? 40 }] };
  await rawTransactions.append(
    createRawTransaction({ kind: "SellAllocationDecision", source: "manual", portfolioId: PORTFOLIO, ticker: "COMI", payload: decisionPayload })
  );

  return repos;
}

describe("computeSystemSnapshot", () => {
  it("is deterministic: two independently-seeded, structurally-identical scenarios produce byte-identical hashes despite every row having its own random id", async () => {
    const reposA = await seedScenario();
    const reposB = await seedScenario();

    const snapshotA = await computeSystemSnapshot(reposA, PORTFOLIO);
    const snapshotB = await computeSystemSnapshot(reposB, PORTFOLIO);

    expect(snapshotA).toEqual(snapshotB);
  });

  it("changes the combined hash (and the specific affected categories) when the underlying data genuinely differs", async () => {
    const baseline = await computeSystemSnapshot(await seedScenario(), PORTFOLIO);
    const differentSellShares = await computeSystemSnapshot(await seedScenario({ sellShares: 25 }), PORTFOLIO);

    expect(differentSellShares.combined).not.toBe(baseline.combined);
    // A different sell size changes the ledger/allocation/holdings shape...
    expect(differentSellShares.ledger).not.toBe(baseline.ledger);
    expect(differentSellShares.allocation).not.toBe(baseline.allocation);
    expect(differentSellShares.holdings).not.toBe(baseline.holdings);
    // ...but NOT the portfolio or policy categories, which this change never touches.
    expect(differentSellShares.portfolio).toBe(baseline.portfolio);
    expect(differentSellShares.policy).toBe(baseline.policy);
  });

  it("changes only the portfolio category's hash when only the portfolio's own fields differ", async () => {
    const baseline = await computeSystemSnapshot(await seedScenario(), PORTFOLIO);
    const renamed = await computeSystemSnapshot(await seedScenario({ portfolioName: "Renamed" }), PORTFOLIO);

    expect(renamed.portfolio).not.toBe(baseline.portfolio);
    expect(renamed.facts).toBe(baseline.facts);
    expect(renamed.ledger).toBe(baseline.ledger);
    expect(renamed.holdings).toBe(baseline.holdings);
    expect(renamed.allocation).toBe(baseline.allocation);
  });

  it("is a real SHA-256 hex digest (64 lowercase hex chars) for every category, not a placeholder", async () => {
    const snapshot = await computeSystemSnapshot(await seedScenario(), PORTFOLIO);
    for (const value of Object.values(snapshot)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("an empty portfolio (no facts at all) still produces a stable, real snapshot rather than throwing", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    const portfolios = createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO, name: "Empty", kind: "Trading" })]);
    const repos: SnapshotRepos = { rawTransactions, portfolios };

    const snapshotA = await computeSystemSnapshot(repos, PORTFOLIO);
    const snapshotB = await computeSystemSnapshot(repos, PORTFOLIO);
    expect(snapshotA).toEqual(snapshotB);
  });
});

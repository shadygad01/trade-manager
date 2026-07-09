import { beforeEach, describe, expect, it } from "vitest";
import { shouldCommit, commitTicker, type CommitEngineRepos } from "./commitEngine";
import { createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import type { RawTransactionRepository, CommittedLedgerRepository } from "@domain/repositories";

const PORTFOLIO = "p1";

describe("commitEngine", () => {
  let rawTransactions: RawTransactionRepository;
  let committedLedger: CommittedLedgerRepository;
  let repos: CommitEngineRepos;

  beforeEach(() => {
    rawTransactions = createFakeRawTransactionRepository();
    committedLedger = createFakeCommittedLedgerRepository();
    repos = { rawTransactions, committedLedger };
  });

  async function appendBuy(overrides: Partial<BuyExecutionPayload> = {}, source: "manual" | "statement" | "invoice" = "manual") {
    const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...overrides };
    return rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source, portfolioId: PORTFOLIO, ticker: payload.ticker, payload }));
  }

  async function appendSell(overrides: Partial<SellExecutionPayload> = {}, source: "manual" | "statement" | "invoice" = "manual") {
    const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05", ...overrides };
    return rawTransactions.append(createRawTransaction({ kind: "SellExecution", source, portfolioId: PORTFOLIO, ticker: payload.ticker, payload }));
  }

  async function appendDecision(payload: SellAllocationDecisionPayload, ticker = "COMI") {
    // A decision must carry its own ticker, same as any Buy/Sell — the
    // Commit Engine scopes every raw transaction it reads by ticker, so an
    // untagged decision would never be picked up by any commit.
    return rawTransactions.append(createRawTransaction({ kind: "SellAllocationDecision", source: "manual", portfolioId: PORTFOLIO, ticker, payload }));
  }

  it("shouldCommit is false when there's nothing to verify for the ticker", async () => {
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false);
  });

  it("shouldCommit is true once a closed position (buy+sell netting to zero) needs no verification screenshot", async () => {
    await appendBuy({ shares: 100 });
    await appendSell({ shares: 100 });
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(true);
  });

  it("shouldCommit is false while a lone buy with no corroboration is still Needs Review", async () => {
    await appendBuy();
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false);
  });

  it("commitTicker writes a LotOpened event for a verified buy and it's readable back from the cache", async () => {
    await appendBuy({ shares: 100 });
    await appendSell({ shares: 100 }); // closes the position -> both verify
    await commitTicker(repos, PORTFOLIO, "COMI");

    const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);
  });

  it("commitTicker excludes a still-unverified transaction from the committed ledger", async () => {
    await appendBuy({ shares: 100 }); // alone, Needs Review — never independently verified
    await commitTicker(repos, PORTFOLIO, "COMI");

    expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
  });

  it("commitTicker writes allocations generated from a verified SellAllocationDecision", async () => {
    await appendBuy({ shares: 100 });
    await appendSell({ shares: 100 });
    await commitTicker(repos, PORTFOLIO, "COMI");

    const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    const lot = events.find((e) => e.type === "LotOpened")!;
    const sell = events.find((e) => e.type === "SellRecorded")!;
    await appendDecision({ sellExecutionId: sell.eventId, allocations: [{ lotRef: lot.eventId, shares: 100 }] });

    await commitTicker(repos, PORTFOLIO, "COMI");
    const allocations = await committedLedger.getAllocations(PORTFOLIO, "COMI");
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ sellEventId: sell.eventId, lotEventId: lot.eventId, shares: 100 });
  });

  it("re-committing after new data arrives fully replaces the cache, never leaving stale rows behind", async () => {
    await appendBuy({ shares: 100 });
    await appendSell({ shares: 100 });
    await commitTicker(repos, PORTFOLIO, "COMI");
    const firstPass = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(firstPass).toHaveLength(2);

    // A second, independent buy+sell pair for the same ticker arrives later.
    await appendBuy({ shares: 50, executionDate: "2026-03-01" });
    await appendSell({ shares: 50, executionDate: "2026-03-05" });
    await commitTicker(repos, PORTFOLIO, "COMI");

    const secondPass = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(secondPass).toHaveLength(4);
    // No duplication of the first pass's events — a full replace, not an append.
    const lotOpenedShares = secondPass.filter((e) => e.type === "LotOpened").map((e) => e.shares).sort((a, b) => a - b);
    expect(lotOpenedShares).toEqual([50, 100]);
  });

  it("committing one ticker never touches another ticker's cached rows", async () => {
    await appendBuy({ ticker: "COMI", shares: 100 });
    await appendSell({ ticker: "COMI", shares: 100 });
    await commitTicker(repos, PORTFOLIO, "COMI");

    await appendBuy({ ticker: "HRHO", shares: 20, price: 10 });
    await appendSell({ ticker: "HRHO", shares: 20, price: 12 });
    await commitTicker(repos, PORTFOLIO, "HRHO");

    expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toHaveLength(2);
    expect(await committedLedger.getLedgerEvents(PORTFOLIO, "HRHO")).toHaveLength(2);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  shouldCommit,
  commitTicker,
  appendAndMaybeCommit,
  assignPortfolio,
  retractRawTransaction,
  renameRawTransactionsTicker,
  type CommitEngineRepos,
} from "./commitEngine";
import { verifyAllDetailed } from "./verificationEngine";
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

  it("shouldCommit is true once a closed position (buy+sell netting to zero) is independently corroborated (e.g. invoice-sourced) — bare arithmetic alone is never enough (see importVerification.ts's closed-position fix)", async () => {
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(true);
  });

  it("shouldCommit is false for a closed position (buy+sell netting to zero) with NO independent corroboration — the JUFO/SKPC trap", async () => {
    await appendBuy({ shares: 100 });
    await appendSell({ shares: 100 });
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false);
  });

  it("shouldCommit is false while a lone buy with no corroboration is still Needs Review", async () => {
    await appendBuy();
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false);
  });

  it("a CancelledOrder fact is structurally invisible to the commit engine — never a subject, never blocks or enables a commit, never becomes a ledger event", async () => {
    await rawTransactions.append(
      createRawTransaction({
        kind: "CancelledOrder",
        source: "orders-screen",
        portfolioId: PORTFOLIO,
        ticker: "COMI",
        payload: { ticker: "COMI", side: "BUY", originalShares: 100, originalPrice: 45.5, date: "2026-02-01", brokerStatus: "Cancelled" },
      })
    );
    // Alone, a CancelledOrder is not a Buy/Sell — nothing to commit.
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false);

    // Alongside a real, independently-corroborated buy+sell, the
    // CancelledOrder fact changes nothing about the outcome — same verdict,
    // same ledger, as if it were never appended at all.
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");
    expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(true);
    await commitTicker(repos, PORTFOLIO, "COMI");
    const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);
    expect(events).toHaveLength(2); // the CancelledOrder never produced a third event
  });

  it("commitTicker writes a LotOpened event for a verified buy and it's readable back from the cache", async () => {
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice"); // invoice-corroborated closed position -> both verify
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
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");
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
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");
    await commitTicker(repos, PORTFOLIO, "COMI");
    const firstPass = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(firstPass).toHaveLength(2);

    // A second, independent buy+sell pair for the same ticker arrives later.
    await appendBuy({ shares: 50, executionDate: "2026-03-01" }, "invoice");
    await appendSell({ shares: 50, executionDate: "2026-03-05" }, "invoice");
    await commitTicker(repos, PORTFOLIO, "COMI");

    const secondPass = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
    expect(secondPass).toHaveLength(4);
    // No duplication of the first pass's events — a full replace, not an append.
    const lotOpenedShares = secondPass.filter((e) => e.type === "LotOpened").map((e) => e.shares).sort((a, b) => a - b);
    expect(lotOpenedShares).toEqual([50, 100]);
  });

  it("committing one ticker never touches another ticker's cached rows", async () => {
    await appendBuy({ ticker: "COMI", shares: 100 }, "invoice");
    await appendSell({ ticker: "COMI", shares: 100 }, "invoice");
    await commitTicker(repos, PORTFOLIO, "COMI");

    await appendBuy({ ticker: "HRHO", shares: 20, price: 10 }, "invoice");
    await appendSell({ ticker: "HRHO", shares: 20, price: 12 }, "invoice");
    await commitTicker(repos, PORTFOLIO, "HRHO");

    expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toHaveLength(2);
    expect(await committedLedger.getLedgerEvents(PORTFOLIO, "HRHO")).toHaveLength(2);
  });

  describe("appendAndMaybeCommit", () => {
    it("a transaction with no portfolioId (e.g. everything Import writes today) never triggers a commit", async () => {
      const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" };
      await appendAndMaybeCommit(repos, createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload }));

      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
    });

    it("supports deferred commit for a batch writer, so the caller can rebuild once after all facts are durable", async () => {
      const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" };
      await appendAndMaybeCommit(
        repos,
        createRawTransaction({ kind: "BuyExecution", source: "invoice", portfolioId: PORTFOLIO, ticker: "COMI", payload }),
        undefined,
        undefined,
        { deferCommit: true },
      );

      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
      await commitTicker(repos, PORTFOLIO, "COMI");
      expect((await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).map((event) => event.type)).toEqual(["LotOpened"]);
    });

    it("appending the transaction that completes a closed position triggers a commit automatically, with no explicit commitTicker call", async () => {
      // A broker "My Position" capture of 0 units is the corroboration here
      // (see importVerification.ts's closed-position fix) — chosen instead
      // of invoice-sourcing because an invoice bypasses per-row net-share
      // checks unconditionally, which would verify the lone Buy below before
      // the Sell ever arrives and defeat this test's own "not yet" assertion.
      await appendAndMaybeCommit(
        repos,
        createRawTransaction({
          kind: "PositionVerificationCapture",
          source: "position-verification",
          portfolioId: PORTFOLIO,
          ticker: "COMI",
          payload: { ticker: "COMI", units: 0, capturedAt: "2026-01-31T00:00" },
        })
      );

      const buyPayload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" };
      await appendAndMaybeCommit(repos, createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "COMI", payload: buyPayload }));
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]); // not yet — still Needs Review alone

      const sellPayload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05" };
      await appendAndMaybeCommit(repos, createRawTransaction({ kind: "SellExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "COMI", payload: sellPayload }));

      // The second append alone triggered the commit — closes the position, both verify.
      const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
      expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);
    });

    it("a transaction that leaves the ticker ambiguous never triggers a commit", async () => {
      const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" };
      await appendAndMaybeCommit(repos, createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "COMI", payload }));

      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
    });

    it("returns the appended transaction with its assigned seq, same as a plain append", async () => {
      const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" };
      const result = await appendAndMaybeCommit(repos, createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload }));
      expect(typeof result.seq).toBe("number");
    });
  });

  describe("assignPortfolio", () => {
    async function appendUnassignedBuy(overrides: Partial<BuyExecutionPayload> = {}, source: "csv" | "invoice" = "csv") {
      const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...overrides };
      return rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source, ticker: "COMI", payload })); // no portfolioId — as Import writes it
    }

    it("assigning a ticker's unassigned transactions makes them visible to shouldCommit/commitTicker under that portfolio", async () => {
      await appendUnassignedBuy({ shares: 100 }, "invoice");
      await rawTransactions.append(
        createRawTransaction({
          kind: "SellExecution",
          source: "invoice",
          ticker: "COMI",
          payload: { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05" },
        })
      );
      expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false); // unassigned — nothing to commit under any portfolio yet

      await assignPortfolio(repos, "COMI", PORTFOLIO);

      // Assignment alone triggers the commit (closed position, both verify).
      const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
      expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);
    });

    it("assigning one ticker never touches an unrelated ticker's still-unassigned transactions", async () => {
      await appendUnassignedBuy({ ticker: "COMI" });
      await rawTransactions.append(
        createRawTransaction({ kind: "BuyExecution", source: "csv", ticker: "HRHO", payload: { ticker: "HRHO", shares: 20, price: 10, executionDate: "2026-02-01" } })
      );

      await assignPortfolio(repos, "COMI", PORTFOLIO);

      const comiTxns = (await rawTransactions.getAll()).filter((t) => t.ticker === "COMI" && t.kind === "BuyExecution");
      const hrhoTxns = (await rawTransactions.getAll()).filter((t) => t.ticker === "HRHO" && t.kind === "BuyExecution");
      expect(comiTxns[0].portfolioId).toBeUndefined(); // still immutable — assignment is a separate fact, never an edit
      expect(hrhoTxns[0].portfolioId).toBeUndefined();
    });

    it("assigning a ticker with nothing unassigned is a harmless no-op", async () => {
      await expect(assignPortfolio(repos, "COMI", PORTFOLIO)).resolves.toBeUndefined();
      expect(await rawTransactions.getAll()).toEqual([]);
    });

    it("assigning the same ticker twice to different portfolios: the later assignment wins for a transaction targeted only once", async () => {
      await appendUnassignedBuy({ shares: 100 });
      await assignPortfolio(repos, "COMI", "portfolio-a");

      // Nothing left unassigned for COMI, so a second call is a no-op —
      // proving assignment doesn't re-target an already-assigned row.
      await assignPortfolio(repos, "COMI", "portfolio-b");

      const [buy] = (await rawTransactions.getAll()).filter((t) => t.kind === "BuyExecution");
      const assignments = (await rawTransactions.getAll()).filter((t) => t.kind === "PortfolioAssignment");
      expect(assignments).toHaveLength(1);
      expect((assignments[0].payload as { targetId: string; portfolioId: string }).targetId).toBe(buy.id);
      expect((assignments[0].payload as { targetId: string; portfolioId: string }).portfolioId).toBe("portfolio-a");
    });
  });

  describe("retractRawTransaction", () => {
    it("a retracted transaction drops out of the ticker's relevant set — commitTicker clears the cache entry that resurrected it", async () => {
      // A broker "My Position" capture of 0 units corroborates the closed
      // round-trip (see importVerification.ts's closed-position fix) —
      // chosen instead of invoice-sourcing because an invoice bypasses
      // per-row net-share checks unconditionally: the lone Sell left behind
      // after retracting the Buy would otherwise still self-verify, instead
      // of correctly reverting to Needs Review as this test expects.
      await rawTransactions.append(
        createRawTransaction({
          kind: "PositionVerificationCapture",
          source: "position-verification",
          portfolioId: PORTFOLIO,
          ticker: "COMI",
          payload: { ticker: "COMI", units: 0, capturedAt: "2026-01-31T00:00" },
        })
      );
      const buy = await appendBuy({ shares: 100 });
      await appendSell({ shares: 100 });
      await commitTicker(repos, PORTFOLIO, "COMI");
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toHaveLength(2);

      await retractRawTransaction(repos, buy.id, "deleted in the pre-migration UI");

      // The retraction's own append re-triggers a commit — the cache updates
      // immediately, without a separate explicit commitTicker call.
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
    });

    it("assignPortfolio never assigns a retracted transaction", async () => {
      const buy = await rawTransactions.append(
        createRawTransaction({
          kind: "BuyExecution",
          source: "csv",
          ticker: "COMI",
          payload: { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" },
        }),
      );
      await retractRawTransaction(repos, buy.id);

      await assignPortfolio(repos, "COMI", PORTFOLIO);

      const assignments = (await rawTransactions.getAll()).filter((t) => t.kind === "PortfolioAssignment");
      expect(assignments).toHaveLength(0);
    });

    it("retracting a transaction that was never committed is a harmless no-op", async () => {
      const buy = await appendBuy({ shares: 100 });
      await expect(retractRawTransaction(repos, buy.id)).resolves.toBeUndefined();
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
    });
  });

  describe("renameRawTransactionsTicker", () => {
    it("moves a closed position's committed cache entries from the old ticker to the new one", async () => {
      await appendBuy({ ticker: "COMI", shares: 100 }, "invoice");
      await appendSell({ ticker: "COMI", shares: 100 }, "invoice");
      await commitTicker(repos, PORTFOLIO, "COMI");
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toHaveLength(2);

      const corrected = await renameRawTransactionsTicker(repos, "COMI", "HRHO");
      expect(corrected).toBe(2); // the Buy and the Sell

      // Old ticker's cache is cleared, not left stale...
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
      // ...and the new ticker's cache now has what the old one used to.
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "HRHO")).toHaveLength(2);
    });

    it("a raw transaction still unassigned to any portfolio is corrected too, and stays findable under the new ticker afterward", async () => {
      await rawTransactions.append(
        createRawTransaction({
          kind: "BuyExecution",
          source: "csv",
          ticker: "COMI",
          payload: { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" },
        }),
      );

      await renameRawTransactionsTicker(repos, "COMI", "HRHO");
      await assignPortfolio(repos, "HRHO", PORTFOLIO);

      // Renamed correctly — assignPortfolio finds it under the NEW ticker
      // (assignPortfolio("COMI", ...) would find nothing, proving the old
      // ticker no longer resolves this row at all, not just alongside it).
      const events = await committedLedger.getLedgerEvents(PORTFOLIO, "HRHO");
      expect(events).toEqual([]); // alone, Needs Review — but reachable, which is what's under test
      const assignments = (await rawTransactions.getAll()).filter((t) => t.kind === "PortfolioAssignment");
      expect(assignments).toHaveLength(1);
    });

    it("renaming to the same ticker (or an empty/blank ticker) is a harmless no-op", async () => {
      await appendBuy({ ticker: "COMI" });
      expect(await renameRawTransactionsTicker(repos, "COMI", "COMI")).toBe(0);
      expect(await renameRawTransactionsTicker(repos, "COMI", "")).toBe(0);
      expect((await rawTransactions.getAll()).filter((t) => t.kind === "Correction")).toHaveLength(0);
    });

    it("a retracted transaction is never corrected", async () => {
      const buy = await rawTransactions.append(
        createRawTransaction({
          kind: "BuyExecution",
          source: "csv",
          ticker: "COMI",
          payload: { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" },
        }),
      );
      await retractRawTransaction(repos, buy.id);

      const corrected = await renameRawTransactionsTicker(repos, "COMI", "HRHO");
      expect(corrected).toBe(0);
    });
  });

  describe("Phase 9.5 — verifyAllDetailed's richer API agrees with commitEngine's existing decisions", () => {
    /** commitEngine.ts never called any new API — it still calls verifyAll() exactly as before. These tests just cross-check the additive verifyAllDetailed()/TickerStatus surface against the ledger/allocation output that same unchanged code path already produces, proving the richer contract introduces no divergence. */
    it("a ticker verifyAllDetailed reports matched:true is exactly the ticker shouldCommit says yes for, and commitTicker's ledger events reflect it", async () => {
      await appendBuy({ shares: 100 }, "invoice");
      await appendSell({ shares: 100 }, "invoice"); // invoice-corroborated closed position

      const all = await rawTransactions.getAll();
      const status = verifyAllDetailed({ transactions: all, positions: [] }).tickers.get("COMI");
      expect(status?.matched).toBe(true);

      expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(true);
      await commitTicker(repos, PORTFOLIO, "COMI");
      const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
      expect(events.map((e) => e.type).sort()).toEqual(["LotOpened", "SellRecorded"]);
    });

    it("a ticker verifyAllDetailed reports matched:false is exactly the ticker shouldCommit says no for, and commitTicker writes nothing", async () => {
      await appendBuy({ shares: 100 }); // alone — Needs Review, no verification

      const all = await rawTransactions.getAll();
      const status = verifyAllDetailed({ transactions: all, positions: [] }).tickers.get("COMI");
      expect(status?.matched).toBe(false);
      expect(status?.reason).toBe("no-verification");

      expect(await shouldCommit(repos, PORTFOLIO, "COMI")).toBe(false);
      await commitTicker(repos, PORTFOLIO, "COMI");
      expect(await committedLedger.getLedgerEvents(PORTFOLIO, "COMI")).toEqual([]);
    });

    it("allocations generated via commitTicker are unaffected by reading the richer API alongside it", async () => {
      await appendBuy({ shares: 100 }, "invoice");
      await appendSell({ shares: 100 }, "invoice");
      await commitTicker(repos, PORTFOLIO, "COMI");
      const events = await committedLedger.getLedgerEvents(PORTFOLIO, "COMI");
      const lot = events.find((e) => e.type === "LotOpened")!;
      const sell = events.find((e) => e.type === "SellRecorded")!;
      await appendDecision({ sellExecutionId: sell.eventId, allocations: [{ lotRef: lot.eventId, shares: 100 }] });
      await commitTicker(repos, PORTFOLIO, "COMI");

      // Reading verifyAllDetailed after the fact must not perturb what was already committed.
      const all = await rawTransactions.getAll();
      verifyAllDetailed({ transactions: all, positions: [] });

      const allocations = await committedLedger.getAllocations(PORTFOLIO, "COMI");
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).toMatchObject({ sellEventId: sell.eventId, lotEventId: lot.eventId, shares: 100 });
    });
  });
});

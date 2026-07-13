import { beforeEach, describe, expect, it } from "vitest";
import { commitTicker, type CommitEngineRepos } from "./commitEngine";
import { recordBuy } from "./TradeService";
import {
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
  createFakePortfolioRepository,
  createFakeTradeRepository,
  createFakeTradeAllocationRepository,
  createFakeTimelineRepository,
  createFakeJournalRepository,
  createFakeVerificationRepository,
  createFakeUploadRepository,
  createFakePendingExecutionRepository,
} from "@application/testUtils/fakeRepositories";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type SellAllocationDecisionPayload } from "@domain/entities/RawTransaction";
import { createPortfolio } from "@domain/entities/Portfolio";
import type { RawTransactionRepository, CommittedLedgerRepository, DiagnosticsRecorder } from "@domain/repositories";
import type { DecisionTraceRecord } from "@domain/entities/diagnostics/DiagnosticEvent";

const PORTFOLIO = "p1";

/** Records every recordDecision call, discarding the rest — the only diagnostics surface commitTicker touches. */
function fakeDiagnostics(): DiagnosticsRecorder & { decisions: DecisionTraceRecord[] } {
  const decisions: DecisionTraceRecord[] = [];
  return {
    decisions,
    recordSessionEvent() {},
    recordWrite() {},
    recordRead() {},
    recordDecision(event) {
      decisions.push({
        ...event,
        id: "x",
        seq: decisions.length + 1,
        recordedAt: new Date().toISOString(),
        sessionId: "s1",
        kind: "DecisionTrace",
      });
    },
    recordRuleExecution() {},
    recordPerfSample() {},
  };
}

describe("commitEngine Phase 3: Decision Trace (Replay/Verification/Allocation)", () => {
  let rawTransactions: RawTransactionRepository;
  let committedLedger: CommittedLedgerRepository;
  let repos: CommitEngineRepos;

  beforeEach(() => {
    rawTransactions = createFakeRawTransactionRepository();
    committedLedger = createFakeCommittedLedgerRepository();
    repos = { rawTransactions, committedLedger };
  });

  async function appendBuy(overrides: Partial<BuyExecutionPayload> = {}, source: "manual" | "invoice" = "invoice") {
    const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...overrides };
    return rawTransactions.append(createRawTransaction({ kind: "BuyExecution", source, portfolioId: PORTFOLIO, ticker: payload.ticker, payload }));
  }

  async function appendSell(overrides: Partial<SellExecutionPayload> = {}, source: "manual" | "invoice" = "invoice") {
    const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05", ...overrides };
    return rawTransactions.append(createRawTransaction({ kind: "SellExecution", source, portfolioId: PORTFOLIO, ticker: payload.ticker, payload }));
  }

  async function appendDecision(payload: SellAllocationDecisionPayload) {
    return rawTransactions.append(createRawTransaction({ kind: "SellAllocationDecision", source: "manual", portfolioId: PORTFOLIO, ticker: "COMI", payload }));
  }

  it("records no decisions when diagnostics is not passed (default, zero-cost behavior unchanged)", async () => {
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");
    await commitTicker(repos, PORTFOLIO, "COMI");
    // Nothing to assert on — this just proves the call succeeds with no diagnostics arg (existing callers keep working).
  });

  it("emits one Verification, one Replay, and one Allocation decision per commit, sharing the same correlationId", async () => {
    await appendBuy({ shares: 100 }, "invoice");
    const sell = await appendSell({ shares: 100 }, "invoice");
    await appendDecision({ sellExecutionId: sell.id, allocations: [{ lotRef: (await rawTransactions.getAll())[0].id, shares: 100 }] });

    const diagnostics = fakeDiagnostics();
    await commitTicker(repos, PORTFOLIO, "COMI", diagnostics);

    expect(diagnostics.decisions.map((d) => d.decisionType)).toEqual(["Verification", "Replay", "Allocation"]);
    const correlationIds = new Set(diagnostics.decisions.map((d) => d.correlationId));
    expect(correlationIds.size).toBe(1);
    expect([...correlationIds][0]).toEqual(expect.any(String));
  });

  it("every decision names the real reader/function and carries a ticker/portfolioId, never raw transaction objects", async () => {
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");

    const diagnostics = fakeDiagnostics();
    await commitTicker(repos, PORTFOLIO, "COMI", diagnostics);

    for (const decision of diagnostics.decisions) {
      expect(decision.reader).toBe("commitEngine.ts");
      expect(decision.function).toBe("commitTicker");
      expect(decision.portfolioId).toBe(PORTFOLIO);
      expect(decision.ticker).toBe("COMI");
      expect(typeof decision.inputSummary).toBe("string");
      expect(typeof decision.outputSummary).toBe("string");
      // Summaries are short, hand-built strings — never a JSON dump of a RawTransaction/LedgerEvent/Allocation.
      expect(decision.inputSummary).not.toContain("payload");
      expect(decision.outputSummary).not.toContain("payload");
    }
  });

  it("the Verification decision's outcome reflects the real verdict mix", async () => {
    await appendBuy({ shares: 100 }, "invoice");
    await appendSell({ shares: 100 }, "invoice");

    const diagnostics = fakeDiagnostics();
    await commitTicker(repos, PORTFOLIO, "COMI", diagnostics);

    const verification = diagnostics.decisions.find((d) => d.decisionType === "Verification")!;
    expect(verification.decision).toContain("Verified");
  });

  it("the Allocation decision reports zero allocations when nothing was verified yet", async () => {
    await appendBuy({ shares: 100 }); // "manual" source alone is Needs Review, never terminal-verified without corroboration

    const diagnostics = fakeDiagnostics();
    await commitTicker(repos, PORTFOLIO, "COMI", diagnostics);

    const allocation = diagnostics.decisions.find((d) => d.decisionType === "Allocation")!;
    expect(allocation.decision).toBe("0 allocations");
  });
});

describe("commitEngine Phase 3: diagnostics survives the REAL Import -> Confirm call chain, not just a direct commitTicker call", () => {
  /**
   * Every test above calls `commitTicker` directly — that alone doesn't
   * prove `diagnostics` actually reaches it from a real user action, since
   * `commitTicker` sits behind `appendAndMaybeCommit`, which itself sits
   * behind whichever writer function the UI actually calls. The real Import
   * workflow's most common shape is: Step 1 "Extract" already wrote this
   * ticker's fact (via `recordImportedRawTransactions`, sourced from the
   * real document), so Step 2 "Confirm" -> `recordBuy` finds a live matching
   * fact and ADOPTS it (`TradeService.ensureBuyFact`'s `assignPortfolioToFact`
   * branch) rather than appending a fresh one — a structurally different
   * code path than every test above, which never had a pre-existing fact to
   * adopt. `assignPortfolioToFact` previously dropped `diagnostics` on the
   * floor entirely (didn't even accept the parameter), so this exact,
   * extremely common path recorded ZERO decisions in production despite
   * every unit test above passing — found by an explicit end-to-end audit,
   * not by a test failure. Fixed by threading `diagnostics` through
   * `assignPortfolio`/`assignPortfolioToFact`/`retractRawTransaction`/
   * `renameRawTransactionsTicker` the same way `commitTicker` already was.
   */
  it("recordBuy adopting a pre-existing official-broker-excel fact (the real Confirm path) still records Verification/Replay/Allocation decisions", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    const repos = {
      portfolios: createFakePortfolioRepository([createPortfolio({ id: PORTFOLIO, name: "Main", kind: "Trading", initialCash: 1_000_000 })]),
      trades: createFakeTradeRepository(),
      allocations: createFakeTradeAllocationRepository(),
      timeline: createFakeTimelineRepository(),
      journal: createFakeJournalRepository(),
      verifications: createFakeVerificationRepository(),
      uploads: createFakeUploadRepository(),
      pendingExecutions: createFakePendingExecutionRepository(),
      rawTransactions,
      committedLedger: createFakeCommittedLedgerRepository(),
    };

    // Step 1 "Extract" — the real recordImportedRawTransactions shape: a
    // trusted-on-its-own document source, no portfolio assigned yet.
    const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", executionTime: "10:00" };
    await rawTransactions.append(createRawTransaction({ id: "0-c0", kind: "BuyExecution", source: "official-broker-excel", ticker: "COMI", confidence: "high", payload }));

    const diagnostics = fakeDiagnostics();

    // Step 2 "Confirm" — addBuyCandidate's real call.
    await recordBuy(repos, { portfolioId: PORTFOLIO, ticker: "COMI", shares: 100, entryPrice: 45.5, executionDate: "2026-02-01", executionTime: "10:00" }, diagnostics);

    expect(diagnostics.decisions.map((d) => d.decisionType)).toEqual(["Verification", "Replay", "Allocation"]);
    expect(diagnostics.decisions.find((d) => d.decisionType === "Verification")!.decision).toContain("Verified");
  });
});

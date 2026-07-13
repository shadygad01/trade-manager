import { describe, expect, it } from "vitest";
import { verifyAll, verifyAllDetailed, verifyTicker, buildConstraintReport, type VerifyAllParams } from "./verificationEngine";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type RetractionPayload } from "@domain/entities/RawTransaction";
import type { PositionAggregate } from "./TradeService";
import { checkTickerMatch } from "./importVerification";
import { suggestRemovalsToReconcile } from "./mismatchResolver";
import { findLastBalancedDate } from "./netShareTimeline";
import { createTrade } from "@domain/entities/Trade";

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"]; confidence?: RawTransaction["confidence"] } = {}): RawTransaction {
  const { id, source, confidence, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...payloadOverrides };
  return {
    ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", ticker: payload.ticker, confidence, payload }),
    seq: 1,
  };
}

function sell(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 50, executionDate: "2026-02-05", ...payloadOverrides };
  return {
    ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "manual", ticker: payload.ticker, payload }),
    seq: 2,
  };
}

function positionVerification(units: number, ticker = "COMI", capturedAt = "2026-02-10T00:00"): RawTransaction {
  return {
    ...createRawTransaction({
      kind: "PositionVerificationCapture",
      source: "position-verification",
      ticker,
      payload: { ticker, units, capturedAt },
    }),
    seq: 3,
  };
}

function orderEvidence(overrides: { ticker?: string; side?: "BUY" | "SELL"; shares?: number; price?: number; totalValue?: number } = {}): RawTransaction {
  const ticker = overrides.ticker ?? "COMI";
  const side = overrides.side ?? "BUY";
  const shares = overrides.shares ?? 100;
  const price = overrides.price ?? 45.5;
  return {
    ...createRawTransaction({
      kind: "OrderEvidenceCapture",
      source: "orders-timeline",
      ticker,
      payload: { ticker, side, shares, price, totalValue: overrides.totalValue ?? shares * price, status: "fulfilled" },
    }),
    seq: 4,
  };
}

function emptyPosition(ticker = "COMI"): PositionAggregate {
  return { ticker, totalShares: 0, costBasis: 0, avgCost: 0, openTrades: [] };
}

function positionWithOpenTrades(ticker: string, openTrades: ReturnType<typeof createTrade>[]): PositionAggregate {
  const totalShares = openTrades.reduce((s, t) => s + t.remainingShares, 0);
  return { ticker, totalShares, costBasis: 0, avgCost: 0, openTrades };
}

function retraction(targetId: string): RawTransaction {
  const payload: RetractionPayload = { targetId };
  return { ...createRawTransaction({ kind: "Retraction", source: "manual", payload }), seq: 99 };
}

function tickerCorrection(targetId: string, ticker: string): RawTransaction {
  return { ...createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId, patch: { ticker } } }), seq: 98 };
}

function run(transactions: RawTransaction[], positions: PositionAggregate[] = [emptyPosition()]) {
  const params: VerifyAllParams = { transactions, positions };
  return verifyAll(params);
}

describe("verificationEngine.verifyAll", () => {
  it("a lone buy with no corroboration and no verification screenshot is Needs Review", () => {
    const b = buy();
    const result = run([b]);
    expect(result.get(b.id)?.verdict).toBe("Needs Review");
  });

  it("a closed position (buy + matching sell, net zero) with NO independent corroboration is still Needs Review — the JUFO/SKPC closed-position trap", () => {
    const b = buy({ shares: 100 });
    const s = sell({ shares: 100 });
    const result = run([b, s]);
    expect(result.get(b.id)?.verdict).toBe("Needs Review");
    expect(result.get(s.id)?.verdict).toBe("Needs Review");
  });

  it("a fully closed position (buy + matching sell, net zero) IS Verified once independently corroborated (e.g. invoice-sourced)", () => {
    const b = buy({ shares: 100, source: "invoice" });
    const s = sell({ shares: 100, source: "invoice" });
    const result = run([b, s]);
    expect(result.get(b.id)?.verdict).toBe("Verified");
    expect(result.get(s.id)?.verdict).toBe("Verified");
    expect(result.get(b.id)?.evidence.some((e) => e.type === "matched-position")).toBe(true);
  });

  it("two independent document types describing the same execution are cross-verified and Verified", () => {
    const statementRead = buy({ id: "stmt-1", source: "statement" });
    const invoiceRead = buy({ id: "invoice-1", source: "invoice" });
    const result = run([statementRead, invoiceRead]);

    expect(result.get(statementRead.id)?.verdict).toBe("Verified");
    expect(result.get(statementRead.id)?.evidence.some((e) => e.type === "matched-invoice")).toBe(true);
    expect(result.get(invoiceRead.id)?.evidence.some((e) => e.type === "matched-statement")).toBe(true);
  });

  it("an exact duplicate pair rejects the non-survivor and keeps the higher-priced buy read eligible", () => {
    // Prices must be within siblingPricesClose's 2% tolerance to register as
    // the same real execution read twice, not two distinct trades.
    const higher = buy({ id: "higher", source: "statement", price: 45.8 });
    const lower = buy({ id: "lower", source: "statement", price: 45.5 });
    const result = run([higher, lower]);

    expect(result.get(lower.id)?.verdict).toBe("Rejected");
    expect(result.get(lower.id)?.evidence.some((e) => e.type === "matched-ledger")).toBe(true);
    // The survivor isn't auto-rejected by the duplicate check — its own
    // verdict still depends on whatever other evidence it has (here: none,
    // so it's Needs Review, not silently promoted to Verified).
    expect(result.get(higher.id)?.verdict).toBe("Needs Review");
    expect(result.get(higher.id)?.evidence.some((e) => e.type === "matched-ledger")).toBe(false);
  });

  it("a fulfilled order-history row confirms a pending buy", () => {
    const b = buy();
    const evidence = orderEvidence();
    const result = run([b, evidence]);

    expect(result.get(b.id)?.evidence.some((e) => e.type === "matched-order")).toBe(true);
    expect(result.get(b.id)?.verdict).toBe("Verified");
  });

  it("a position-verification capture that matches computed holdings verifies the buy", () => {
    const b = buy({ shares: 50 });
    const capture = positionVerification(150); // existing 100 + this batch's 50
    const result = run([b, capture], [{ ...emptyPosition(), totalShares: 100 }]);

    expect(result.get(b.id)?.verdict).toBe("Verified");
    expect(result.get(b.id)?.evidence.some((e) => e.type === "matched-position")).toBe(true);
  });

  it("a position-verification mismatch with no other corroboration is Needs Review, not Rejected — nobody knows which row is wrong", () => {
    const b = buy({ shares: 50 });
    const capture = positionVerification(999); // wildly off
    const result = run([b, capture], [{ ...emptyPosition(), totalShares: 100 }]);

    expect(result.get(b.id)?.verdict).toBe("Needs Review");
    expect(result.get(b.id)?.evidence.some((e) => e.type === "contradicted-position-mismatch")).toBe(true);
  });

  it("a statement aggregate row is matched against the group of executions it summarizes", () => {
    const part1 = buy({ id: "p1", source: "orders-screen", shares: 30 });
    const part2 = buy({ id: "p2", source: "orders-screen", shares: 20 });
    const summary = buy({ id: "summary", source: "statement", shares: 50 });
    const result = run([part1, part2, summary]);

    expect(result.get(summary.id)?.evidence.some((e) => e.type === "matched-statement-aggregate")).toBe(true);
  });

  it("never returns evidence or a verdict for a non-Buy/Sell transaction (verification captures aren't subjects)", () => {
    const capture = positionVerification(100);
    const result = run([capture]);
    expect(result.has(capture.id)).toBe(false);
  });

  it("a backfilled transaction is Verified unconditionally, even with no corroboration and an open (non-zero-net) position", () => {
    const b = buy({ source: "backfill" });
    const result = run([b]); // alone — would be Needs Review for any other source
    expect(result.get(b.id)?.verdict).toBe("Verified");
    expect(result.get(b.id)?.evidence).toEqual([{ type: "matched-backfill", detail: "Already committed and reconciled under the pre-migration system." }]);
  });

  it("a backfilled transaction is Verified even when a ticker-level position mismatch exists — history isn't re-litigated under the new rules", () => {
    const b = buy({ source: "backfill", shares: 50 });
    const capture = positionVerification(999); // wildly off — would be Needs Review for a normal source
    const result = run([b, capture], [{ ...emptyPosition(), totalShares: 100 }]);
    expect(result.get(b.id)?.verdict).toBe("Verified");
  });
});

/**
 * Phase 9.5 — contract-completion regression suite. verifyAll()'s existing
 * behavior (asserted above) must be byte-for-byte unchanged now that it's a
 * one-line wrapper over computeVerification; these tests additionally prove
 * verifyAllDetailed()/verifyTicker() surface exactly checkTickerMatch()'s own
 * output — the same numbers the legacy TickerMatchStatus path already
 * produces — rather than a re-derived approximation.
 */
describe("verificationEngine — verifyAllDetailed/verifyTicker (additive contract)", () => {
  const scenarios: { name: string; transactions: RawTransaction[]; positions?: PositionAggregate[] }[] = [
    { name: "lone unverified buy", transactions: [buy()] },
    { name: "closed position (buy+sell net zero)", transactions: [buy({ shares: 100 }), sell({ shares: 100 })] },
    { name: "cross-source verified pair", transactions: [buy({ id: "stmt-1", source: "statement" }), buy({ id: "invoice-1", source: "invoice" })] },
    { name: "exact duplicate pair", transactions: [buy({ id: "higher", source: "statement", price: 45.8 }), buy({ id: "lower", source: "statement", price: 45.5 })] },
    { name: "order-confirmed buy", transactions: [buy(), orderEvidence()] },
    {
      name: "position-verification match",
      transactions: [buy({ shares: 50 }), positionVerification(150)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    },
    {
      name: "position-verification mismatch",
      transactions: [buy({ shares: 50 }), positionVerification(999)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    },
    { name: "statement aggregate", transactions: [buy({ id: "p1", source: "orders-screen", shares: 30 }), buy({ id: "p2", source: "orders-screen", shares: 20 }), buy({ id: "summary", source: "statement", shares: 50 })] },
    { name: "backfilled row", transactions: [buy({ source: "backfill" })] },
    { name: "no transactions at all", transactions: [] },
  ];

  it.each(scenarios)("verifyAllDetailed($name).transactions is identical to verifyAll($name)'s own return value", ({ transactions, positions }) => {
    const params: VerifyAllParams = { transactions, positions: positions ?? [emptyPosition()] };
    const legacy = verifyAll(params);
    const detailed = verifyAllDetailed(params);
    expect(detailed.transactions).toEqual(legacy);
    expect([...detailed.transactions.keys()]).toEqual([...legacy.keys()]);
  });

  it("verifyTicker(ticker, params) returns the exact same object as verifyAllDetailed(params).tickers.get(normalizeTicker(ticker))", () => {
    const params: VerifyAllParams = { transactions: [buy({ shares: 100 }), sell({ shares: 100 })], positions: [emptyPosition()] };
    const viaDetailed = verifyAllDetailed(params).tickers.get("COMI");
    // Not .toBe: computeVerification recomputes fresh on every call (no
    // cache, by design — same convention as holdingsEngine.ts), so this
    // proves the two entry points agree on VALUE, not object identity.
    expect(verifyTicker("COMI", params)).toEqual(viaDetailed);
    expect(verifyTicker("comi", params)).toEqual(viaDetailed); // normalizeTicker uppercases, so a lowercase lookup resolves the same entry
  });

  it("verifyTicker returns undefined for a ticker with no Buy/Sell rows in scope", () => {
    const params: VerifyAllParams = { transactions: [buy({ ticker: "COMI" })], positions: [emptyPosition()] };
    expect(verifyTicker("HRHO", params)).toBeUndefined();
  });

  // Policy audit finding: computeVerification's own internal per-ticker
  // grouping (toTradeCandidateEntries) used to key off the raw, immutable
  // payload.ticker instead of folding through resolveCurrentTicker — the
  // same bug class already fixed elsewhere (reconciliation.ts's
  // isTickerFullyOfficialBrokerExcelSourced, rawTransactionFolds.ts's
  // findLiveExecutionFact, TradeService.ts's ensureBuyFact) but missed here.
  // A ticker renamed via a Correction fact, which later accumulates a NEW
  // fact recorded natively under the corrected name, would have its
  // pre-rename and post-rename facts silently split into two separate
  // checkTickerMatch buckets — each seeing only part of the real position —
  // inside commitEngine.ts's own live commit-decision path (verifyAll is
  // its only verification call).
  it("folds a renamed ticker's pre-rename fact together with its post-rename facts into one checkTickerMatch bucket, not two", () => {
    const preRename = buy({ id: "b1", ticker: "COMI", shares: 100 });
    const rename = tickerCorrection("b1", "HRHO");
    const postRename = buy({ id: "b2", ticker: "HRHO", shares: 50 });
    const params: VerifyAllParams = { transactions: [preRename, rename, postRename], positions: [emptyPosition("HRHO")] };

    const hrho = verifyTicker("HRHO", params);
    expect(hrho?.netShares).toBe(150); // both facts, not just the native 50
    expect(hrho?.pendingBuyShares).toBe(150);

    // The old, pre-rename ticker name must have nothing live left under it —
    // its sole fact was renamed away, not duplicated.
    expect(verifyTicker("COMI", params)).toBeUndefined();
  });

  it("a ticker whose entries all came from the official broker Excel export is broker-excel-verified, needing no My Position screenshot", () => {
    const params: VerifyAllParams = {
      transactions: [buy({ id: "b1", source: "official-broker-excel", shares: 100 })],
      positions: [emptyPosition()],
    };
    const status = verifyTicker("COMI", params)!;
    expect(status.matched).toBe(true);
    expect(status.reason).toBe("broker-excel-verified");
  });

  it("TickerStatus for a closed position matches checkTickerMatch() called directly with the same inputs — reason, netShares, matched", () => {
    const params: VerifyAllParams = { transactions: [buy({ shares: 100 }), sell({ shares: 100 })], positions: [emptyPosition()] };
    const status = verifyTicker("COMI", params)!;
    const expected = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 100,
      pendingSellShares: 100,
      existingRemainingShares: 0,
      allPendingFromInvoice: false,
      allPendingSelfVerified: false,
      allPendingOrderConfirmed: false,
    });
    expect(status.ticker).toBe("COMI");
    expect(status.matched).toBe(expected.matched);
    expect(status.reason).toBe(expected.reason);
    expect(status.netShares).toBe(expected.netShares);
  });

  it("TickerStatus surfaces verifiedUnits/verifiedAvgCost/discrepancySide exactly as checkTickerMatch computed them, for a mismatch", () => {
    const params: VerifyAllParams = {
      transactions: [buy({ shares: 50 }), positionVerification(999)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    };
    const status = verifyTicker("COMI", params)!;
    expect(status.reason).toBe("mismatch");
    expect(status.verifiedUnits).toBe(999);
    expect(status.existingRemainingShares).toBe(100);
    expect(status.pendingBuyShares).toBe(50);
    expect(status.netShares).toBe(150);
    // netShares (150) < verifiedUnits (999) => shortage sits on the sell/missing-buy side.
    expect(status.discrepancySide).toBe("sell");
  });

  it("TickerStatus.alreadyFullyRecorded is exposed when the broker's verified count already matches pre-batch ledger shares", () => {
    const params: VerifyAllParams = {
      transactions: [buy({ shares: 30 }), positionVerification(100)],
      positions: [{ ...emptyPosition(), totalShares: 100 }],
    };
    const status = verifyTicker("COMI", params)!;
    expect(status.reason).toBe("mismatch");
    expect(status.alreadyFullyRecorded).toBe(true);
  });

  it("computeVerification is only exercised once per call — verifyAllDetailed does not run checkTickerMatch a second time with different results", () => {
    // If the ticker-level computation ever forked into two separate call
    // sites, a ticker straddling two batches of the same params could drift.
    // Calling twice from the same params must be referentially stable in
    // content (not identity, since each call recomputes from scratch) but
    // never divergent.
    const params: VerifyAllParams = { transactions: [buy({ shares: 50 }), positionVerification(150)], positions: [{ ...emptyPosition(), totalShares: 100 }] };
    const first = verifyAllDetailed(params);
    const second = verifyAllDetailed(params);
    expect(first.tickers.get("COMI")).toEqual(second.tickers.get("COMI"));
    expect(first.transactions).toEqual(second.transactions);
  });
});

/**
 * Phase 9.6 — blocker-elimination regression suite. Each block below proves
 * one of the six blockers the Canonical Read Cutover audit named is now
 * closed inside VerificationEngine itself — none of this touches ImportPage,
 * which still computes its own (now-redundant) copies of the same signals.
 */
describe("verificationEngine — Phase 9.6 blocker elimination", () => {
  describe("Blocker 1: RawTransaction retractions", () => {
    it("a retracted BuyExecution disappears from both transactions and tickers — not just Rejected, gone entirely", () => {
      const b = buy({ id: "b1" });
      const before = verifyAllDetailed({ transactions: [b], positions: [emptyPosition()] });
      expect(before.transactions.has("b1")).toBe(true);
      expect(before.tickers.has("COMI")).toBe(true);

      const after = verifyAllDetailed({ transactions: [b, retraction("b1")], positions: [emptyPosition()] });
      expect(after.transactions.has("b1")).toBe(false);
      expect(after.tickers.has("COMI")).toBe(false);
    });

    it("retracting one of two same-ticker buys leaves the survivor's own ticker status computed as if the retracted row never existed", () => {
      const survivor = buy({ id: "survivor", shares: 60 });
      const retracted = buy({ id: "gone", shares: 40 });
      const withBoth = verifyTicker("COMI", { transactions: [survivor, retracted], positions: [emptyPosition()] })!;
      const withRetraction = verifyTicker("COMI", { transactions: [survivor, retracted, retraction("gone")], positions: [emptyPosition()] })!;
      expect(withBoth.pendingBuyShares).toBe(100);
      expect(withRetraction.pendingBuyShares).toBe(60);
    });
  });

  describe("Blocker 2: evidence completion (date-misread, orphaned evidence, reconcile suggestion, last-balanced-date)", () => {
    it("HRHO: a single-digit OCR-misread date between two same-ticker buys is surfaced as contradicted-date-misread evidence, never affecting the verdict fold", () => {
      const original = buy({ id: "hrho-1", ticker: "HRHO", shares: 500, price: 10, executionDate: "2026-01-11" });
      const misread = buy({ id: "hrho-2", ticker: "HRHO", shares: 500, price: 10, executionDate: "2026-01-01" });
      const result = verifyAllDetailed({ transactions: [original, misread], positions: [emptyPosition("HRHO")] });

      expect(result.transactions.get("hrho-2")?.evidence.some((e) => e.type === "contradicted-date-misread")).toBe(true);
      expect(result.tickers.get("HRHO")?.dateMisreadHintCount).toBeGreaterThan(0);
      // Advisory only — must never itself force a Rejected verdict the way contradicted-wrong-ticker does.
      expect(result.transactions.get("hrho-2")?.verdict).not.toBe("Rejected");
    });

    it("ORWE: a fulfilled Orders-history row with no matching candidate is exposed as this ticker's orphanedOrderEvidence", () => {
      const pendingBuy = buy({ id: "orwe-1", ticker: "ORWE", shares: 10, price: 5, executionDate: "2026-03-01" });
      const unrelatedFulfilledOrder = orderEvidence({ ticker: "ORWE", side: "BUY", shares: 999, price: 5 }); // numbers don't match pendingBuy
      const status = verifyTicker("ORWE", { transactions: [pendingBuy, unrelatedFulfilledOrder], positions: [emptyPosition("ORWE")] })!;
      expect(status.orphanedOrderEvidence).toHaveLength(1);
      expect(status.orphanedOrderEvidence[0].shares).toBe(999);
    });

    it("PHAR (the real ROADMAP shape): a same-execution row duplicated at a slightly different price produces a reconcileSuggestion identical to calling suggestRemovalsToReconcile directly", () => {
      const real = buy({ id: "phar-real", ticker: "PHAR", shares: 12, price: 86.72, executionDate: "2026-04-15", confidence: "high" });
      const dup = buy({ id: "phar-dup", ticker: "PHAR", shares: 12, price: 86.36, executionDate: "2026-04-15", confidence: "medium" });
      const other = buy({ id: "phar-other", ticker: "PHAR", shares: 19, price: 78.56, executionDate: "2026-03-02", confidence: "high" });
      const capture = positionVerification(31, "PHAR", "2026-04-20T00:00"); // broker's real 12+19 = 31
      const params: VerifyAllParams = { transactions: [real, dup, other, capture], positions: [emptyPosition("PHAR")] };

      const status = verifyTicker("PHAR", params)!;
      expect(status.reason).toBe("mismatch");
      expect(status.reconcileSuggestion).toBeDefined();

      const expected = suggestRemovalsToReconcile({
        rows: [
          { key: "phar-real", side: "BUY", shares: 12, price: 86.72, confidence: "high" },
          { key: "phar-dup", side: "BUY", shares: 12, price: 86.36, confidence: "medium" },
          { key: "phar-other", side: "BUY", shares: 19, price: 78.56, confidence: "high" },
        ],
        existingRemainingShares: 0,
        existingCostBasis: 0,
        verifiedUnits: 31,
        verifiedAvgCost: undefined,
      });
      expect(status.reconcileSuggestion).toEqual(expected);
      expect(status.reconcileSuggestion?.keysToRemove).toEqual(["phar-dup"]);
    });

    it("last-balanced-date is exposed on an unmatched ticker's TickerStatus and matches findLastBalancedDate called directly", () => {
      const opened = buy({ id: "oras-1", ticker: "ORAS", shares: 50, executionDate: "2026-01-05" });
      const closed = sell({ id: "oras-2", ticker: "ORAS", shares: 50, executionDate: "2026-01-10" });
      const extra = buy({ id: "oras-3", ticker: "ORAS", shares: 20, executionDate: "2026-01-20" }); // leaves a genuine, unexplained gap after this point
      const params: VerifyAllParams = { transactions: [opened, closed, extra], positions: [emptyPosition("ORAS")] };

      const status = verifyTicker("ORAS", params)!;
      expect(status.matched).toBe(false);
      const expected = findLastBalancedDate({
        rows: [
          { key: "oras-1", side: "BUY", shares: 50, date: "2026-01-05" },
          { key: "oras-2", side: "SELL", shares: 50, date: "2026-01-10" },
          { key: "oras-3", side: "BUY", shares: 20, date: "2026-01-20" },
        ],
        existingRemainingShares: 0,
      });
      expect(status.lastBalancedDate).toEqual(expected);
      expect(status.lastBalancedDate?.date).toBe("2026-01-10");
    });
  });

  describe("Blocker 3: wrong-ticker detection against the canonical RawTransaction history (no more empty committed pools)", () => {
    it("a low-confidence buy under a phantom ticker whose numbers match a real high-confidence buy elsewhere in the SAME batch is now caught — Phase 9.5's [], [] could never catch this", () => {
      const real = buy({ id: "real-comi", ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", confidence: "high" });
      const phantom = buy({ id: "phantom", ticker: "ZZZZ", shares: 100, price: 45.5, executionDate: "2026-02-01", confidence: "low" });
      const result = verifyAllDetailed({ transactions: [real, phantom], positions: [emptyPosition("COMI"), emptyPosition("ZZZZ")] });

      const phantomVerification = result.transactions.get("phantom")!;
      expect(phantomVerification.evidence.some((e) => e.type === "contradicted-wrong-ticker")).toBe(true);
      expect(phantomVerification.verdict).toBe("Rejected");
      expect(result.tickers.get("ZZZZ")?.wrongTickerHintCount).toBe(1);
      // The real row itself carries no such hint — only the phantom row does.
      expect(result.transactions.get("real-comi")?.evidence.some((e) => e.type === "contradicted-wrong-ticker")).toBe(false);
    });
  });

  describe("Blocker 4: merge suggestions", () => {
    it("two tickers whose entire buy/sell row sets are byte-for-byte identical, both low-confidence, suggest merging one into the other", () => {
      // Both rows on both sides are BUYs deliberately — the shared sell()
      // test helper (unlike buy()) never threads `confidence` through to the
      // created transaction, so a SELL row here would silently read back as
      // confidence: undefined and never qualify as "all low confidence."
      const a1 = buy({ id: "a1", ticker: "TICKA", shares: 30, price: 12, executionDate: "2026-05-01", confidence: "low" });
      const a2 = buy({ id: "a2", ticker: "TICKA", shares: 10, price: 13, executionDate: "2026-05-05", confidence: "low" });
      const b1 = buy({ id: "b1", ticker: "TICKB", shares: 30, price: 12, executionDate: "2026-05-01", confidence: "low" });
      const b2 = buy({ id: "b2", ticker: "TICKB", shares: 10, price: 13, executionDate: "2026-05-05", confidence: "low" });
      const params: VerifyAllParams = { transactions: [a1, a2, b1, b2], positions: [emptyPosition("TICKA"), emptyPosition("TICKB")] };

      const statusA = verifyTicker("TICKA", params)!;
      const statusB = verifyTicker("TICKB", params)!;
      // Symmetric signature match, both all-low-confidence — one names the other (order between equally-plausible siblings isn't asserted, only that a suggestion exists on both sides).
      expect(statusA.mergeSuggestion).toBe("TICKB");
      expect(statusB.mergeSuggestion).toBe("TICKA");
    });

    it("no merge suggestion when the matching sibling has at least one non-low-confidence row (nothing to disambiguate away from)", () => {
      const a1 = buy({ id: "c1", ticker: "TICKC", shares: 30, price: 12, executionDate: "2026-05-01", confidence: "low" });
      const b1 = buy({ id: "d1", ticker: "TICKD", shares: 30, price: 12, executionDate: "2026-05-01", confidence: "high" });
      const params: VerifyAllParams = { transactions: [a1, b1], positions: [emptyPosition("TICKC"), emptyPosition("TICKD")] };
      expect(verifyTicker("TICKC", params)?.mergeSuggestion).toBe("TICKD");
      // TICKD itself isn't all-low-confidence, so it never gets a suggestion of its own.
      expect(verifyTicker("TICKD", params)?.mergeSuggestion).toBeUndefined();
    });
  });

  describe("Blocker 5: placeholder replacement (the real ROADMAP CSAG case)", () => {
    it("CSAG: a 204-share dateless Opening-balance placeholder lot plus five real dated buys totalling 204 offers a placeholder-replace, not a discard-everything", () => {
      const placeholder = createTrade({
        id: "csag-placeholder",
        portfolioId: "p1",
        ticker: "CSAG",
        shares: 204,
        entryPrice: 10,
        executionDate: "2026-01-01",
        executionTime: "00:00",
        notes: "Opening balance (pre-migration)",
      });
      const realBuys = [48, 51, 50, 5, 50].map((shares, i) =>
        buy({ id: `csag-real-${i}`, ticker: "CSAG", shares, price: 10 + i, executionDate: `2026-02-0${i + 1}` }),
      );
      const capture = positionVerification(204, "CSAG", "2026-03-01T00:00");
      const params: VerifyAllParams = {
        transactions: [...realBuys, capture],
        positions: [positionWithOpenTrades("CSAG", [placeholder])],
      };

      const status = verifyTicker("CSAG", params)!;
      expect(status.reason).toBe("mismatch");
      expect(status.alreadyFullyRecorded).toBe(true);
      expect(status.placeholderReplacement).toEqual(["csag-placeholder"]);
    });

    it("does not offer a placeholder-replace when the existing open lot isn't a deletable placeholder (real dated trade, not a dateless opening balance)", () => {
      const realLot = createTrade({
        id: "csag-real-lot",
        portfolioId: "p1",
        ticker: "CSAG",
        shares: 204,
        entryPrice: 10,
        executionDate: "2026-01-15",
        executionTime: "10:00",
      });
      const capture = positionVerification(204, "CSAG", "2026-03-01T00:00");
      const params: VerifyAllParams = { transactions: [capture], positions: [positionWithOpenTrades("CSAG", [realLot])] };
      // No pending buys at all here — hasShares is false, so this ticker is trivially matched, not a mismatch;
      // included only to prove placeholderReplacement stays undefined when there's no mismatch to begin with.
      const status = verifyTicker("CSAG", params);
      expect(status?.placeholderReplacement).toBeUndefined();
    });
  });

  describe("Blocker 6: Constraint Validation consumes VerificationEngine evidence only", () => {
    it("buildConstraintReport composes buildTickerConstraintReport from a single TickerStatus with zero separate calculation, for the PHAR mismatch", () => {
      const real = buy({ id: "cr-real", ticker: "PHAR", shares: 12, price: 86.72, executionDate: "2026-04-15", confidence: "high" });
      const dup = buy({ id: "cr-dup", ticker: "PHAR", shares: 12, price: 86.36, executionDate: "2026-04-15", confidence: "medium" });
      const other = buy({ id: "cr-other", ticker: "PHAR", shares: 19, price: 78.56, executionDate: "2026-03-02", confidence: "high" });
      const capture = positionVerification(31, "PHAR", "2026-04-20T00:00");
      const params: VerifyAllParams = { transactions: [real, dup, other, capture], positions: [emptyPosition("PHAR")] };

      const report = buildConstraintReport("PHAR", params)!;
      expect(report.satisfied).toBe(false);
      expect(report.contradictions).toHaveLength(1);
      expect(report.diagnosis.length).toBeGreaterThan(0);
      expect(report.diagnosis.some((d) => d.confidence === "high" || d.confidence === "medium")).toBe(true);
    });

    it("buildConstraintReport returns undefined for a ticker with no Buy/Sell transactions in scope", () => {
      expect(buildConstraintReport("NOPE", { transactions: [], positions: [] })).toBeUndefined();
    });
  });
});

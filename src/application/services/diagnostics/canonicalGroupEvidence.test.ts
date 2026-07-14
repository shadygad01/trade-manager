import { describe, expect, it } from "vitest";
import { buildTickerReconciliationEvidence, listAllTickers, summarizeTicker } from "./canonicalGroupEvidence";
import { createRawTransaction, type BuyExecutionPayload, type RawTransaction } from "@domain/entities/RawTransaction";
import { createTrade } from "@domain/entities/Trade";

let seq = 0;
function withSeq(t: Omit<RawTransaction, "seq">): RawTransaction {
  seq += 1;
  return { ...t, seq };
}

const PORTFOLIO = "portfolio-evidence-1";

describe("buildTickerReconciliationEvidence — evidence only, no retract/keep decision", () => {
  it("classifies an orphaned backfill fact as a singleton group with no live sibling", () => {
    const payload: BuyExecutionPayload = { ticker: "TMGH", shares: 35, price: 76.5, executionDate: "2026-03-09" };
    const backfill = withSeq(
      createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "TMGH", payload }),
    );

    const evidence = buildTickerReconciliationEvidence([backfill], [], "TMGH");

    expect(evidence.groups).toHaveLength(1);
    const [group] = evidence.groups;
    expect(group.canonicalKey).toContain("TMGH");
    expect(group.liveCount).toBe(1);
    expect(group.retractedCount).toBe(0);
    expect(group.labels).toEqual(["singleton group", "orphaned backfill"]);
  });

  it("flags a matching retracted higher-authority fact when the excel counterpart was retracted", () => {
    const payload: BuyExecutionPayload = { ticker: "TMGH", shares: 35, price: 76.5, executionDate: "2026-03-09" };
    const backfill = withSeq(
      createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "TMGH", payload }),
    );
    const excel = withSeq(
      createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "TMGH", payload }),
    );
    const retraction = withSeq(
      createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: excel.id, reason: "test cleanup" } }),
    );

    const evidence = buildTickerReconciliationEvidence([backfill, excel, retraction], [], "TMGH");

    expect(evidence.groups).toHaveLength(1);
    const [group] = evidence.groups;
    expect(group.liveCount).toBe(1);
    expect(group.retractedCount).toBe(1);
    expect(group.labels).toEqual(["singleton group", "orphaned backfill", "matching retracted higher-authority fact"]);
    expect(group.facts.find((f) => f.id === excel.id)?.retracted).toBe(true);
  });

  it("classifies a live backfill+excel pair as a duplicate-authority group (the shape reconcileDuplicateAuthority actually converges)", () => {
    const payload: BuyExecutionPayload = { ticker: "ABUK", shares: 14, price: 67.4, executionDate: "2026-06-30" };
    const backfill = withSeq(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "ABUK", payload }));
    const excel = withSeq(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "ABUK", payload }));

    const evidence = buildTickerReconciliationEvidence([backfill, excel], [], "ABUK");

    expect(evidence.groups).toHaveLength(1);
    expect(evidence.groups[0].liveCount).toBe(2);
    expect(evidence.groups[0].labels).toEqual(["duplicate-authority group"]);
  });

  it("classifies two equal-authority live facts as a tie, never as duplicate-authority", () => {
    const payload: BuyExecutionPayload = { ticker: "CSAG", shares: 50, price: 26.5, executionDate: "2026-03-04" };
    const a = withSeq(createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "CSAG", payload }));
    const b = withSeq(createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "CSAG", payload }));

    const evidence = buildTickerReconciliationEvidence([a, b], [], "CSAG");

    expect(evidence.groups[0].labels).toEqual(["skipped: tie"]);
  });

  it("flags the twin-lot guard when 2+ live Trades already legitimately claim the same BUY canonicalKey", () => {
    const payload: BuyExecutionPayload = { ticker: "ORAS", shares: 3, price: 448, executionDate: "2026-02-11" };
    const backfill = withSeq(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "ORAS", payload }));
    const excel = withSeq(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "ORAS", payload }));
    const trades = [
      createTrade({ id: "t1", portfolioId: PORTFOLIO, ticker: "ORAS", shares: 3, entryPrice: 448, executionDate: "2026-02-11", executionTime: "10:00AM" }),
      createTrade({ id: "t2", portfolioId: PORTFOLIO, ticker: "ORAS", shares: 3, entryPrice: 448, executionDate: "2026-02-11", executionTime: "11:00AM" }),
    ];

    const evidence = buildTickerReconciliationEvidence([backfill, excel], trades, "ORAS");

    expect(evidence.groups[0].labels).toEqual(["duplicate-authority group", "skipped: multiple live Trades"]);
  });

  it("flags a conflicting execution time as its own skip reason, distinct from a tie", () => {
    const payloadA: BuyExecutionPayload = { ticker: "ORWE", shares: 89, price: 22.3, executionDate: "2026-02-02", executionTime: "10:00AM" };
    const payloadB: BuyExecutionPayload = { ticker: "ORWE", shares: 89, price: 22.3, executionDate: "2026-02-02", executionTime: "10:05AM" };
    const backfill = withSeq(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "ORWE", payload: payloadA }));
    const excel = withSeq(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "ORWE", payload: payloadB }));

    const evidence = buildTickerReconciliationEvidence([backfill, excel], [], "ORWE");

    expect(evidence.groups[0].labels).toEqual(["duplicate-authority group", "skipped: conflicting execution time"]);
  });

  it("reports wouldEnterSweepPipeline=false when no live fact for the ticker has a resolved portfolio", () => {
    const payload: BuyExecutionPayload = { ticker: "NOPORT", shares: 10, price: 5, executionDate: "2026-01-01" };
    const backfill = withSeq(createRawTransaction({ kind: "BuyExecution", source: "backfill", ticker: "NOPORT", payload }));

    const evidence = buildTickerReconciliationEvidence([backfill], [], "NOPORT");

    expect(evidence.wouldEnterSweepPipeline).toBe(false);
  });

  it("reports wouldEnterSweepPipeline=true once at least one live fact resolves a portfolio", () => {
    const payload: BuyExecutionPayload = { ticker: "HASPORT", shares: 10, price: 5, executionDate: "2026-01-01" };
    const backfill = withSeq(createRawTransaction({ kind: "BuyExecution", source: "backfill", portfolioId: PORTFOLIO, ticker: "HASPORT", payload }));

    const evidence = buildTickerReconciliationEvidence([backfill], [], "HASPORT");

    expect(evidence.wouldEnterSweepPipeline).toBe(true);
  });

  it("includes a fully-retracted-pair ticker in evidence with liveCount 0 (visible, not hidden)", () => {
    const payload: BuyExecutionPayload = { ticker: "ALLGONE", shares: 1, price: 1, executionDate: "2026-01-01" };
    const fact = withSeq(createRawTransaction({ kind: "BuyExecution", source: "manual", portfolioId: PORTFOLIO, ticker: "ALLGONE", payload }));
    const retraction = withSeq(createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: fact.id } }));

    const evidence = buildTickerReconciliationEvidence([fact, retraction], [], "ALLGONE");

    expect(evidence.groups).toHaveLength(1);
    expect(evidence.groups[0].liveCount).toBe(0);
    expect(evidence.groups[0].retractedCount).toBe(1);
    expect(evidence.wouldEnterSweepPipeline).toBe(false);
  });
});

describe("listAllTickers / summarizeTicker — every ticker must be discoverable, none hidden", () => {
  it("lists every ticker with any live or retracted Buy/Sell fact, sorted", () => {
    const p1: BuyExecutionPayload = { ticker: "ZZZ", shares: 1, price: 1, executionDate: "2026-01-01" };
    const p2: BuyExecutionPayload = { ticker: "AAA", shares: 1, price: 1, executionDate: "2026-01-01" };
    const a = withSeq(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "ZZZ", payload: p1 }));
    const b = withSeq(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "AAA", payload: p2 }));

    expect(listAllTickers([a, b])).toEqual(["AAA", "ZZZ"]);
  });

  it("summarizeTicker rolls up group labels into counts a ticker-overview table can render without hiding zero rows", () => {
    const payload: BuyExecutionPayload = { ticker: "SUMM", shares: 10, price: 20, executionDate: "2026-01-01" };
    const onlyFact = withSeq(createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", portfolioId: PORTFOLIO, ticker: "SUMM", payload }));

    const evidence = buildTickerReconciliationEvidence([onlyFact], [], "SUMM");
    const summary = summarizeTicker(evidence);

    expect(summary).toEqual({
      ticker: "SUMM",
      wouldEnterSweepPipeline: true,
      liveFactCount: 1,
      retractedFactCount: 0,
      groupCount: 1,
      singletonGroupCount: 1,
      duplicateAuthorityGroupCount: 0,
      orphanedBackfillGroupCount: 0,
      matchingRetractedHigherAuthorityGroupCount: 0,
    });
  });
});

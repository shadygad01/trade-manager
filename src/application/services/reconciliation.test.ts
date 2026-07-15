import { describe, it, expect } from "vitest";
import {
  reconcilePositions,
  suggestDuplicateTradeIds,
  findPendingConfirmations,
  isTickerFullyOfficialBrokerExcelSourced,
  isTickerOfficialBrokerExcelCoveredByCandidates,
} from "./reconciliation";
import { createTrade } from "@domain/entities/Trade";
import { createTradeAllocation } from "@domain/entities/TradeAllocation";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { PositionAggregate } from "./TradeService";

function buyFact(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"]; supersedes?: string } = {}): RawTransaction {
  const { id, source, supersedes, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "COMI", shares: 10, price: 41.5, executionDate: "2026-01-14", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", ticker: payload.ticker, payload, supersedes }), seq: 1 };
}

function position(ticker: string, totalShares: number): PositionAggregate {
  return { ticker, totalShares, costBasis: 0, avgCost: 0, openTrades: [] };
}

function verification(overrides: Partial<PositionVerification> = {}): PositionVerification {
  return {
    id: "v1",
    portfolioId: "p1",
    ticker: "COMI",
    units: 100,
    capturedAt: "2026-06-01T00:00",
    source: "screenshot",
    ...overrides,
  };
}

describe("reconcilePositions", () => {
  it("flags no mismatch when computed matches verified", () => {
    const [result] = reconcilePositions([position("COMI", 100)], [verification()], [], [], []);
    expect(result.quantityMismatch).toBe(false);
    expect(result.quantityShortfall).toBe(false);
  });

  it("flags quantityMismatch when computed exceeds verified", () => {
    const [result] = reconcilePositions([position("COMI", 150)], [verification()], [], [], []);
    expect(result.quantityMismatch).toBe(true);
    expect(result.quantityShortfall).toBe(false);
  });

  it("flags quantityShortfall when computed is below verified", () => {
    const [result] = reconcilePositions([position("COMI", 50)], [verification()], [], [], []);
    expect(result.quantityShortfall).toBe(true);
    expect(result.quantityMismatch).toBe(false);
  });

  it("suppresses mismatch flags when a newer trade explains the gap (stale verification)", () => {
    const trade = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 50,
      entryPrice: 10,
      executionDate: "2026-06-15",
      executionTime: "10:00",
    });
    const [result] = reconcilePositions([position("COMI", 150)], [verification()], [trade], [], []);
    expect(result.verificationStale).toBe(true);
    expect(result.quantityMismatch).toBe(false);
    expect(result.quantityShortfall).toBe(false);
  });

  it("suppresses mismatch when a newer sell allocation explains the gap", () => {
    const allocation = createTradeAllocation({
      id: "a1",
      sellGroupId: "sg1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "COMI",
      sharesClosed: 50,
      exitPrice: 12,
      executionDate: "2026-06-20",
      executionTime: "10:00",
    });
    const [result] = reconcilePositions([position("COMI", 50)], [verification()], [], [allocation], []);
    expect(result.verificationStale).toBe(true);
    expect(result.quantityShortfall).toBe(false);
  });

  it("uses the most recent verification when multiple exist for a ticker", () => {
    const older = verification({ id: "v-old", capturedAt: "2026-01-01T00:00", units: 999 });
    const newer = verification({ id: "v-new", capturedAt: "2026-06-01T00:00", units: 100 });
    const [result] = reconcilePositions([position("COMI", 100)], [older, newer], [], [], []);
    expect(result.verifiedUnits).toBe(100);
    expect(result.quantityMismatch).toBe(false);
  });

  it("reports a verified position even when there are zero computed shares (shortfall)", () => {
    const [result] = reconcilePositions([], [verification({ units: 30 })], [], [], []);
    expect(result.computedShares).toBe(0);
    expect(result.quantityShortfall).toBe(true);
  });

  it("skips tickers with no verification at all", () => {
    const results = reconcilePositions([position("HRHO", 10)], [], [], [], []);
    expect(results).toHaveLength(0);
  });

  it("never produces a row for a ticker fully sourced from the official broker Excel export, even when the computed count disagrees with a screenshot on file", () => {
    const facts = [
      buyFact({ id: "b1", source: "official-broker-excel", shares: 10 }),
      buyFact({ id: "b2", source: "official-broker-excel", shares: 90 }),
    ];
    // computed (100) intentionally disagrees with the verified screenshot
    // (30) — per the broker-record trust policy this must never surface as
    // a mismatch/shortfall/stale row at all, since the whole "My Position"
    // comparison no longer applies to this ticker.
    const results = reconcilePositions([position("COMI", 100)], [verification({ units: 30 })], [], [], facts);
    expect(results).toHaveLength(0);
  });

  it("still reconciles normally when a ticker's history is only partly official-broker-excel-sourced", () => {
    const facts = [buyFact({ id: "b1", source: "official-broker-excel" }), buyFact({ id: "b2", source: "manual" })];
    const results = reconcilePositions([position("COMI", 150)], [verification()], [], [], facts);
    expect(results).toHaveLength(1);
    expect(results[0].quantityMismatch).toBe(true);
  });
});

describe("isTickerFullyOfficialBrokerExcelSourced", () => {
  it("is true when every live Buy/Sell fact for the ticker came from the official broker Excel export", () => {
    const facts = [buyFact({ id: "b1", source: "official-broker-excel" }), buyFact({ id: "b2", source: "official-broker-excel" })];
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "COMI")).toBe(true);
  });

  it("is false when even one fact for the ticker came from a different source", () => {
    const facts = [buyFact({ id: "b1", source: "official-broker-excel" }), buyFact({ id: "b2", source: "manual" })];
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "COMI")).toBe(false);
  });

  it("ignores a lower-authority duplicate when an official fact describes the same time-resolved execution", () => {
    const facts = [
      buyFact({ id: "official", source: "official-broker-excel", executionTime: "10:32AM" }),
      buyFact({ id: "backfill", source: "backfill", executionTime: "10:32" }),
    ];
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "COMI")).toBe(true);
  });

  it("does not hide a lower-authority fact when its time proves it is a different execution", () => {
    const facts = [
      buyFact({ id: "official", source: "official-broker-excel", executionTime: "10:32AM" }),
      buyFact({ id: "backfill", source: "backfill", executionTime: "10:34AM" }),
    ];
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "COMI")).toBe(false);
  });

  it("is false for a ticker with zero facts at all — nothing to be 'fully' anything of", () => {
    expect(isTickerFullyOfficialBrokerExcelSourced([], "COMI")).toBe(false);
  });

  it("ignores a retracted official-broker-excel fact, falling back to false once nothing live remains", () => {
    const fact = buyFact({ id: "b1", source: "official-broker-excel" });
    const retraction = { ...createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: "b1" } }), seq: 2 };
    expect(isTickerFullyOfficialBrokerExcelSourced([fact, retraction], "COMI")).toBe(false);
  });

  it("does not reopen the screenshot gate when a matching lower-authority backfill is the only live twin of a retracted official fact", () => {
    const official = buyFact({ id: "official", source: "official-broker-excel", executionTime: "10:32" });
    const backfill = buyFact({ id: "backfill", source: "backfill", executionTime: "10:32" });
    const retraction = {
      ...createRawTransaction({
        kind: "Retraction",
        source: "manual",
        payload: { targetId: official.id, reason: "Duplicate cleanup" },
      }),
      seq: 3,
    };
    expect(isTickerFullyOfficialBrokerExcelSourced([official, backfill, retraction], "COMI")).toBe(true);
  });

  // Systemic audit finding: a fact's own `ticker` field is immutable — a
  // ticker rename/correction (TradeService.renameTickerEverywhere) is its
  // own separate Correction fact, never an edit in place. Reading
  // `payload.ticker` directly (the pre-fix implementation) silently stopped
  // recognizing a renamed ticker's facts under its NEW name at all.
  it("still recognizes a ticker as fully Excel-sourced after it's been renamed via a Correction fact", () => {
    const fact = buyFact({ id: "b1", source: "official-broker-excel", ticker: "COMI" });
    const correction = {
      ...createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId: "b1", patch: { ticker: "HRHO" } } }),
      seq: 2,
    };
    expect(isTickerFullyOfficialBrokerExcelSourced([fact, correction], "HRHO")).toBe(true);
    // The OLD ticker name no longer resolves to this fact at all.
    expect(isTickerFullyOfficialBrokerExcelSourced([fact, correction], "COMI")).toBe(false);
  });

  // Real, reported bug: a closed ticker whose sole surviving history is an
  // Invoice (evidenceAuthority.ts rank 6, strictly ABOVE official-broker-excel's
  // rank 5) still hit the "closed-position, no corroboration" dead-end
  // because the old check demanded the literal string "official-broker-excel"
  // rather than comparing authority rank — even though an Invoice is
  // objectively more trustworthy than the Excel export this function was
  // originally written to trust.
  it("is true when every live fact outranks official-broker-excel (e.g. invoice), not just an exact source match", () => {
    const facts = [buyFact({ id: "b1", source: "invoice" })];
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "COMI")).toBe(true);
  });

  it("is still false for a source that ranks below official-broker-excel even if not literally 'manual'", () => {
    const facts = [buyFact({ id: "b1", source: "screenshot" })];
    expect(isTickerFullyOfficialBrokerExcelSourced(facts, "COMI")).toBe(false);
  });
});

describe("isTickerOfficialBrokerExcelCoveredByCandidates", () => {
  it("covers a live legacy/backfill fact when the current official workbook has the exact execution", () => {
    const legacy = buyFact({ id: "legacy", source: "backfill", shares: 27, price: 12.5, executionDate: "2024-08-20" });
    expect(
      isTickerOfficialBrokerExcelCoveredByCandidates(
        [legacy],
        "COMI",
        [{ ticker: "COMI", side: "BUY", shares: 27, price: 12.5, date: "2024-08-20", source: "official-broker-excel" }],
      ),
    ).toBe(true);
  });

  it("does not cover an unrelated lower-authority execution", () => {
    const legacy = buyFact({ id: "legacy", source: "backfill", shares: 27, price: 12.5, executionDate: "2024-08-20" });
    expect(
      isTickerOfficialBrokerExcelCoveredByCandidates(
        [legacy],
        "COMI",
        [{ ticker: "COMI", side: "BUY", shares: 27, price: 12.6, date: "2024-08-20", source: "official-broker-excel" }],
      ),
    ).toBe(false);
  });

  it("recognizes a fully official closed workbook when legacy raw facts are absent", () => {
    expect(
      isTickerOfficialBrokerExcelCoveredByCandidates(
        [],
        "ADPC",
        [
          { ticker: "ADPC", side: "BUY", shares: 500, price: 1.8, date: "2022-11-27", source: "official-broker-excel" },
          { ticker: "ADPC", side: "SELL", shares: 500, price: 1.86, date: "2022-11-28", source: "official-broker-excel" },
        ],
        0,
      ),
    ).toBe(true);
  });

  it("does not require the saved workbook candidate subset to net to zero", () => {
    expect(
      isTickerOfficialBrokerExcelCoveredByCandidates(
        [],
        "ADPC",
        [{ ticker: "ADPC", side: "BUY", shares: 500, price: 1.8, date: "2022-11-27", source: "official-broker-excel" }],
        0,
      ),
    ).toBe(true);
  });
});

describe("suggestDuplicateTradeIds", () => {
  it("picks the single lowest-priced deletable trade when only one duplicate exists", () => {
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 50, shares: 100, remainingShares: 100 },
        { id: "t2", entryPrice: 48, shares: 100, remainingShares: 100 },
        { id: "t3", entryPrice: 55, shares: 100, remainingShares: 100 },
      ],
      computedShares: 300,
      verifiedUnits: 200,
    });
    expect(suggested).toEqual(["t2"]);
  });

  it("delegates to the canonical avg-cost-ranked solver when a verified avg cost is available — picking the subset whose surviving avg cost is closest to it", () => {
    // Removing t1 (50) leaves t2+t3, implied avg (48+55)/2 = 51.5 — farther
    // from the broker's 54 than removing t2 (48), which leaves t1+t3, avg
    // (50+55)/2 = 52.5. The canonical solver correctly prefers removing t2.
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 50, shares: 100, remainingShares: 100 },
        { id: "t2", entryPrice: 48, shares: 100, remainingShares: 100 },
        { id: "t3", entryPrice: 55, shares: 100, remainingShares: 100 },
      ],
      computedShares: 300,
      verifiedUnits: 200,
      verifiedAvgCost: 54,
    });
    expect(suggested).toEqual(["t2"]);
  });

  it("returns every trade needed to close a gap spanning more than one duplicate", () => {
    // Three 100-share buys (t1 kept, t2/t3 duplicates) computed at 300 vs. a
    // broker-verified 100 — both duplicates must go in one pass, not just one.
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 50, shares: 100, remainingShares: 100 },
        { id: "t2", entryPrice: 48, shares: 100, remainingShares: 100 },
        { id: "t3", entryPrice: 47, shares: 100, remainingShares: 100 },
      ],
      computedShares: 300,
      verifiedUnits: 100,
    });
    expect(suggested.sort()).toEqual(["t2", "t3"]);
  });

  it("never suggests a trade that already has shares sold against it", () => {
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "t1", entryPrice: 10, shares: 100, remainingShares: 40 },
        { id: "t2", entryPrice: 50, shares: 100, remainingShares: 100 },
      ],
      computedShares: 200,
      verifiedUnits: 100,
    });
    expect(suggested).toEqual(["t2"]);
  });

  it("skips a trade that would undershoot into a shortfall, trying a different one instead", () => {
    // Gap is 50, but the lowest-priced trade is 100 shares — removing it
    // would leave 250 computed vs. 300 verified (a new shortfall), so it's
    // skipped in favor of the 50-share trade that closes the gap exactly.
    const suggested = suggestDuplicateTradeIds({
      openTrades: [
        { id: "big", entryPrice: 10, shares: 100, remainingShares: 100 },
        { id: "exact", entryPrice: 20, shares: 50, remainingShares: 50 },
      ],
      computedShares: 350,
      verifiedUnits: 300,
    });
    expect(suggested).toEqual(["exact"]);
  });

  it("returns an empty list when nothing is deletable", () => {
    const suggested = suggestDuplicateTradeIds({
      openTrades: [{ id: "t1", entryPrice: 10, shares: 100, remainingShares: 40 }],
      computedShares: 100,
      verifiedUnits: 0,
    });
    expect(suggested).toEqual([]);
  });

  it("returns an empty list for an empty trade list", () => {
    expect(suggestDuplicateTradeIds({ openTrades: [], computedShares: 0, verifiedUnits: 0 })).toEqual([]);
  });
});

describe("findPendingConfirmations", () => {
  it("returns one BUY entry per pending trade, and ignores a verified/ordinary trade", () => {
    const pending = createTrade({
      id: "t1",
      portfolioId: "p1",
      ticker: "ABUK",
      shares: 29,
      entryPrice: 41.17,
      executionDate: "2026-02-26",
      executionTime: "10:54",
    });
    pending.confirmationStatus = "pending";
    const ordinary = createTrade({
      id: "t2",
      portfolioId: "p1",
      ticker: "COMI",
      shares: 100,
      entryPrice: 50,
      executionDate: "2026-01-05",
      executionTime: "10:30",
    });

    const results = findPendingConfirmations([pending, ordinary], []);
    expect(results).toEqual([
      { ticker: "ABUK", side: "BUY", date: "2026-02-26", time: "10:54", shares: 29, price: 41.17, refId: "t1" },
    ]);
  });

  it("groups a pending sell's allocations by sellGroupId into one SELL entry with summed shares", () => {
    const allocation1 = createTradeAllocation({
      id: "a1",
      sellGroupId: "g1",
      portfolioId: "p1",
      tradeId: "t1",
      ticker: "ABUK",
      sharesClosed: 20,
      exitPrice: 41.17,
      executionDate: "2026-02-26",
      executionTime: "10:54",
    });
    allocation1.confirmationStatus = "pending";
    const allocation2 = createTradeAllocation({
      id: "a2",
      sellGroupId: "g1",
      portfolioId: "p1",
      tradeId: "t2",
      ticker: "ABUK",
      sharesClosed: 9,
      exitPrice: 41.17,
      executionDate: "2026-02-26",
      executionTime: "10:54",
    });
    allocation2.confirmationStatus = "pending";
    const verifiedAllocation = createTradeAllocation({
      id: "a3",
      sellGroupId: "g2",
      portfolioId: "p1",
      tradeId: "t3",
      ticker: "COMI",
      sharesClosed: 100,
      exitPrice: 60,
      executionDate: "2026-02-01",
      executionTime: "11:00",
    });

    const results = findPendingConfirmations([], [allocation1, allocation2, verifiedAllocation]);
    expect(results).toEqual([
      { ticker: "ABUK", side: "SELL", date: "2026-02-26", time: "10:54", shares: 29, price: 41.17, refId: "g1" },
    ]);
  });

  it("returns an empty list when nothing is pending", () => {
    expect(findPendingConfirmations([], [])).toEqual([]);
  });
});

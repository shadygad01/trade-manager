import { describe, it, expect } from "vitest";
import type { ParsedOrderEvidence, ParsedTradeCandidate } from "@domain/entities/Upload";
import { findOrderConfirmedKeys, findOrphanedFulfilledEvidence, findWrongTickerHintsFromOrders, orderEvidenceContentKey } from "./orderEvidence";

function evidence(overrides: Partial<ParsedOrderEvidence> = {}): ParsedOrderEvidence {
  return {
    ticker: "SKPC",
    side: "BUY",
    orderType: "limit",
    shares: 30,
    price: 14.85,
    totalValue: 445.5,
    status: "fulfilled",
    ...overrides,
  };
}

function candidate(overrides: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return {
    ticker: "SKPC",
    side: "BUY",
    shares: 30,
    price: 14.85,
    date: "2026-02-10",
    confidence: "medium",
    ...overrides,
  };
}

describe("orderEvidenceContentKey", () => {
  it("is identical for the same row read from two overlapping screenshots and differs when any field differs", () => {
    expect(orderEvidenceContentKey(evidence())).toBe(orderEvidenceContentKey(evidence()));
    expect(orderEvidenceContentKey(evidence())).not.toBe(orderEvidenceContentKey(evidence({ status: "cancelled" })));
    expect(orderEvidenceContentKey(evidence())).not.toBe(orderEvidenceContentKey(evidence({ totalValue: 890.1 })));
  });
});

describe("findOrderConfirmedKeys", () => {
  it("confirms a pending candidate matched by a fulfilled order (same ticker/side/shares, close price)", () => {
    // A statement-derived price is commission-inclusive, so slightly above the order price.
    const keys = findOrderConfirmedKeys([{ key: "a", candidate: candidate({ price: 14.92 }) }], [evidence()]);
    expect(keys.has("a")).toBe(true);
  });

  it("never lets a cancelled order confirm anything", () => {
    const keys = findOrderConfirmedKeys([{ key: "a", candidate: candidate() }], [evidence({ status: "cancelled" })]);
    expect(keys.size).toBe(0);
  });

  it("requires the share count to match exactly and the price to be within tolerance", () => {
    const wrongShares = findOrderConfirmedKeys([{ key: "a", candidate: candidate({ shares: 29 }) }], [evidence()]);
    expect(wrongShares.size).toBe(0);
    const wrongPrice = findOrderConfirmedKeys([{ key: "a", candidate: candidate({ price: 22.5 }) }], [evidence()]);
    expect(wrongPrice.size).toBe(0);
  });

  it("consumes each order once — one real order can't confirm both copies of a double-extracted transaction", () => {
    const keys = findOrderConfirmedKeys(
      [
        { key: "a", candidate: candidate() },
        { key: "b", candidate: candidate() },
      ],
      [evidence()],
    );
    expect(keys.size).toBe(1);
  });

  it("confirms both copies when the order history genuinely shows two identical orders", () => {
    const keys = findOrderConfirmedKeys(
      [
        { key: "a", candidate: candidate() },
        { key: "b", candidate: candidate() },
      ],
      [evidence(), evidence()],
    );
    expect(keys.size).toBe(2);
  });
});

describe("findOrderConfirmedKeys — dated Transactions-list evidence", () => {
  function txnEvidence(overrides: Partial<ParsedOrderEvidence> = {}): ParsedOrderEvidence {
    return {
      ticker: "JUFO",
      side: "SELL",
      date: "2023-01-17",
      totalValue: 737.96,
      status: "fulfilled",
      ...overrides,
    };
  }

  it("confirms a pending candidate by ticker/side/date, checking total against shares × price", () => {
    const keys = findOrderConfirmedKeys(
      [{ key: "a", candidate: candidate({ ticker: "JUFO", side: "SELL", date: "2023-01-17", shares: 90, price: 8.2 }) }],
      [txnEvidence()],
    );
    expect(keys.has("a")).toBe(true);
  });

  it("requires the date to match exactly, unlike the undated Orders-timeline shape", () => {
    const keys = findOrderConfirmedKeys(
      [{ key: "a", candidate: candidate({ ticker: "JUFO", side: "SELL", date: "2023-01-16", shares: 90, price: 8.2 }) }],
      [txnEvidence()],
    );
    expect(keys.size).toBe(0);
  });

  it("rejects a total that doesn't correspond to shares × price", () => {
    const keys = findOrderConfirmedKeys(
      [{ key: "a", candidate: candidate({ ticker: "JUFO", side: "SELL", date: "2023-01-17", shares: 10, price: 8.2 }) }],
      [txnEvidence()],
    );
    expect(keys.size).toBe(0);
  });
});

describe("findOrphanedFulfilledEvidence", () => {
  it("returns fulfilled evidence with no matching pending candidate, grouped by normalized ticker", () => {
    const orphaned = findOrphanedFulfilledEvidence(
      [{ key: "a", candidate: candidate() }],
      [evidence(), evidence({ ticker: "tmgh", side: "BUY", date: "2024-08-05", shares: undefined, price: undefined, totalValue: 603.55 })],
    );
    expect(orphaned.size).toBe(1);
    expect(orphaned.get("TMGH")).toHaveLength(1);
    expect(orphaned.has("SKPC")).toBe(false);
  });

  it("returns an empty map when every fulfilled row matches a candidate", () => {
    const orphaned = findOrphanedFulfilledEvidence([{ key: "a", candidate: candidate() }], [evidence()]);
    expect(orphaned.size).toBe(0);
  });

  it("ignores cancelled evidence rows entirely", () => {
    const orphaned = findOrphanedFulfilledEvidence([], [evidence({ status: "cancelled" })]);
    expect(orphaned.size).toBe(0);
  });

  it("consumes each evidence row at most once — two identical fulfilled rows against one candidate leaves one orphaned", () => {
    const orphaned = findOrphanedFulfilledEvidence(
      [{ key: "a", candidate: candidate() }],
      [evidence(), evidence()],
    );
    expect(orphaned.get("SKPC")).toHaveLength(1);
  });

  it("treats dated Transactions-shape evidence as orphaned when the date doesn't match any candidate", () => {
    const orphaned = findOrphanedFulfilledEvidence(
      [{ key: "a", candidate: candidate({ ticker: "JUFO", side: "SELL", date: "2023-01-16", shares: 90, price: 8.2 }) }],
      [{ ticker: "JUFO", side: "SELL", date: "2023-01-17", totalValue: 737.96, status: "fulfilled" }],
    );
    expect(orphaned.get("JUFO")).toHaveLength(1);
  });
});

describe("findWrongTickerHintsFromOrders", () => {
  it("hints at the ticker whose fulfilled order matches a misfiled candidate's numbers", () => {
    // The reported real shape: SUGR's execution OCR'd under an HRHO guess —
    // HRHO has no matching order, SUGR's order matches exactly.
    const hints = findWrongTickerHintsFromOrders(
      [{ key: "a", candidate: candidate({ ticker: "HRHO", shares: 6, price: 45.92, confidence: "low" }) }],
      [evidence({ ticker: "SUGR", shares: 6, price: 45.92, totalValue: 275.52 })],
    );
    expect(hints.get("a")).toBe("SUGR");
  });

  it("stays silent when the candidate's own ticker has a matching fulfilled order", () => {
    const hints = findWrongTickerHintsFromOrders(
      [{ key: "a", candidate: candidate() }],
      [evidence(), evidence({ ticker: "ORHD" })],
    );
    expect(hints.size).toBe(0);
  });

  it("never overrides a high-confidence ticker read", () => {
    const hints = findWrongTickerHintsFromOrders(
      [{ key: "a", candidate: candidate({ ticker: "HRHO", confidence: "high" }) }],
      [evidence({ ticker: "SUGR" })],
    );
    expect(hints.size).toBe(0);
  });

  it("stays silent when more than one other ticker's orders match (no basis to pick)", () => {
    const hints = findWrongTickerHintsFromOrders(
      [{ key: "a", candidate: candidate({ ticker: "HRHO", confidence: "low" }) }],
      [evidence({ ticker: "SUGR" }), evidence({ ticker: "ORHD" })],
    );
    expect(hints.size).toBe(0);
  });
});

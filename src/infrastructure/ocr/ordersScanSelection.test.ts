import { describe, it, expect } from "vitest";
import { flatResultIsDeficient, missingFulfilledCount, shouldPreferRowScan } from "./ordersScanSelection";
import type { OrderRowsParseResult, OrdersScreenParseResult } from "./parsers/BrokerParser";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

function candidate(shares: number): ParsedTradeCandidate {
  return {
    ticker: "CSAG",
    companyName: "Canal Shipping Agencies",
    side: "BUY",
    confidence: "high",
    shares,
    price: 30,
    date: "2026-02-19",
  };
}

function flat(overrides: Partial<OrdersScreenParseResult> = {}): OrdersScreenParseResult {
  return { candidates: [], incompleteRowCount: 0, fulfilledStatusCount: 0, statusCountMismatch: false, ...overrides };
}

function rowScan(overrides: Partial<OrderRowsParseResult> = {}): OrderRowsParseResult {
  return {
    candidates: [],
    incompleteRowCount: 0,
    fulfilledStatusCount: 0,
    statusCountMismatch: false,
    resolvedRowCount: 0,
    ...overrides,
  };
}

describe("missingFulfilledCount", () => {
  it("counts fulfilled statuses that produced no candidate", () => {
    expect(missingFulfilledCount(flat({ candidates: [candidate(50)], fulfilledStatusCount: 2 }))).toBe(1);
  });

  it("does not count out-of-range exclusions as missing (they have their own warning)", () => {
    expect(
      missingFulfilledCount(flat({ candidates: [candidate(50)], fulfilledStatusCount: 2, outOfRangeCount: 1 })),
    ).toBe(0);
  });

  it("never goes negative when cancelled rows outnumber fulfilled ones", () => {
    expect(missingFulfilledCount(flat({ candidates: [candidate(50)], fulfilledStatusCount: 0 }))).toBe(0);
  });
});

describe("flatResultIsDeficient", () => {
  it("is deficient when no candidates were extracted at all", () => {
    expect(flatResultIsDeficient(flat())).toBe(true);
  });

  it("is deficient when the screenshot shows more fulfilled orders than were extracted", () => {
    // The reported CSAG case: 5 visibly Fulfilled orders, 4 extracted.
    expect(
      flatResultIsDeficient(
        flat({ candidates: [candidate(50), candidate(5), candidate(50), candidate(51)], fulfilledStatusCount: 5 }),
      ),
    ).toBe(true);
  });

  it("is deficient on an incomplete row or a status-count mismatch", () => {
    expect(flatResultIsDeficient(flat({ candidates: [candidate(50)], fulfilledStatusCount: 1, incompleteRowCount: 1 }))).toBe(true);
    expect(flatResultIsDeficient(flat({ candidates: [candidate(50)], fulfilledStatusCount: 1, statusCountMismatch: true }))).toBe(true);
  });

  it("is not deficient when every visible fulfilled order was extracted cleanly", () => {
    expect(flatResultIsDeficient(flat({ candidates: [candidate(50), candidate(5)], fulfilledStatusCount: 2 }))).toBe(false);
  });
});

describe("shouldPreferRowScan", () => {
  const partialFlat = flat({
    candidates: [candidate(50), candidate(5), candidate(50), candidate(51)],
    fulfilledStatusCount: 5,
  });

  it("never trusts a row scan that resolved nothing", () => {
    expect(shouldPreferRowScan(flat(), rowScan({ candidates: [candidate(50)] }))).toBe(false);
  });

  it("trusts any resolved row scan when the flat parse found nothing — including a correct all-cancelled zero", () => {
    expect(shouldPreferRowScan(flat(), rowScan({ resolvedRowCount: 3 }))).toBe(true);
  });

  it("prefers a row scan that recovers more candidates than a partial flat parse", () => {
    const fullRowScan = rowScan({
      candidates: [candidate(50), candidate(5), candidate(50), candidate(51), candidate(48)],
      fulfilledStatusCount: 5,
      resolvedRowCount: 5,
    });
    expect(shouldPreferRowScan(partialFlat, fullRowScan)).toBe(true);
  });

  it("keeps the flat result when the row scan would lose candidates", () => {
    const worseRowScan = rowScan({ candidates: [candidate(50)], fulfilledStatusCount: 1, resolvedRowCount: 1 });
    expect(shouldPreferRowScan(partialFlat, worseRowScan)).toBe(false);
  });

  it("on an equal candidate count, switches only when the row scan reports fewer problems", () => {
    const equalClean = rowScan({
      candidates: [candidate(50), candidate(5), candidate(50), candidate(51)],
      fulfilledStatusCount: 4,
      resolvedRowCount: 4,
    });
    expect(shouldPreferRowScan(partialFlat, equalClean)).toBe(true);

    const equalAlsoMissing = rowScan({
      candidates: [candidate(50), candidate(5), candidate(50), candidate(51)],
      fulfilledStatusCount: 5,
      resolvedRowCount: 5,
      incompleteRowCount: 1,
    });
    expect(shouldPreferRowScan(partialFlat, equalAlsoMissing)).toBe(false);
  });
});

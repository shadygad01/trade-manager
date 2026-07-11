import { describe, expect, it } from "vitest";
import { buildCoverageClaims, isDateAlreadyCovered, hasOrdersHistoryFor } from "./evidenceCoverage";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload } from "@domain/entities/RawTransaction";

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"]; sourceUploadId?: string } = {}): RawTransaction {
  const { id, source, sourceUploadId, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "CSAG", shares: 10, price: 41.5, executionDate: "2026-01-14", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "manual", sourceUploadId, ticker: payload.ticker, payload }), seq: 1 };
}

describe("evidenceCoverage.buildCoverageClaims", () => {
  it("a Statement upload's coverage is the date range of the rows it actually contains", () => {
    const claims = buildCoverageClaims([
      buy({ id: "s1", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-05" }),
      buy({ id: "s2", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-28" }),
    ]);
    expect(claims).toEqual([{ kind: "date-range", sourceUploadId: "u1", documentType: "statement", from: "2026-01-05", to: "2026-01-28" }]);
  });

  it("an Orders-screen upload's coverage is ticker-history, keyed to its own ticker", () => {
    const claims = buildCoverageClaims([
      buy({ id: "o1", source: "orders-screen", sourceUploadId: "u2", ticker: "SKPC", executionDate: "2026-01-13" }),
      buy({ id: "o2", source: "orders-screen", sourceUploadId: "u2", ticker: "SKPC", executionDate: "2026-01-27" }),
    ]);
    expect(claims).toEqual([{ kind: "ticker-history", sourceUploadId: "u2", documentType: "orders", ticker: "SKPC", from: "2026-01-13", to: "2026-01-27" }]);
  });

  it("an Invoice upload's coverage is a single exact execution, never a range", () => {
    const claims = buildCoverageClaims([buy({ id: "i1", source: "invoice", sourceUploadId: "u3", executionDate: "2026-01-14" })]);
    expect(claims).toEqual([{ kind: "exact-execution", sourceUploadId: "u3", documentType: "invoice", ticker: "CSAG", date: "2026-01-14" }]);
  });

  it("retracted facts contribute no coverage — a fully-voided upload proves nothing", () => {
    const live = buy({ id: "s1", source: "statement", sourceUploadId: "u1" });
    const retraction = createRawTransaction({ kind: "Retraction", source: "manual", payload: { targetId: "s1" } });
    const claims = buildCoverageClaims([live, { ...retraction, seq: 2 }]);
    expect(claims).toEqual([]);
  });

  it("an official-broker-excel upload's coverage is one ticker-history claim per ticker it actually contains, not one for the whole upload", () => {
    const claims = buildCoverageClaims([
      buy({ id: "b1", source: "official-broker-excel", sourceUploadId: "u4", ticker: "EAST", executionDate: "2026-06-01" }),
      buy({ id: "b2", source: "official-broker-excel", sourceUploadId: "u4", ticker: "EAST", executionDate: "2026-06-20" }),
      buy({ id: "b3", source: "official-broker-excel", sourceUploadId: "u4", ticker: "ABUK", executionDate: "2026-05-10" }),
    ]);
    expect(claims).toHaveLength(2);
    expect(claims).toEqual(
      expect.arrayContaining([
        { kind: "ticker-history", sourceUploadId: "u4", documentType: "orders", ticker: "EAST", from: "2026-06-01", to: "2026-06-20" },
        { kind: "ticker-history", sourceUploadId: "u4", documentType: "orders", ticker: "ABUK", from: "2026-05-10", to: "2026-05-10" },
      ]),
    );
  });

  it("one upload never produces more than one claim, even with several rows", () => {
    const claims = buildCoverageClaims([
      buy({ id: "s1", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-05" }),
      buy({ id: "s2", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-10" }),
      buy({ id: "s3", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-28" }),
    ]);
    expect(claims).toHaveLength(1);
  });
});

describe("evidenceCoverage.isDateAlreadyCovered / hasOrdersHistoryFor", () => {
  it("a date inside an existing Statement's range is already covered; one outside it is not", () => {
    const claims = buildCoverageClaims([
      buy({ id: "s1", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-05" }),
      buy({ id: "s2", source: "statement", sourceUploadId: "u1", executionDate: "2026-01-28" }),
    ]);
    expect(isDateAlreadyCovered("2026-01-14", claims)).toBe(true);
    expect(isDateAlreadyCovered("2026-02-14", claims)).toBe(false);
  });

  it("hasOrdersHistoryFor is true only for the exact ticker an Orders upload named", () => {
    const claims = buildCoverageClaims([buy({ id: "o1", source: "orders-screen", sourceUploadId: "u2", ticker: "SKPC" })]);
    expect(hasOrdersHistoryFor("SKPC", claims)).toBe(true);
    expect(hasOrdersHistoryFor("CSAG", claims)).toBe(false);
  });
});

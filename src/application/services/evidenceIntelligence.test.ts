import { describe, expect, it } from "vitest";
import { getEvidenceIntelligence } from "./evidenceIntelligence";
import { createRawTransaction, type RawTransaction, type BuyExecutionPayload, type SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { VerifyAllParams } from "./verificationEngine";
import type { PositionAggregate } from "./TradeService";

function buy(overrides: Partial<BuyExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: BuyExecutionPayload = { ticker: "SKPC", shares: 20, price: 14.51, executionDate: "2026-01-20", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "BuyExecution", source: source ?? "orders-screen", ticker: payload.ticker, payload }), seq: 1 };
}

function sell(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "SKPC", shares: 82, price: 15.55, executionDate: "2026-01-27", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "orders-screen", ticker: payload.ticker, payload }), seq: 2 };
}

function emptyPosition(ticker = "SKPC"): PositionAggregate {
  return { ticker, totalShares: 0, costBasis: 0, avgCost: 0, openTrades: [] };
}

describe("evidenceIntelligence.getEvidenceIntelligence", () => {
  it("returns undefined for a ticker with no Buy/Sell evidence at all", () => {
    expect(getEvidenceIntelligence("GHOST", { transactions: [], positions: [] })).toBeUndefined();
  });

  it("the SKPC shape: uncorroborated closed position lands in needsReview, with a recommended next document naming an EXECUTION-detail source (never My Position, since the ticker is closed)", () => {
    const b1 = buy({ id: "b1", shares: 30, executionDate: "2026-01-13" });
    const b2 = buy({ id: "b2", shares: 20, executionDate: "2026-01-14" });
    const b3 = buy({ id: "b3", shares: 12, executionDate: "2026-01-15" });
    const b4 = buy({ id: "b4", shares: 20, executionDate: "2026-01-20" });
    const s1 = sell({ id: "s1", shares: 82, executionDate: "2026-01-27" });
    const params: VerifyAllParams = { transactions: [b1, b2, b3, b4, s1], positions: [emptyPosition()] };

    const report = getEvidenceIntelligence("SKPC", params)!;

    expect(report.confirmed).toEqual([]);
    expect(report.needsReview).toHaveLength(5);
    expect(report.completeness.status).toBe("Incomplete");
    expect(report.recommendedDocument).toBeDefined();
    expect(report.recommendedDocument?.bestEvidence).not.toBe("My Position");
    expect(report.strongestEvidenceSource).toBe("orders-screen");
  });

  it("once independently corroborated (invoice-sourced), the same shape moves to confirmed with no recommended document", () => {
    const b1 = buy({ id: "b1", shares: 30, executionDate: "2026-01-13", source: "invoice" });
    const s1 = sell({ id: "s1", shares: 30, executionDate: "2026-01-27", source: "invoice" });
    const params: VerifyAllParams = { transactions: [b1, s1], positions: [emptyPosition()] };

    const report = getEvidenceIntelligence("SKPC", params)!;

    expect(report.confirmed).toHaveLength(2);
    expect(report.needsReview).toEqual([]);
    expect(report.completeness.status).toBe("Complete");
    expect(report.recommendedDocument).toBeUndefined();
    expect(report.strongestEvidenceSource).toBe("invoice");
  });
});

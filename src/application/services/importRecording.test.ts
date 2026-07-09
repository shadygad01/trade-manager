import { describe, expect, it } from "vitest";
import { recordImportedRawTransactions } from "./importRecording";
import { createFakeRawTransactionRepository } from "@application/testUtils/fakeRepositories";
import type { ParsedTradeCandidate, ParsedDividendCandidate, ParsedOrderEvidence } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { BuyExecutionPayload, SellExecutionPayload, PositionVerificationCapturePayload, DividendPaymentPayload, OrderEvidenceCapturePayload } from "@domain/entities/RawTransaction";

function buyCandidate(overrides: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return { ticker: "comi", side: "BUY", shares: 100, price: 45.5, date: "2026-02-01", ...overrides };
}

describe("recordImportedRawTransactions", () => {
  it("appends exactly one BuyExecution raw transaction per BUY candidate, with only the documented seven fields' worth of content plus envelope metadata", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    await recordImportedRawTransactions(
      { rawTransactions },
      { sourceUploadId: "upload-1", candidates: [buyCandidate({ confidence: "high", source: "invoice" })], verifications: [], dividends: [], orderEvidences: [] }
    );

    const all = await rawTransactions.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "BuyExecution",
      source: "invoice",
      sourceUploadId: "upload-1",
      ticker: "COMI", // normalized
      confidence: "high",
      status: "unverified",
      portfolioId: undefined, // Import never assigns a portfolio
    });
    const payload = all[0].payload as BuyExecutionPayload;
    expect(payload).toMatchObject({ ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01" });
  });

  it("SELL candidates become SellExecution — no allocation, lot, or ledger concept involved", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    await recordImportedRawTransactions(
      { rawTransactions },
      { sourceUploadId: "upload-1", candidates: [buyCandidate({ side: "SELL", price: 50 })], verifications: [], dividends: [], orderEvidences: [] }
    );

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("SellExecution");
    const payload = txn.payload as SellExecutionPayload;
    expect(payload.price).toBe(50);
  });

  it("a candidate with no recorded source defaults to statement, the same fallback duplicateDetection.ts already treats an untyped legacy read as", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    await recordImportedRawTransactions(
      { rawTransactions },
      { sourceUploadId: "upload-1", candidates: [buyCandidate({ source: undefined })], verifications: [], dividends: [], orderEvidences: [] }
    );
    expect((await rawTransactions.getAll())[0].source).toBe("statement");
  });

  it("appends a PositionVerificationCapture per verification, sourced as position-verification", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    const verification: Omit<PositionVerification, "id" | "portfolioId"> = { ticker: "HRHO", units: 200, avgCost: 18.2, capturedAt: "2026-02-10T00:00", source: "screenshot" };
    await recordImportedRawTransactions({ rawTransactions }, { sourceUploadId: "upload-1", candidates: [], verifications: [verification], dividends: [], orderEvidences: [] });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("PositionVerificationCapture");
    expect(txn.source).toBe("position-verification");
    expect((txn.payload as PositionVerificationCapturePayload).units).toBe(200);
  });

  it("appends a DividendPayment per dividend", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    const dividend: ParsedDividendCandidate = { ticker: "COMI", date: "2026-01-20", amount: 350 };
    await recordImportedRawTransactions({ rawTransactions }, { sourceUploadId: "upload-1", candidates: [], verifications: [], dividends: [dividend], orderEvidences: [] });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("DividendPayment");
    expect((txn.payload as DividendPaymentPayload).amount).toBe(350);
  });

  it("appends an OrderEvidenceCapture per order-history row, sourced as orders-timeline", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    const evidence: ParsedOrderEvidence = { ticker: "COMI", side: "BUY", totalValue: 4550, status: "fulfilled" };
    await recordImportedRawTransactions({ rawTransactions }, { sourceUploadId: "upload-1", candidates: [], verifications: [], dividends: [], orderEvidences: [evidence] });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("OrderEvidenceCapture");
    expect(txn.source).toBe("orders-timeline");
    expect((txn.payload as OrderEvidenceCapturePayload).totalValue).toBe(4550);
  });

  it("a batch of mixed candidate types appends exactly one raw transaction per item, nothing merged or dropped", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    await recordImportedRawTransactions(
      { rawTransactions },
      {
        sourceUploadId: "upload-1",
        candidates: [buyCandidate(), buyCandidate({ side: "SELL", price: 50 })],
        verifications: [{ ticker: "COMI", units: 100, capturedAt: "2026-02-10T00:00", source: "screenshot" }],
        dividends: [{ ticker: "COMI", date: "2026-01-20", amount: 100 }],
        orderEvidences: [{ ticker: "COMI", side: "BUY", totalValue: 4550, status: "fulfilled" }],
      }
    );
    expect(await rawTransactions.getAll()).toHaveLength(5);
  });

  it("an empty batch appends nothing", async () => {
    const rawTransactions = createFakeRawTransactionRepository();
    await recordImportedRawTransactions({ rawTransactions }, { sourceUploadId: "upload-1", candidates: [], verifications: [], dividends: [], orderEvidences: [] });
    expect(await rawTransactions.getAll()).toEqual([]);
  });
});

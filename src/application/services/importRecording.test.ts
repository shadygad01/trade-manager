import { beforeEach, describe, expect, it } from "vitest";
import { recordImportedRawTransactions } from "./importRecording";
import { createFakeRawTransactionRepository, createFakeCommittedLedgerRepository } from "@application/testUtils/fakeRepositories";
import type { ParsedTradeCandidate, ParsedDividendCandidate, ParsedOrderEvidence, ParsedCancelledOrder } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import type { BuyExecutionPayload, SellExecutionPayload, PositionVerificationCapturePayload, DividendPaymentPayload, OrderEvidenceCapturePayload, CancelledOrderPayload } from "@domain/entities/RawTransaction";
import type { RawTransactionRepository, CommittedLedgerRepository } from "@domain/repositories";

function buyCandidate(overrides: Partial<ParsedTradeCandidate> = {}): ParsedTradeCandidate {
  return { ticker: "comi", side: "BUY", shares: 100, price: 45.5, date: "2026-02-01", ...overrides };
}

describe("recordImportedRawTransactions", () => {
  let rawTransactions: RawTransactionRepository;
  let committedLedger: CommittedLedgerRepository;
  let repos: { rawTransactions: RawTransactionRepository; committedLedger: CommittedLedgerRepository };

  beforeEach(() => {
    rawTransactions = createFakeRawTransactionRepository();
    committedLedger = createFakeCommittedLedgerRepository();
    repos = { rawTransactions, committedLedger };
  });

  it("appends exactly one BuyExecution raw transaction per BUY candidate, with only the documented seven fields' worth of content plus envelope metadata", async () => {
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [{ key: "k1", candidate: buyCandidate({ confidence: "high", source: "invoice" }) }],
      verifications: [],
      dividends: [],
      cancelledOrders: [], orderEvidences: [],
    });

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
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [{ key: "k1", candidate: buyCandidate({ side: "SELL", price: 50 }) }],
      verifications: [],
      dividends: [],
      cancelledOrders: [], orderEvidences: [],
    });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("SellExecution");
    const payload = txn.payload as SellExecutionPayload;
    expect(payload.price).toBe(50);
  });

  it("a candidate with no recorded source defaults to statement, the same fallback duplicateDetection.ts already treats an untyped legacy read as", async () => {
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [{ key: "k1", candidate: buyCandidate({ source: undefined }) }],
      verifications: [],
      dividends: [],
      cancelledOrders: [], orderEvidences: [],
    });
    expect((await rawTransactions.getAll())[0].source).toBe("statement");
  });

  it("a candidate's session key becomes the written RawTransaction's own id, so a later Skip/Dismiss/Discard action can retract this exact row", async () => {
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [{ key: "session-key-42", candidate: buyCandidate() }],
      verifications: [],
      dividends: [],
      cancelledOrders: [], orderEvidences: [],
    });
    const [txn] = await rawTransactions.getAll();
    expect(txn.id).toBe("session-key-42");
  });

  it("an order-evidence row's session key likewise becomes its RawTransaction's own id", async () => {
    const evidence: ParsedOrderEvidence = { ticker: "COMI", side: "BUY", totalValue: 4550, status: "fulfilled" };
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [],
      verifications: [],
      dividends: [],
      cancelledOrders: [], orderEvidences: [{ key: "evidence-key-7", evidence }],
    });
    const [txn] = await rawTransactions.getAll();
    expect(txn.id).toBe("evidence-key-7");
  });

  it("appends a PositionVerificationCapture per verification, sourced as position-verification", async () => {
    const verification: Omit<PositionVerification, "id" | "portfolioId"> = { ticker: "HRHO", units: 200, avgCost: 18.2, capturedAt: "2026-02-10T00:00", source: "screenshot" };
    await recordImportedRawTransactions(repos, { sourceUploadId: "upload-1", candidates: [], verifications: [verification], dividends: [], cancelledOrders: [], orderEvidences: [] });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("PositionVerificationCapture");
    expect(txn.source).toBe("position-verification");
    expect((txn.payload as PositionVerificationCapturePayload).units).toBe(200);
  });

  it("appends a DividendPayment per dividend", async () => {
    const dividend: ParsedDividendCandidate = { ticker: "COMI", date: "2026-01-20", amount: 350 };
    await recordImportedRawTransactions(repos, { sourceUploadId: "upload-1", candidates: [], verifications: [], dividends: [dividend], cancelledOrders: [], orderEvidences: [] });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("DividendPayment");
    expect((txn.payload as DividendPaymentPayload).amount).toBe(350);
  });

  it("appends an OrderEvidenceCapture per order-history row, sourced as orders-timeline", async () => {
    const evidence: ParsedOrderEvidence = { ticker: "COMI", side: "BUY", totalValue: 4550, status: "fulfilled" };
    await recordImportedRawTransactions(repos, { sourceUploadId: "upload-1", candidates: [], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [{ key: "k1", evidence }] });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("OrderEvidenceCapture");
    expect(txn.source).toBe("orders-timeline");
    expect((txn.payload as OrderEvidenceCapturePayload).totalValue).toBe(4550);
  });

  it("a batch of mixed candidate types appends exactly one raw transaction per item, nothing merged or dropped", async () => {
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [
        { key: "k1", candidate: buyCandidate() },
        { key: "k2", candidate: buyCandidate({ side: "SELL", price: 50 }) },
      ],
      verifications: [{ ticker: "COMI", units: 100, capturedAt: "2026-02-10T00:00", source: "screenshot" }],
      dividends: [{ ticker: "COMI", date: "2026-01-20", amount: 100 }],
      cancelledOrders: [], orderEvidences: [{ key: "k3", evidence: { ticker: "COMI", side: "BUY", totalValue: 4550, status: "fulfilled" } }],
    });
    expect(await rawTransactions.getAll()).toHaveLength(5);
  });

  it("an empty batch appends nothing", async () => {
    await recordImportedRawTransactions(repos, { sourceUploadId: "upload-1", candidates: [], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });
    expect(await rawTransactions.getAll()).toEqual([]);
  });

  it("appends a CancelledOrder per fully-cancelled order, preserving the broker's own status text — never a BuyExecution/SellExecution", async () => {
    const cancelledOrder: ParsedCancelledOrder = {
      ticker: "abuk",
      side: "SELL",
      originalShares: 190,
      originalPrice: 41.17,
      date: "2026-02-26",
      brokerStatus: "Cancelled",
      source: "orders-screen",
    };
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [],
      verifications: [],
      dividends: [],
      orderEvidences: [],
      cancelledOrders: [cancelledOrder],
    });

    const [txn] = await rawTransactions.getAll();
    expect(txn.kind).toBe("CancelledOrder");
    expect(txn.source).toBe("orders-screen");
    expect(txn.ticker).toBe("ABUK");
    const payload = txn.payload as CancelledOrderPayload;
    expect(payload).toMatchObject({ ticker: "ABUK", side: "SELL", originalShares: 190, originalPrice: 41.17, date: "2026-02-26", brokerStatus: "Cancelled" });
  });

  it("never triggers a commit — every row Import writes is unassigned to a portfolio, so the reactive trigger stays correctly inert", async () => {
    // A buy+sell pair that would close a position and verify cleanly IF it
    // had a portfolio — but Import never assigns one, so nothing commits.
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [
        { key: "k1", candidate: buyCandidate({ shares: 100 }) },
        { key: "k2", candidate: buyCandidate({ side: "SELL", shares: 100, price: 50 }) },
      ],
      verifications: [],
      dividends: [],
      cancelledOrders: [], orderEvidences: [],
    });
    expect(await committedLedger.getLedgerEvents("any-portfolio", "COMI")).toEqual([]);
  });
});

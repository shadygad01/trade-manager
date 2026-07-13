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

/**
 * Regression coverage for the invariant: "exactly one live canonical
 * execution fact per business execution identity." A real, reported defect
 * (re-importing the SAME Official Broker Excel file): this writer had no
 * existence check at all, so a genuine re-import created a SECOND live
 * "official-broker-excel" fact for the identical execution, only ever
 * cleaned up afterward, non-atomically, by ImportPage.tsx's own presentation-
 * layer duplicate-skip effect — a real, structural gap any OTHER caller
 * (a future importer, a notification-based recorder) would not get for free.
 */
describe("recordImportedRawTransactions — one-canonical-fact-per-execution invariant", () => {
  let rawTransactions: RawTransactionRepository;
  let committedLedger: CommittedLedgerRepository;
  let repos: { rawTransactions: RawTransactionRepository; committedLedger: CommittedLedgerRepository };

  beforeEach(() => {
    rawTransactions = createFakeRawTransactionRepository();
    committedLedger = createFakeCommittedLedgerRepository();
    repos = { rawTransactions, committedLedger };
  });

  it("re-import: the SAME Official Broker Excel candidate imported twice (two separate uploads/session keys) leaves exactly one live fact", async () => {
    const candidate = buyCandidate({ ticker: "ARCC", shares: 42, price: 10, source: "official-broker-excel" });
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [{ key: "key-1", candidate }],
      verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [],
    });
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-2", // a genuine second, independent import call — same value.
      candidates: [{ key: "key-2", candidate }],
      verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [],
    });

    const all = await rawTransactions.getAll();
    expect(all).toHaveLength(1); // no duplicate — fixed at the writer itself, no downstream cleanup needed.
    expect(all[0].id).toBe("key-1"); // the first write survives; the second is never created.
  });

  it("re-import within the SAME batch (two candidates, identical value, in one call) also leaves exactly one live fact", async () => {
    const candidate = buyCandidate({ ticker: "ARCC", shares: 42, price: 10, source: "official-broker-excel" });
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "upload-1",
      candidates: [
        { key: "key-1", candidate },
        { key: "key-2", candidate },
      ],
      verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [],
    });
    expect(await rawTransactions.getAll()).toHaveLength(1);
  });

  it("manual-shaped source (e.g. a CSV row with no document type) re-imported twice: still only one live fact — the check is not authority-specific", async () => {
    const candidate = buyCandidate({ ticker: "HRHO", shares: 10, price: 5, source: "csv" });
    await recordImportedRawTransactions(repos, { sourceUploadId: "u1", candidates: [{ key: "k1", candidate }], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });
    await recordImportedRawTransactions(repos, { sourceUploadId: "u2", candidates: [{ key: "k2", candidate }], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });
    expect(await rawTransactions.getAll()).toHaveLength(1);
  });

  it("notification source re-imported twice: still only one live fact", async () => {
    const candidate = buyCandidate({ ticker: "ORWE", shares: 5, price: 8, source: "notification" });
    await recordImportedRawTransactions(repos, { sourceUploadId: "u1", candidates: [{ key: "k1", candidate }], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });
    await recordImportedRawTransactions(repos, { sourceUploadId: "u2", candidates: [{ key: "k2", candidate }], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });
    expect(await rawTransactions.getAll()).toHaveLength(1);
  });

  it("future-adoption / upgrade case unchanged: a genuinely HIGHER-authority re-read of an already-live LOWER-authority execution still gets its own new fact (unlike the tie/downgrade case)", async () => {
    const lowAuthority = buyCandidate({ ticker: "PHAR", shares: 15, price: 20, source: "screenshot" });
    await recordImportedRawTransactions(repos, { sourceUploadId: "u1", candidates: [{ key: "screenshot-key", candidate: lowAuthority }], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });

    const highAuthority = buyCandidate({ ticker: "PHAR", shares: 15, price: 20, source: "official-broker-excel" });
    await recordImportedRawTransactions(repos, { sourceUploadId: "u2", candidates: [{ key: "excel-key", candidate: highAuthority }], verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [] });

    const all = await rawTransactions.getAll();
    // Both facts exist momentarily — retracting the superseded "screenshot"
    // one remains ImportPage's own provenance-upgrade job (unchanged,
    // already tested there), same as before this fix. This writer's own
    // responsibility is narrower and unchanged for this branch: never skip
    // writing a genuinely more authoritative read.
    expect(all).toHaveLength(2);
    expect(all.find((f) => f.id === "excel-key")?.source).toBe("official-broker-excel");
    expect(all.find((f) => f.id === "screenshot-key")?.source).toBe("screenshot");
  });

  it("two DIFFERENT executions of the same ticker (different share counts) both get their own facts — the check is identity-scoped, not ticker-scoped", async () => {
    await recordImportedRawTransactions(repos, {
      sourceUploadId: "u1",
      candidates: [
        { key: "k1", candidate: buyCandidate({ ticker: "COMI", shares: 100, price: 45.5, date: "2026-02-01" }) },
        { key: "k2", candidate: buyCandidate({ ticker: "COMI", shares: 200, price: 46, date: "2026-02-02" }) },
      ],
      verifications: [], dividends: [], cancelledOrders: [], orderEvidences: [],
    });
    expect(await rawTransactions.getAll()).toHaveLength(2);
  });
});

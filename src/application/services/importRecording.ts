import type { ParsedTradeCandidate, ParsedDividendCandidate, ParsedOrderEvidence } from "@domain/entities/Upload";
import type { PositionVerification } from "@domain/entities/PositionVerification";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload, type PositionVerificationCapturePayload, type OrderEvidenceCapturePayload, type DividendPaymentPayload, type RawTransactionSource } from "@domain/entities/RawTransaction";
import type { RawTransactionRepository } from "@domain/repositories";
import { normalizeTicker } from "@domain/value-objects/Ticker";

/**
 * Import Recording: Import's ONLY sanctioned write. Given the domain-typed
 * candidates a parsed document produced, appends one immutable RawTransaction
 * per candidate — nothing else. No ledger, no allocations, no holdings, no
 * verification/matching decision. Every row is written with status
 * "unverified"; deciding Verified/Rejected/Needs Review happens later, by
 * the Verification Engine, never here.
 *
 * Deliberately takes plain domain-typed arrays rather than
 * ImportOrchestrator's ImportResult — that type lives in the infrastructure
 * layer (src/infrastructure/ocr/ImportOrchestrator.ts), which the
 * application layer is not allowed to import from. ImportPage.tsx
 * (presentation) bridges the two, exactly the direction Clean Architecture
 * intends: presentation wires infrastructure output into an application
 * service, not the other way around.
 */

export interface ImportRecordingRepos {
  rawTransactions: RawTransactionRepository;
}

export interface ImportRecordingInput {
  sourceUploadId: string;
  candidates: ParsedTradeCandidate[];
  verifications: Omit<PositionVerification, "id" | "portfolioId">[];
  dividends: ParsedDividendCandidate[];
  orderEvidences: ParsedOrderEvidence[];
}

function candidateSource(candidate: ParsedTradeCandidate): RawTransactionSource {
  // A candidate without a recorded source predates ParsedTradeCandidate.source
  // existing — "statement" is the most common/generic document shape and the
  // same fallback duplicateDetection.ts's own cross-source logic already
  // treats an untyped legacy read as closest to.
  return candidate.source ?? "statement";
}

export async function recordImportedRawTransactions(repos: ImportRecordingRepos, input: ImportRecordingInput): Promise<void> {
  const { sourceUploadId, candidates, verifications, dividends, orderEvidences } = input;

  for (const candidate of candidates) {
    const ticker = normalizeTicker(candidate.ticker);
    if (candidate.side === "BUY") {
      const payload: BuyExecutionPayload = {
        ticker,
        shares: candidate.shares,
        price: candidate.price,
        fees: candidate.fees,
        taxes: candidate.taxes,
        executionDate: candidate.date,
        executionTime: candidate.time,
        companyName: candidate.companyName,
        transactionNumber: candidate.transactionNumber,
      };
      await repos.rawTransactions.append(
        createRawTransaction({ kind: "BuyExecution", source: candidateSource(candidate), sourceUploadId, ticker, confidence: candidate.confidence, payload })
      );
    } else {
      const payload: SellExecutionPayload = {
        ticker,
        shares: candidate.shares,
        price: candidate.price,
        fees: candidate.fees,
        taxes: candidate.taxes,
        executionDate: candidate.date,
        executionTime: candidate.time,
        transactionNumber: candidate.transactionNumber,
      };
      await repos.rawTransactions.append(
        createRawTransaction({ kind: "SellExecution", source: candidateSource(candidate), sourceUploadId, ticker, confidence: candidate.confidence, payload })
      );
    }
  }

  for (const verification of verifications) {
    const ticker = normalizeTicker(verification.ticker);
    const payload: PositionVerificationCapturePayload = {
      ticker,
      units: verification.units,
      avgCost: verification.avgCost,
      capturedAt: verification.capturedAt,
      companyName: verification.companyName,
    };
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "PositionVerificationCapture", source: "position-verification", sourceUploadId, ticker, payload })
    );
  }

  // Dividends are only ever read alongside a "My Position" screen — see
  // ImportOrchestrator's own routing (parseDividends is called exclusively
  // in the position-verification branch).
  for (const dividend of dividends) {
    const ticker = dividend.ticker ? normalizeTicker(dividend.ticker) : undefined;
    const payload: DividendPaymentPayload = { ticker, amount: dividend.amount, date: dividend.date };
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "DividendPayment", source: "position-verification", sourceUploadId, ticker, payload })
    );
  }

  // Order evidence is only ever read from the account-wide Orders-timeline
  // screen — see ImportOrchestrator's own routing.
  for (const evidence of orderEvidences) {
    const ticker = normalizeTicker(evidence.ticker);
    const payload: OrderEvidenceCapturePayload = {
      ticker,
      side: evidence.side,
      orderType: evidence.orderType,
      shares: evidence.shares,
      price: evidence.price,
      totalValue: evidence.totalValue,
      status: evidence.status,
      date: evidence.date,
      time: evidence.time,
      companyName: evidence.companyName,
    };
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "OrderEvidenceCapture", source: "orders-timeline", sourceUploadId, ticker, confidence: evidence.confidence, payload })
    );
  }
}

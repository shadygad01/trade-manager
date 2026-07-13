import { describe, it, expect } from "vitest";
import { createPortfolio } from "@domain/entities/Portfolio";
import { generateId } from "@domain/value-objects/id";
import {
  createFakeRepositories,
  createFakeRawTransactionRepository,
  createFakeCommittedLedgerRepository,
} from "@application/testUtils/fakeRepositories";
import { recordBuy, recordSell, type RecordSellInput } from "./TradeService";
import { recordImportedRawTransactions } from "./importRecording";
import { checkTickerMatch } from "./importVerification";
import { isTickerFullyOfficialBrokerExcelSourced } from "./reconciliation";
import {
  fingerprintEconomicFacts,
  fingerprintEvidence,
  checkVerificationInvariant,
  formatVerificationInvariantViolation,
  checkShareArithmeticInvariant,
  formatShareArithmeticViolation,
  type VerificationSnapshot,
} from "./verificationInvariant";
import { createRawTransaction, type BuyExecutionPayload, type SellExecutionPayload } from "@domain/entities/RawTransaction";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";

/**
 * Permanent architectural guard for the "ABUK class of bug" (see
 * docs/ROADMAP.md): Verification may change ONLY when economic facts,
 * evidence, or source change — never as a side effect of an allocation-only
 * operation like Smart Allocate. `checkVerificationInvariant` is the
 * detector; these tests prove (a) it correctly stays silent across the real,
 * currently-shipping Smart Allocate flow, and (b) it correctly fires when
 * fed the exact "facts/evidence unchanged, verdict flipped anyway" shape the
 * historical bug produced — so a detector that always happens to pass isn't
 * mistaken for one that actually checks anything.
 */

function fullRepos(cash = 10_000_000) {
  const base = createFakeRepositories({ portfolios: [createPortfolio({ id: "p1", name: "Main", kind: "Trading", initialCash: cash })] });
  return { ...base, rawTransactions: createFakeRawTransactionRepository(), committedLedger: createFakeCommittedLedgerRepository() };
}
type FullRepos = ReturnType<typeof fullRepos>;

async function snapshotTicker(repos: FullRepos, operation: string, ticker: string, responsibleFunction: string, file: string): Promise<VerificationSnapshot> {
  const [facts, verifications, trades] = await Promise.all([
    repos.rawTransactions.getAll(),
    repos.verifications.getByPortfolio("p1"),
    repos.trades.getByPortfolio("p1"),
  ]);
  const existingRemainingShares = trades.filter((t) => t.ticker === ticker).reduce((sum, t) => sum + t.remainingShares, 0);
  const status = checkTickerMatch({
    hasShares: true,
    pendingBuyShares: 0,
    pendingSellShares: 0,
    existingRemainingShares,
    allPendingFromOfficialBrokerExcel: isTickerFullyOfficialBrokerExcelSourced(facts, ticker),
  });
  return {
    operation,
    ticker,
    economicFacts: fingerprintEconomicFacts(facts, ticker),
    evidence: fingerprintEvidence(verifications, ticker),
    status,
    responsibleFunction,
    file,
  };
}

describe("verificationInvariant — pure fingerprint/detector behavior", () => {
  it("fingerprintEconomicFacts is order-independent and excludes retracted facts and other tickers", () => {
    const buyA: BuyExecutionPayload = { ticker: "ABUK", shares: 40, price: 40, executionDate: "2026-01-01" };
    const buyB: BuyExecutionPayload = { ticker: "ABUK", shares: 30, price: 40.5, executionDate: "2026-01-05" };
    const other: BuyExecutionPayload = { ticker: "COMI", shares: 10, price: 1, executionDate: "2026-01-01" };
    const factA = { ...createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "ABUK", payload: buyA }), seq: 1 };
    const factB = { ...createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "ABUK", payload: buyB }), seq: 2 };
    const factOther = { ...createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker: "COMI", payload: other }), seq: 3 };

    const fpForward = fingerprintEconomicFacts([factA, factB, factOther], "ABUK");
    const fpReversed = fingerprintEconomicFacts([factB, factA, factOther], "ABUK");
    expect(fpForward).toBe(fpReversed);
    expect(fpForward).not.toBe(fingerprintEconomicFacts([factOther], "COMI"));

    const retraction = { ...createRawTransaction({ kind: "Retraction", source: "manual", ticker: "ABUK", payload: { targetId: factB.id, reason: "test" } }), seq: 4 };
    const fpAfterRetraction = fingerprintEconomicFacts([factA, factB, factOther, retraction], "ABUK");
    expect(fpAfterRetraction).toBe(fingerprintEconomicFacts([factA, factOther], "ABUK"));
  });

  it("reports no violation when facts/evidence are unchanged and the verdict is unchanged", () => {
    const snap: VerificationSnapshot = {
      operation: "op",
      ticker: "ABUK",
      economicFacts: "same",
      evidence: undefined,
      status: { matched: true, reason: "broker-excel-verified" },
      responsibleFunction: "fn",
      file: "file.ts",
    };
    expect(checkVerificationInvariant(snap, { ...snap })).toBeUndefined();
  });

  it("reports no violation when the verdict changes ALONGSIDE a facts change — that's legitimate, new information arriving", () => {
    const before: VerificationSnapshot = {
      operation: "op", ticker: "ABUK", economicFacts: "fact-set-1", evidence: undefined,
      status: { matched: false, reason: "no-verification" }, responsibleFunction: "fn", file: "file.ts",
    };
    const after: VerificationSnapshot = { ...before, economicFacts: "fact-set-2", status: { matched: true, reason: "matched" } };
    expect(checkVerificationInvariant(before, after)).toBeUndefined();
  });

  it("fires when facts AND evidence are byte-identical but the verdict flips anyway — the exact historical bug shape", () => {
    const before: VerificationSnapshot = {
      operation: "Smart Allocate", ticker: "ABUK", economicFacts: "fact-set-1", evidence: undefined,
      status: { matched: true, reason: "broker-excel-verified" },
      responsibleFunction: "smartAllocateSell", file: "src/presentation/pages/ImportPage.tsx",
    };
    const after: VerificationSnapshot = { ...before, status: { matched: false, reason: "no-verification" } };

    const violation = checkVerificationInvariant(before, after);
    expect(violation).toBeDefined();
    expect(violation).toMatchObject({
      operation: "Smart Allocate",
      ticker: "ABUK",
      previousVerification: { matched: true, reason: "broker-excel-verified" },
      currentVerification: { matched: false, reason: "no-verification" },
      changedField: "matched",
      responsibleFunction: "smartAllocateSell",
      file: "src/presentation/pages/ImportPage.tsx",
    });
    expect(formatVerificationInvariantViolation(violation!)).toContain("Verification invariant violated");
  });
});

describe("verificationInvariant — real Smart Allocate flow (the ABUK reproduction)", () => {
  it("holds across Import -> Confirm -> Smart Allocate for the real ABUK shape: 3 Buys (100) + 1 Sell (73), net 27", async () => {
    const repos = fullRepos();
    const ticker = "ABUK";

    const buys = [
      { shares: 40, price: 40, date: "2026-01-01", time: "09:00" },
      { shares: 30, price: 40.5, date: "2026-01-05", time: "09:10" },
      { shares: 30, price: 41, date: "2026-01-10", time: "09:20" },
    ];
    const sell = { shares: 73, price: 42, date: "2026-02-01", time: "10:30" };

    const uploadId = generateId();
    const candidates: ParsedTradeCandidate[] = [
      ...buys.map((b) => ({ ticker, side: "BUY" as const, shares: b.shares, price: b.price, date: b.date, time: b.time, confidence: "high" as const, source: "official-broker-excel" as const })),
      { ticker, side: "SELL" as const, shares: sell.shares, price: sell.price, date: sell.date, time: sell.time, confidence: "high" as const, source: "official-broker-excel" as const },
    ];
    await repos.uploads.save({
      id: uploadId, fileName: "abuk.xlsx", fileHash: `hash-${uploadId}`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      status: "parsed", candidates, createdAt: new Date().toISOString(), parsedAt: new Date().toISOString(),
    });
    await recordImportedRawTransactions(repos, {
      sourceUploadId: uploadId,
      candidates: candidates.map((c) => ({ key: generateId(), candidate: c })),
      verifications: [], dividends: [], orderEvidences: [], cancelledOrders: [],
    });

    for (const b of buys) {
      await recordBuy(repos, { portfolioId: "p1", ticker, shares: b.shares, entryPrice: b.price, executionDate: b.date, executionTime: b.time });
    }

    // Snapshot taken immediately BEFORE Smart Allocate — exactly the state
    // tickerMatchStatuses reports right before the user clicks the button.
    const before = await snapshotTicker(repos, "Smart Allocate", ticker, "smartAllocateSell", "src/presentation/pages/ImportPage.tsx");
    expect(before.status.matched).toBe(true);

    // Smart Allocate itself: FIFO against open lots, recordSell with the
    // candidate's own source — mirrors ImportPage.smartAllocateSell exactly.
    const allTrades = await repos.trades.getByPortfolio("p1");
    const openLots = allTrades.filter((t) => t.ticker === ticker && t.remainingShares > 0).sort((a, b) => a.executionDate.localeCompare(b.executionDate));
    let remaining = sell.shares;
    const lines: { tradeId: string; shares: number }[] = [];
    for (const lot of openLots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.remainingShares, remaining);
      lines.push({ tradeId: lot.id, shares: take });
      remaining -= take;
    }
    expect(remaining).toBe(0);
    const input: RecordSellInput = {
      portfolioId: "p1", ticker,
      allocations: lines.map((l) => ({ tradeId: l.tradeId, shares: l.shares, exitPrice: sell.price })),
      executionDate: sell.date, executionTime: sell.time, source: "official-broker-excel",
    };
    await recordSell(repos, input);

    const after = await snapshotTicker(repos, "Smart Allocate", ticker, "smartAllocateSell", "src/presentation/pages/ImportPage.tsx");

    const violation = checkVerificationInvariant(before, after);
    expect(violation, violation ? formatVerificationInvariantViolation(violation) : undefined).toBeUndefined();
    expect(after.status.matched).toBe(true);
    expect(after.status.reason).toBe("broker-excel-verified");

    const remainingShares = (await repos.trades.getByPortfolio("p1")).filter((t) => t.ticker === ticker).reduce((sum, t) => sum + t.remainingShares, 0);
    expect(remainingShares).toBe(27);
  });

  it("share-arithmetic guard fires on the exact historical corruption shape: allocation misattribution leaves the ledger's remaining-shares total disagreeing with the facts, even though Verification's matched/reason never flips", async () => {
    // Reproduces the deeper, second-order shape docs/ROADMAP.md's
    // "pendingCandidateSignature"/"sourceUploadIds" entries root-caused: an
    // allocation-identity bug can misattribute which lot a sell closes while
    // every RawTransaction's own value stays untouched — so
    // checkVerificationInvariant (matched/reason only) stays silent (the
    // ticker is still fully official-broker-excel-sourced, so `matched`
    // stays true throughout), yet the ledger's derived remaining-shares
    // total silently disagrees with what the facts themselves imply. This is
    // exactly why the share-arithmetic guard is a SECOND, independent check,
    // not a duplicate of the verdict check above.
    const repos = fullRepos();
    const ticker = "ABUK";
    const buyPayload: BuyExecutionPayload = { ticker, shares: 100, price: 40, executionDate: "2026-01-01" };
    const sellPayload: SellExecutionPayload = { ticker, shares: 73, price: 42, executionDate: "2026-02-01" };
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "BuyExecution", source: "official-broker-excel", ticker, payload: buyPayload })
    );
    await repos.rawTransactions.append(
      createRawTransaction({ kind: "SellExecution", source: "official-broker-excel", ticker, payload: sellPayload })
    );

    const facts = await repos.rawTransactions.getAll();
    expect(fingerprintEconomicFacts(facts, ticker)).toBeTruthy();

    // Ground truth, from the facts alone: 100 bought - 73 sold = 27 left.
    const goodCheck = checkShareArithmeticInvariant({
      rawTransactions: facts, ticker, actualRemainingShares: 27,
      responsibleFunction: "getLotManagerSnapshot", file: "src/application/services/lotManager.ts",
    });
    expect(goodCheck).toBeUndefined();

    // Simulates the misattribution corruption directly: the Allocation
    // Engine attributed the sell's shares against the wrong reference and
    // left the ledger's own remaining-shares total at 68 (the exact
    // corrupted figure the real ABUK reproduction landed on before Root
    // Cause B was fixed — see docs/ROADMAP.md) instead of 27.
    const corruptedCheck = checkShareArithmeticInvariant({
      rawTransactions: facts, ticker, actualRemainingShares: 68,
      responsibleFunction: "getLotManagerSnapshot", file: "src/application/services/lotManager.ts",
    });
    expect(corruptedCheck).toEqual({
      ticker, expectedNetShares: 27, actualRemainingShares: 68,
      responsibleFunction: "getLotManagerSnapshot", file: "src/application/services/lotManager.ts",
    });
    expect(formatShareArithmeticViolation(corruptedCheck!)).toContain("Share arithmetic invariant violated");

    // And, confirming the claim above directly: Verification's own
    // matched/reason stays "broker-excel-verified" regardless of which
    // remaining-shares figure is fed in — checkTickerMatch's
    // allPendingFromOfficialBrokerExcel branch never even looks at it.
    const statusWithGoodShares = checkTickerMatch({ hasShares: true, pendingBuyShares: 0, pendingSellShares: 0, existingRemainingShares: 27, allPendingFromOfficialBrokerExcel: true });
    const statusWithCorruptedShares = checkTickerMatch({ hasShares: true, pendingBuyShares: 0, pendingSellShares: 0, existingRemainingShares: 68, allPendingFromOfficialBrokerExcel: true });
    expect(statusWithGoodShares.matched).toBe(true);
    expect(statusWithCorruptedShares.matched).toBe(true);
    expect(statusWithGoodShares.reason).toBe(statusWithCorruptedShares.reason);
  });
});

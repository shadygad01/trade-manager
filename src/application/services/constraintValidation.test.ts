import { describe, it, expect } from "vitest";
import { checkTickerMatch } from "./importVerification";
import {
  buildInventoryFacts,
  evaluateInventoryConstraint,
  diagnoseInventoryContradiction,
  buildTickerConstraintReport,
} from "./constraintValidation";

describe("buildInventoryFacts + evaluateInventoryConstraint", () => {
  it("is satisfied and requires no Holdings for a fully closed position", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 100,
      pendingSellShares: 100,
      existingRemainingShares: 0,
    });
    const facts = buildInventoryFacts("COMI", status);
    expect(facts.closed).toBe(true);
    expect(facts.calculatedRemaining).toBe(0);
    expect(evaluateInventoryConstraint(facts)).toEqual([]);
  });

  it("is satisfied when an open position's calculated remaining matches Holdings exactly", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 20,
      pendingSellShares: 30,
      existingRemainingShares: 100,
      verifiedUnits: 90,
    });
    const facts = buildInventoryFacts("COMI", status);
    expect(facts.closed).toBe(false);
    expect(facts.calculatedRemaining).toBe(90);
    expect(facts.holdingsRemaining).toBe(90);
    expect(evaluateInventoryConstraint(facts)).toEqual([]);
  });

  it("reports an objective inventory contradiction, never a guess, when open-position shares disagree with Holdings", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 120,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    const facts = buildInventoryFacts("COMI", status);
    const contradictions = evaluateInventoryConstraint(facts);
    expect(contradictions).toEqual([
      { kind: "inventory", ticker: "COMI", expected: 100, calculated: 120, difference: 20 },
    ]);
  });

  it("requires no Holdings for an open position when none has been uploaded (no-verification is not itself a contradiction)", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 50,
      pendingSellShares: 0,
      existingRemainingShares: 0,
    });
    const facts = buildInventoryFacts("COMI", status);
    expect(facts.holdingsRemaining).toBeUndefined();
    expect(evaluateInventoryConstraint(facts)).toEqual([]);
  });

  // The broker-record trust policy: an official-broker-excel-sourced open
  // position is never required to reconcile against a "My Position"
  // screenshot, even a disagreeing one — checkTickerMatch already surfaces
  // that disagreement as a non-blocking secondaryMismatch, never a
  // contradiction. Before this fix, evaluateInventoryConstraint recomputed
  // the same calculated-vs-Holdings comparison with no knowledge of the
  // ticker's trust tier, silently reintroducing the "needs corroboration"
  // verdict checkTickerMatch had already ruled out.
  it("is satisfied for a broker-excel-verified open position even when a disagreeing 'My Position' screenshot exists", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 100,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 70, // disagrees with the calculated 100 — never a contradiction here
      allPendingFromOfficialBrokerExcel: true,
    });
    expect(status.reason).toBe("broker-excel-verified");
    expect(status.secondaryMismatch).toBe(true);
    const facts = buildInventoryFacts("PHAR", status);
    expect(facts.brokerExcelVerified).toBe(true);
    expect(evaluateInventoryConstraint(facts)).toEqual([]);
  });
});

describe("diagnoseInventoryContradiction", () => {
  const contradiction = evaluateInventoryConstraint(
    buildInventoryFacts(
      "COMI",
      checkTickerMatch({
        hasShares: true,
        pendingBuyShares: 120,
        pendingSellShares: 0,
        existingRemainingShares: 0,
        verifiedUnits: 100,
      }),
    ),
  );

  it("never diagnoses when there is no contradiction", () => {
    expect(diagnoseInventoryContradiction([], { reconcileSuggestion: { keysToRemove: ["a"], alternatives: 0 } })).toEqual([]);
  });

  it("ranks a reconcile-solver match as high confidence when it's the only solution", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, {
      reconcileSuggestion: { keysToRemove: ["k1"], alternatives: 0 },
    });
    expect(diagnosis[0]).toEqual({
      explanation: "A duplicate or misread transaction among the still-pending rows accounts for the exact difference",
      confidence: "high",
    });
  });

  it("downgrades the reconcile-solver hypothesis to medium when alternatives exist", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, {
      reconcileSuggestion: { keysToRemove: ["k1"], alternatives: 2 },
    });
    expect(diagnosis[0].confidence).toBe("medium");
  });

  it("surfaces orphaned Orders-history evidence as a missing-import hypothesis", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, { orphanedOrderEvidenceCount: 1 });
    expect(diagnosis).toContainEqual({
      explanation:
        "The broker's Orders history records a fulfilled transaction for this ticker not represented by any row here — likely a missing historical import",
      confidence: "medium",
    });
  });

  it("surfaces wrong-ticker and date-misread hint counts as their own hypotheses", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, {
      wrongTickerHintCount: 1,
      dateMisreadHintCount: 1,
    });
    expect(diagnosis.map((d) => d.explanation)).toEqual([
      "One or more rows may be the same execution misfiled under the wrong ticker",
      "A row's date may have been misread by OCR, duplicating a trade already on the ledger",
    ]);
  });

  it("surfaces a last-balanced-date narrowing as a high-confidence hypothesis", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, { lastBalancedDate: { date: "2024-03-01" } });
    expect(diagnosis).toContainEqual({
      explanation: "Every row through 2024-03-01 reconciles exactly — the discrepancy originates after that date",
      confidence: "high",
    });
  });

  it("falls back to the generic discrepancy-side hypothesis only when nothing more specific fired", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, { discrepancySide: "buy" });
    expect(diagnosis).toEqual([
      { explanation: "An extra or duplicate Buy transaction is likely already on the ledger", confidence: "low" },
    ]);
  });

  it("never falls back to a generic guess when a more specific hypothesis already fired", () => {
    const diagnosis = diagnoseInventoryContradiction(contradiction, {
      lastBalancedDate: { date: "2024-03-01" },
      discrepancySide: "buy",
    });
    expect(diagnosis.some((d) => d.explanation.includes("extra or duplicate Buy"))).toBe(false);
  });
});

describe("buildTickerConstraintReport", () => {
  it("composes facts, contradiction and diagnosis end-to-end for a genuine mismatch", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 120,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    const report = buildTickerConstraintReport("COMI", status, { discrepancySide: status.discrepancySide });
    expect(report.satisfied).toBe(false);
    expect(report.contradictions).toHaveLength(1);
    expect(report.diagnosis).toHaveLength(1);
  });

  it("composes a satisfied report with no diagnosis when facts already reconcile", () => {
    const status = checkTickerMatch({
      hasShares: true,
      pendingBuyShares: 100,
      pendingSellShares: 0,
      existingRemainingShares: 0,
      verifiedUnits: 100,
    });
    const report = buildTickerConstraintReport("COMI", status, {});
    expect(report.satisfied).toBe(true);
    expect(report.contradictions).toEqual([]);
    expect(report.diagnosis).toEqual([]);
  });
});

import type { TickerCompletenessReport } from "@application/services/completenessEngine";
import type { TickerConstraintReport } from "@application/services/constraintValidation";
import type { TFunction } from "@presentation/i18n/translations";
import { formatShares } from "@presentation/lib/format";

function confidenceText(t: TFunction, confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return t("importPage.constraintConfidenceHigh");
  if (confidence === "medium") return t("importPage.constraintConfidenceMedium");
  return t("importPage.constraintConfidenceLow");
}

/**
 * Facts first, contradiction second, diagnosis only ever after that — see
 * constraintValidation.ts. Purely additive/read-only: renders whatever
 * checkTickerMatch + the existing diagnosis signals already produced,
 * changes nothing about the banners/badges above and below it.
 */
export function ConstraintReportPanel({ report, t }: { report: TickerConstraintReport; t: TFunction }) {
  const { facts, contradictions, diagnosis } = report;
  return (
    <details className="border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
      <summary className="cursor-pointer select-none font-medium text-slate-300">
        {t("importPage.constraintReportTitle")}
        {report.satisfied ? (
          <span className="ms-2 text-emerald-400">{t("importPage.constraintSatisfied")}</span>
        ) : (
          <span className="ms-2 text-rose-400">{t("importPage.constraintContradictionTitle")}</span>
        )}
      </summary>
      <div className="mt-2 space-y-1.5">
        <p>
          {t("importPage.constraintFactsLine", {
            opening: formatShares(facts.openingShares),
            buy: formatShares(facts.buyShares),
            sell: formatShares(facts.sellShares),
            calculated: formatShares(facts.calculatedRemaining),
            holdingsSuffix:
              facts.holdingsRemaining !== undefined
                ? t("importPage.constraintFactsHoldingsSuffix", { holdings: formatShares(facts.holdingsRemaining) })
                : "",
          })}
        </p>
        {facts.closed ? <p className="text-slate-500">{t("importPage.constraintClosedPositionNote")}</p> : null}
        {contradictions.map((c, i) => (
          <p key={i} className="text-rose-300">
            {t("importPage.constraintContradictionLine", {
              expected: formatShares(c.expected),
              calculated: formatShares(c.calculated),
              difference: formatShares(c.difference),
            })}
          </p>
        ))}
        {diagnosis.length > 0 ? (
          <div className="mt-1.5 border-t border-slate-800 pt-1.5">
            <p className="font-medium text-slate-300">{t("importPage.constraintDiagnosisTitle")}</p>
            <ul className="mt-1 list-disc ps-4">
              {diagnosis.map((d, i) => (
                <li key={i}>
                  {d.explanation} — {t("importPage.constraintDiagnosisConfidence", { confidence: confidenceText(t, d.confidence) })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

const EVIDENCE_DOCUMENT_LABEL_KEY: Record<string, string> = {
  "Orders History": "importPage.evidenceOrdersHistory",
  "Broker Statement": "importPage.evidenceBrokerStatement",
  Invoice: "importPage.evidenceInvoice",
  Transactions: "importPage.evidenceTransactions",
  "My Position": "importPage.evidenceMyPosition",
};

/**
 * Surfaces completenessEngine's minimal-document recommendation instead of a
 * bare "needs a screenshot" block — names exactly which document closes the
 * gap and why, per the Evidence Resolution business rule "request only the
 * smallest missing document, never ask the user to re-upload everything."
 * Manual "I confirm this is complete" is deliberately NOT offered here as an
 * equal alternative — it's the last resort once no further evidence can
 * reasonably be requested, not a shortcut around requesting it.
 */
export function RecoveryPlanPanel({ report, t }: { report: TickerCompletenessReport; t: TFunction }) {
  const plan = report.recoveryPlan;
  if (!plan) return null;
  return (
    <div className="border-b border-slate-800 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
      <p className="font-medium">
        {t("importPage.recoveryPlanTitle", { document: t(EVIDENCE_DOCUMENT_LABEL_KEY[plan.bestEvidence] ?? plan.bestEvidence) })}
      </p>
      <p className="mt-1 text-amber-200/80">{plan.rationale}</p>
      {plan.alternativeEvidence ? (
        <p className="mt-1 text-amber-200/60">
          {t("importPage.recoveryPlanAlternative", { document: t(EVIDENCE_DOCUMENT_LABEL_KEY[plan.alternativeEvidence] ?? plan.alternativeEvidence) })}
        </p>
      ) : null}
    </div>
  );
}

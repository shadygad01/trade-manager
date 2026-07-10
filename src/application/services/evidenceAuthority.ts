import type { RawTransactionSource } from "@domain/entities/RawTransaction";

/**
 * Evidence Authority: which document type's own field values (price, fees,
 * shares, date) win when two sources disagree about the SAME execution.
 * Deliberately scoped to execution-detail fields only — this ranking never
 * decides whether an execution EXISTS or is trustworthy (that's
 * checkTickerMatch/completenessEngine's job), only whose numbers to prefer
 * once corroboration has already established both sides describe the same
 * transaction (see verificationEngine.corroboratingSource).
 *
 * My Position is deliberately NOT part of this ranking (see
 * MY_POSITION_EXCLUDED_REASON) — a documented, evidence-based deviation from
 * the originally-specified "Email Invoice > In-App Invoice > Statement >
 * Orders > Transactions > My Position > OCR-only" order, which put My
 * Position ahead only of an undifferentiated "OCR only" tier.
 *
 * Two more real, disclosed limitations, not fabricated distinctions: "Email
 * Invoice" vs. "In-App Invoice", and account-wide "Orders" timeline vs. the
 * dated "Transactions" list, are not separately distinguishable via
 * RawTransactionSource today — both pairs collapse to the same source value
 * (`"invoice"` covers only the Email Invoice PDF; the in-app order-detail
 * screen is parsed under `"orders-timeline"`, the same source as both the
 * account-wide Orders timeline and the dated Transactions list — see
 * ImportOrchestrator's own routing comments). Ranking them as if they were
 * five separately-identifiable tiers would mean fabricating a distinction
 * the data model can't actually make; this ranks what IS distinguishable.
 */
export const MY_POSITION_EXCLUDED_REASON =
  "My Position never describes an execution's price/fees/shares/date at all (see checkTickerMatch's own doc comment — a broker Holdings screen only ever shows the current unit count) — there is no execution-detail field it could ever outrank another source on. It remains authoritative for a different question entirely: the CURRENT holdings count, which this ranking does not answer.";

const AUTHORITY_RANK: Record<Exclude<RawTransactionSource, "position-verification">, number> = {
  /** The Email Invoice PDF — the only source with an itemized fee schedule (see docs/EVIDENCE_ARCHITECTURE.md and the first architecture review). */
  invoice: 5,
  /** Customer Account Statement — broker-authored, dated, but net-value-only per row (fees not itemized). */
  statement: 4,
  /** Per-ticker "Orders" screen — dated, priced, quantity-exact, no fees. */
  "orders-screen": 3,
  /**
   * Shared bucket for the account-wide undated Orders timeline, the dated
   * Transactions list, AND the in-app single Order Details screen ("In-App
   * Invoice") — see this module's own doc comment for why these can't be
   * split further with today's RawTransactionSource.
   */
  "orders-timeline": 2,
  /** Generic CSV export — broker-authored but not one of this app's named document types. */
  csv: 1,
  /** User-typed, no document behind it at all. */
  manual: 0,
  /** A one-time pre-migration conversion, already vetted under the rules that applied at the time — see RawTransactionSource's own doc comment. */
  backfill: 0,
};

/** Higher wins. `undefined` (a manual/backfill source, or the unranked position-verification) never outranks a real document. */
export function authorityRank(source: RawTransactionSource): number {
  if (source === "position-verification") return -1;
  return AUTHORITY_RANK[source];
}

/** The higher-authority of two sources describing the same execution's fields — ties (e.g. two statements) favor neither, since authority only distinguishes DIFFERENT document types, not two reads of the same type. */
export function higherAuthority(a: RawTransactionSource, b: RawTransactionSource): RawTransactionSource | undefined {
  const rankA = authorityRank(a);
  const rankB = authorityRank(b);
  if (rankA === rankB) return undefined;
  return rankA > rankB ? a : b;
}

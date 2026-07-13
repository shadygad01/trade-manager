/**
 * Closes the single most-repeated architectural bug class in this codebase's
 * history (see docs/ROADMAP.md's "Repo-wide architectural audit" and
 * docs/PORTFOLIO_OS_V2_SPEC.md Part 4.2/8.1): a deliberately coarse,
 * value-derived grouping/dedup signature — built for cross-document
 * corroboration matching, where two genuinely different real executions can
 * legitimately share one — gets reused somewhere else as a lookup key for
 * ONE specific Fact/Lot/Allocation. That exact shape of bug recurred five
 * times across four unrelated files (ledgerRebuild.ts, canonicalTransaction.ts,
 * verificationEngine.ts, TradeService.ts) before a manual, repo-wide audit
 * caught them all in one pass. This type makes the next instance a compile
 * error instead of something that needs another manual audit to find.
 *
 * `GroupingSignature` is a strict subtype of `string` (any function already
 * typed to accept `string` keeps compiling against it unchanged — this is
 * purely additive), but a plain `string` cannot be assigned where a
 * `GroupingSignature` is expected without going through `toGroupingSignature`
 * — the one, explicit, greppable place a signature is ever minted.
 *
 * Deliberately NOT paired with an `EntityId` brand in this pass: doing so
 * would mean rebranding `RawTransaction.id` and `LedgerEvent.eventId`
 * (the latter is legitimately sometimes value-derived — see
 * ledgerEngine.ts's own canonicalization step) across every consumer in the
 * ledger/allocation/holdings family, a materially larger, separately-risked
 * change. See docs/PORTFOLIO_OS_V2_SPEC.md's migration backlog for that
 * follow-up, scoped on its own.
 */
export type GroupingSignature = string & { readonly __brand: "GroupingSignature" };

export function toGroupingSignature(value: string): GroupingSignature {
  return value as GroupingSignature;
}

import type { CandidateEntry } from "@presentation/lib/importSession";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import type { ReconcileSuggestion } from "@application/services/mismatchResolver";
import { CandidateRow } from "@presentation/components/CandidateRow";
import { useT } from "@presentation/i18n/translations";

interface TickerSellRowsProps {
  sells: CandidateEntry[];
  skippedKeys: Set<string>;
  addedKeys: Set<string>;
  matched: boolean;
  portfolioResolved: boolean;
  rowErrors: Record<string, string>;
  duplicateMatch: (
    candidate: ParsedTradeCandidate,
    ownTradeId?: string,
    ownAllocationIds?: string[],
  ) => { matchType: "exact" | "possible"; matchedId: string } | undefined;
  addedAllocationIds?: Record<string, string[]>;
  suspectedDuplicateKeys: Set<string>;
  reconcileSuggestion?: ReconcileSuggestion;
  wrongTickerHints?: Map<string, string>;
  dateMisreadHints?: Map<string, string>;
  crossVerifiedKeys?: Set<string>;
  aggregateConfirmedKeys?: Set<string>;
  aggregateGroupDetailByKey?: Map<string, string>;
  orderConfirmedKeys?: Set<string>;
  highlightUnmatchedByOrders: boolean;
  onAllocateSell: (entry: CandidateEntry) => void;
  onSmartAllocate?: (entry: CandidateEntry) => Promise<void>;
  onDiscardPending: (entry: CandidateEntry) => void;
}

/** Sell row list for a ticker's card — composes CandidateRow per still-visible pending/added row. All duplicate/eligibility/reconciliation decisions are computed by the parent and passed in already-derived. */
export function TickerSellRows({
  sells,
  skippedKeys,
  addedKeys,
  matched,
  portfolioResolved,
  rowErrors,
  duplicateMatch,
  addedAllocationIds,
  suspectedDuplicateKeys,
  reconcileSuggestion,
  wrongTickerHints,
  dateMisreadHints,
  crossVerifiedKeys,
  aggregateConfirmedKeys,
  aggregateGroupDetailByKey,
  orderConfirmedKeys,
  highlightUnmatchedByOrders,
  onAllocateSell,
  onSmartAllocate,
  onDiscardPending,
}: TickerSellRowsProps) {
  const t = useT();
  return (
    <>
      {sells
        .filter((entry) => !skippedKeys.has(entry.key))
        .map((entry) => {
          const match = duplicateMatch(entry.candidate, undefined, addedAllocationIds?.[entry.key]);
          const added = addedKeys.has(entry.key);
          const disabled = !matched || !portfolioResolved;
          return (
            <CandidateRow
              key={entry.key}
              entry={entry}
              match={match}
              added={added}
              skipped={skippedKeys.has(entry.key)}
              actionLabel={match ? t("importPage.allocateAnyway") : t("importPage.allocateSell")}
              actionClassName="bg-rose-500 hover:bg-rose-400"
              onAction={() => onAllocateSell(entry)}
              smartActionLabel={t("importPage.smartAllocate")}
              onSmartAction={onSmartAllocate ? () => onSmartAllocate(entry) : undefined}
              disabled={disabled}
              disabledReason={
                !matched
                  ? t("importPage.verifyTickerFirst")
                  : !portfolioResolved
                    ? t("importPage.pickPortfolioFirst")
                    : undefined
              }
              suspectedDuplicate={suspectedDuplicateKeys.has(entry.key)}
              suggestedRemoval={reconcileSuggestion?.keysToRemove.includes(entry.key) ?? false}
              wrongTickerHint={wrongTickerHints?.get(entry.key)}
              dateMisreadHint={dateMisreadHints?.get(entry.key)}
              crossSourceVerified={crossVerifiedKeys?.has(entry.key) ?? false}
              aggregateConfirmed={aggregateConfirmedKeys?.has(entry.key) ?? false}
              aggregateMatchDetail={aggregateGroupDetailByKey?.get(entry.key)}
              orderConfirmed={orderConfirmedKeys?.has(entry.key) ?? false}
              noMatchingOrder={highlightUnmatchedByOrders && !(orderConfirmedKeys?.has(entry.key) ?? false)}
              error={rowErrors[entry.key]}
              onDiscardPending={() => onDiscardPending(entry)}
            />
          );
        })}
    </>
  );
}

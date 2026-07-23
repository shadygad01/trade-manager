import type { CandidateEntry } from "@presentation/lib/importSession";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import type { ReconcileSuggestion } from "@application/services/mismatchResolver";
import { AutoCommitRow } from "@presentation/components/AutoCommitRow";

interface TickerBuyRowsProps {
  buys: CandidateEntry[];
  skippedKeys: Set<string>;
  addedKeys: Set<string>;
  dismissedKeys: Set<string>;
  portfolioResolved: boolean;
  matched: boolean;
  distributing: boolean;
  rowErrors: Record<string, string>;
  duplicateMatch: (
    candidate: ParsedTradeCandidate,
    ownTradeId?: string,
    ownAllocationIds?: string[],
  ) => { matchType: "exact" | "possible"; matchedId: string } | undefined;
  addedTradeIds: Record<string, string>;
  suspectedDuplicateKeys: Set<string>;
  reconcileSuggestion?: ReconcileSuggestion;
  wrongTickerHints?: Map<string, string>;
  dateMisreadHints?: Map<string, string>;
  crossVerifiedKeys?: Set<string>;
  aggregateConfirmedKeys?: Set<string>;
  aggregateGroupDetailByKey?: Map<string, string>;
  orderConfirmedKeys?: Set<string>;
  highlightUnmatchedByOrders: boolean;
  onDeleteAutoAdded: (entry: CandidateEntry) => void;
  onDiscardPending: (entry: CandidateEntry) => void;
}

/** Buy row list for a ticker's card — composes AutoCommitRow per still-visible pending/added row. All duplicate/eligibility/reconciliation decisions are computed by the parent and passed in already-derived. */
export function TickerBuyRows({
  buys,
  skippedKeys,
  addedKeys,
  dismissedKeys,
  portfolioResolved,
  matched,
  distributing,
  rowErrors,
  duplicateMatch,
  addedTradeIds,
  suspectedDuplicateKeys,
  reconcileSuggestion,
  wrongTickerHints,
  dateMisreadHints,
  crossVerifiedKeys,
  aggregateConfirmedKeys,
  aggregateGroupDetailByKey,
  orderConfirmedKeys,
  highlightUnmatchedByOrders,
  onDeleteAutoAdded,
  onDiscardPending,
}: TickerBuyRowsProps) {
  return (
    <>
      {buys
        .filter((entry) => !skippedKeys.has(entry.key))
        .map((entry) => {
          const match = duplicateMatch(entry.candidate, addedTradeIds[entry.key]);
          return (
            <AutoCommitRow
              key={entry.key}
              entry={entry}
              match={match}
              added={addedKeys.has(entry.key)}
              skipped={skippedKeys.has(entry.key)}
              dismissed={dismissedKeys.has(entry.key)}
              portfolioResolved={portfolioResolved}
              matched={matched}
              distributing={distributing}
              error={rowErrors[entry.key]}
              suspectedDuplicate={suspectedDuplicateKeys.has(entry.key)}
              suggestedRemoval={reconcileSuggestion?.keysToRemove.includes(entry.key) ?? false}
              wrongTickerHint={wrongTickerHints?.get(entry.key)}
              dateMisreadHint={dateMisreadHints?.get(entry.key)}
              crossSourceVerified={crossVerifiedKeys?.has(entry.key) ?? false}
              aggregateConfirmed={aggregateConfirmedKeys?.has(entry.key) ?? false}
              aggregateMatchDetail={aggregateGroupDetailByKey?.get(entry.key)}
              orderConfirmed={orderConfirmedKeys?.has(entry.key) ?? false}
              noMatchingOrder={highlightUnmatchedByOrders && !(orderConfirmedKeys?.has(entry.key) ?? false)}
              onDelete={() => onDeleteAutoAdded(entry)}
              onDiscardPending={() => onDiscardPending(entry)}
            />
          );
        })}
    </>
  );
}

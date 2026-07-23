import { useCallback } from "react";
import { runSerialized } from "@application/services/serialize";
import { normalizeTicker } from "@domain/value-objects/Ticker";

function queueKey(portfolioId: string, ticker: string): string {
  return `${portfolioId}|${normalizeTicker(ticker)}`;
}

export function useCommitQueue() {
  const run = useCallback(
    <T,>(portfolioId: string, ticker: string, operation: () => Promise<T>): Promise<T> =>
      runSerialized(queueKey(portfolioId, ticker), operation),
    [],
  );

  return { run } as const;
}

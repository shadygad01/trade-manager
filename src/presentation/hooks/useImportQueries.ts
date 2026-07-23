import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { ParsedTradeCandidate } from "@domain/entities/Upload";
import type { ImportSessionState } from "@presentation/lib/importSession";
import { repos } from "@presentation/lib/data";

type QueryInputs = Pick<
  ImportSessionState,
  "pendingCandidates" | "pendingVerifications" | "pendingDividends" | "pendingOrderEvidences"
>;

export function useImportQueries(inputs: QueryInputs, distributing: boolean) {
  const [error, setError] = useState<Error | null>(null);
  const pendingTickerKey = useMemo(
    () =>
      [
        ...new Set([
          ...inputs.pendingCandidates.map((entry) => normalizeTicker(entry.candidate.ticker)),
          ...inputs.pendingVerifications.map((entry) => normalizeTicker(entry.verification.ticker)),
          ...inputs.pendingDividends
            .map((entry) => entry.dividend.ticker)
            .filter((ticker): ticker is string => Boolean(ticker))
            .map(normalizeTicker),
          ...inputs.pendingOrderEvidences.map((entry) => normalizeTicker(entry.evidence.ticker)),
        ]),
      ]
        .sort()
        .join("|"),
    [inputs.pendingCandidates, inputs.pendingVerifications, inputs.pendingDividends, inputs.pendingOrderEvidences],
  );
  const pendingTickers = useMemo(() => (pendingTickerKey ? pendingTickerKey.split("|") : []), [pendingTickerKey]);

  const portfoliosSnapshot = useRef<Awaited<ReturnType<typeof repos.portfolios.getAll>>>([]);
  const tradesSnapshot = useRef<Awaited<ReturnType<typeof repos.trades.getAll>>>([]);
  const allocationsSnapshot = useRef<Awaited<ReturnType<typeof repos.allocations.getAll>>>([]);
  const rawSnapshot = useRef<Awaited<ReturnType<typeof repos.rawTransactions.getAll>>>([]);
  const verificationsSnapshot = useRef<Awaited<ReturnType<typeof repos.verifications.getAll>>>([]);
  const timelineSnapshot = useRef<Awaited<ReturnType<typeof repos.timeline.getAll>>>([]);

  useEffect(() => setError(null), [pendingTickerKey, distributing]);

  async function query<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      return undefined;
    }
  }

  const queryByTickers = <T extends { ticker?: string }>(
    repository: { getAll: () => Promise<T[]>; getByTicker?: (ticker: string) => Promise<T[]> },
  ) =>
    pendingTickers.length === 0
      ? Promise.resolve([] as T[])
      : repository.getByTicker
        ? Promise.all(pendingTickers.map((ticker) => repository.getByTicker!(ticker))).then((rows) => rows.flat())
        : repository.getAll();

  const portfoliosRaw = useLiveQuery(
    () =>
      query(async () => {
        if (distributing) return portfoliosSnapshot.current;
        const rows = await repos.portfolios.getAll();
        portfoliosSnapshot.current = rows;
        return rows;
      }),
    [distributing],
  );
  const tradesRaw = useLiveQuery(
    () =>
      query(async () => {
        if (distributing) return tradesSnapshot.current;
        const rows = await queryByTickers(repos.trades);
        tradesSnapshot.current = rows;
        return rows;
      }),
    [pendingTickerKey, distributing],
  );
  const allocationsRaw = useLiveQuery(
    () =>
      query(async () => {
        if (distributing) return allocationsSnapshot.current;
        const rows = await queryByTickers(repos.allocations);
        allocationsSnapshot.current = rows;
        return rows;
      }),
    [pendingTickerKey, distributing],
  );
  const rawTransactionsRaw = useLiveQuery(
    () =>
      query(async () => {
        if (distributing) return rawSnapshot.current;
        const rows = await queryByTickers(repos.rawTransactions);
        const controls = await repos.rawTransactions.getControlFacts?.();
        await repos.rawTransactions.getRevision?.();
        if (!controls || controls.length === 0) {
          rawSnapshot.current = rows;
          return rows;
        }
        const seen = new Set(rows.map((row) => row.id));
        const combined = [...rows, ...controls.filter((control) => !seen.has(control.id))];
        rawSnapshot.current = combined;
        return combined;
      }),
    [pendingTickerKey, distributing],
  );
  const uploadsRaw = useLiveQuery(
    () => query(async () => (pendingTickers.length === 0 ? [] : repos.uploads.getAll())),
    [pendingTickerKey],
  );
  const verificationsRaw = useLiveQuery(
    () =>
      query(async () => {
        if (distributing) return verificationsSnapshot.current;
        const rows = await queryByTickers(repos.verifications);
        verificationsSnapshot.current = rows;
        return rows;
      }),
    [pendingTickerKey, distributing],
  );
  const timelineRaw = useLiveQuery(
    () =>
      query(async () => {
        if (distributing) return timelineSnapshot.current;
        const rows = await repos.timeline.getAll();
        timelineSnapshot.current = rows;
        return rows;
      }),
    [distributing],
  );

  const officialUploadCandidatesByTicker = useMemo(() => {
    const byTicker = new Map<string, ParsedTradeCandidate[]>();
    for (const upload of uploadsRaw ?? []) {
      for (const candidate of upload.candidates.filter((item) => item.source === "official-broker-excel")) {
        const ticker = normalizeTicker(candidate.ticker);
        byTicker.set(ticker, [...(byTicker.get(ticker) ?? []), candidate]);
      }
    }
    return byTicker;
  }, [uploadsRaw]);

  const loading = [portfoliosRaw, tradesRaw, allocationsRaw, rawTransactionsRaw, verificationsRaw, timelineRaw].some(
    (result) => result === undefined,
  );

  return {
    pendingTickerKey,
    pendingTickers,
    loading,
    ready: !loading && error === null,
    error,
    portfolios: portfoliosRaw ?? [],
    existingTrades: tradesRaw ?? [],
    existingAllocations: allocationsRaw ?? [],
    existingRawTransactions: rawTransactionsRaw ?? [],
    rawTransactionsLoaded: rawTransactionsRaw !== undefined,
    existingVerifications: verificationsRaw ?? [],
    existingTimeline: timelineRaw ?? [],
    officialUploadCandidatesByTicker,
  } as const;
}

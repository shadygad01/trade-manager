import { useCallback, useMemo } from "react";

const inFlightKeys = new Set<string>();

export function useCommitLock() {
  const isLocked = useCallback((key: string) => inFlightKeys.has(key), []);
  const acquire = useCallback((key: string) => {
    inFlightKeys.add(key);
  }, []);
  const release = useCallback((key: string) => {
    inFlightKeys.delete(key);
  }, []);
  const runWithLock = useCallback(
    async <T,>(key: string, work: () => Promise<T>): Promise<T> => {
      acquire(key);
      try {
        return await work();
      } finally {
        release(key);
      }
    },
    [acquire, release],
  );

  return useMemo(
    () => ({ isLocked, acquire, release, runWithLock }),
    [isLocked, acquire, release, runWithLock],
  );
}

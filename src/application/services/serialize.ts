/**
 * Per-key async serialization: calls sharing the same `key` run strictly one
 * at a time, in call order, even when triggered back-to-back before the
 * previous one has settled — a call for a DIFFERENT key is entirely
 * unaffected and runs independently/concurrently.
 *
 * Exists for exactly one problem: a Sell allocation (Smart Allocate or the
 * manual Allocate Sell form) reads a ticker's open lots, decides which to
 * close, then writes and commits — several `await`s apart. Firing a second
 * allocation for the SAME (portfolio, ticker) before the first has fully
 * committed and re-projected lets the second one read the lots the first
 * hasn't finished updating yet, misreporting a real position as "Not enough
 * open shares" even though the shares genuinely exist. Wrapping the ENTIRE
 * read-decide-write-commit sequence in `runSerialized` under a
 * `${portfolioId}|${ticker}` key makes the second call wait for the first's
 * promise to fully settle before it even starts its own read — the user can
 * still click through several Sells quickly; internally they now queue and
 * run one at a time instead of racing.
 *
 * Deliberately generic (not sell-specific) and framework-agnostic — no
 * business logic, no knowledge of trades/allocations/FIFO. Callers own the
 * key and the operation; this only guarantees ordering.
 */
const queueTails = new Map<string, Promise<unknown>>();

export function runSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previousTail = queueTails.get(key) ?? Promise.resolve();
  // Waits for the previous call regardless of whether it succeeded or
  // failed — one failed allocation must never permanently jam the queue for
  // every later one on the same ticker.
  const run = previousTail.catch(() => undefined).then(operation);
  const tail = run.catch(() => undefined);
  queueTails.set(key, tail);
  void tail.finally(() => {
    // Only this call's own entry, not one a later call already replaced it
    // with — otherwise finishing call A could delete the map entry a
    // still-in-flight call B just installed, right before B's own real
    // callers' cleanup runs.
    if (queueTails.get(key) === tail) queueTails.delete(key);
  });
  return run;
}

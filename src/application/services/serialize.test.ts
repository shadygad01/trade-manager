import { describe, it, expect } from "vitest";
import { runSerialized } from "./serialize";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes enough microtask turns for a `runSerialized` chain (previousTail.catch().then(operation)) to settle whatever it's going to settle on its own — used to assert "has NOT started yet" without a real timer. */
async function flushMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("runSerialized", () => {
  it("runs calls with the same key strictly one at a time, in call order — the second never starts before the first settles", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = runSerialized("k1", async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });
    const p2 = runSerialized("k1", async () => {
      order.push("second-start");
    });

    await flushMicrotasks();
    expect(order).toEqual(["first-start"]); // second must NOT have started yet

    first.resolve();
    await p1;
    await p2;
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("lets calls with DIFFERENT keys run concurrently, unaffected by each other", async () => {
    const order: string[] = [];
    const a = deferred<void>();

    const pA = runSerialized("k2a", async () => {
      order.push("a-start");
      await a.promise;
      order.push("a-end");
    });
    const pB = runSerialized("k2b", async () => {
      order.push("b-start-and-end");
    });

    await pB; // B must complete without waiting on A at all
    expect(order).toEqual(["a-start", "b-start-and-end"]);

    a.resolve();
    await pA;
    expect(order).toEqual(["a-start", "b-start-and-end", "a-end"]);
  });

  it("a failed call does not jam the queue — later calls for the same key still run", async () => {
    const order: string[] = [];

    const p1 = runSerialized("k3", async () => {
      order.push("first");
      throw new Error("boom");
    });
    const p2 = runSerialized("k3", async () => {
      order.push("second");
      return "ok";
    });

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("preserves strict FIFO order across more than two queued calls", async () => {
    const order: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const promises = [0, 1, 2].map((i) =>
      runSerialized("k4", async () => {
        order.push(i);
        await gates[i].promise;
      }),
    );

    await flushMicrotasks();
    expect(order).toEqual([0]); // only the first has started

    gates[0].resolve();
    await flushMicrotasks();
    expect(order).toEqual([0, 1]);

    gates[1].resolve();
    await flushMicrotasks();
    expect(order).toEqual([0, 1, 2]);

    gates[2].resolve();
    await Promise.all(promises);
  });

  it("returns the operation's own resolved value to its caller", async () => {
    const result = await runSerialized("k5", async () => 42);
    expect(result).toBe(42);
  });
});

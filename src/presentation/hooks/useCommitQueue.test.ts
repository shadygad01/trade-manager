// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommitQueue } from "./useCommitQueue";

describe("useCommitQueue", () => {
  it("serializes operations for the same normalized portfolio and ticker key", async () => {
    const { result } = renderHook(() => useCommitQueue());
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = result.current.run("p1", " abuk ", async () => {
      order.push("first-start");
      markFirstStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = result.current.run("p1", "ABUK", async () => {
      order.push("second");
    });

    await firstStarted;
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

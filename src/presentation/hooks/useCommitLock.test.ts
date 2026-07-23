// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommitLock } from "./useCommitLock";

describe("useCommitLock", () => {
  it("exposes synchronous lock status", () => {
    const { result } = renderHook(() => useCommitLock());

    result.current.acquire("candidate-1");
    expect(result.current.isLocked("candidate-1")).toBe(true);

    result.current.release("candidate-1");
    expect(result.current.isLocked("candidate-1")).toBe(false);
  });

  it("always releases a lock when guarded work throws", async () => {
    const { result } = renderHook(() => useCommitLock());

    await expect(
      result.current.runWithLock("candidate-2", async () => {
        expect(result.current.isLocked("candidate-2")).toBe(true);
        throw new Error("commit failed");
      }),
    ).rejects.toThrow("commit failed");

    expect(result.current.isLocked("candidate-2")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotPriceRepository } from "./SnapshotPriceRepository";

describe("SnapshotPriceRepository", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("fetches and exposes prices and the asOf timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ asOf: "2026-07-03T09:00:00.000Z", prices: { COMI: 75.5 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    expect(await repo.getPrice("COMI")).toBe(75.5);
    expect(await repo.getAllPrices()).toEqual({ COMI: 75.5 });
    expect(await repo.getSnapshotTimestamp()).toBe("2026-07-03T09:00:00.000Z");
  });

  it("caches results for the TTL window instead of refetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ asOf: "2026-07-03T09:00:00.000Z", prices: { COMI: 75.5 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    await repo.getPrice("COMI");
    await repo.getAllPrices();
    await repo.getSnapshotTimestamp();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined/empty instead of throwing when the fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    await expect(repo.getPrice("COMI")).resolves.toBeUndefined();
    await expect(repo.getAllPrices()).resolves.toEqual({});
    await expect(repo.getSnapshotTimestamp()).resolves.toBeUndefined();
  });

  it("returns undefined/empty when the response is not ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    await expect(repo.getPrice("COMI")).resolves.toBeUndefined();
    await expect(repo.getAllPrices()).resolves.toEqual({});
  });
});

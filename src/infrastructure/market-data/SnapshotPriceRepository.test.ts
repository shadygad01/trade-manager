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
    expect(await repo.getSnapshotInfo()).toEqual({ asOf: "2026-07-03T09:00:00.000Z", latestQuoteAt: undefined });
  });

  it("reports the latest market quote time from a snapshot with per-ticker quotes (the last-close upgrade)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        asOf: "2026-07-04T13:05:00.000Z",
        prices: { COMI: 75.5, ORHD: 23.8 },
        quotes: {
          COMI: { price: 75.5, quotedAt: "2026-07-04T12:30:00.000Z", source: "yahoo" },
          ORHD: { price: 23.8, quotedAt: "2026-07-04T12:29:00.000Z", source: "yahoo" },
        },
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    expect(await repo.getPrice("ORHD")).toBe(23.8);
    expect(await repo.getSnapshotInfo()).toEqual({
      asOf: "2026-07-04T13:05:00.000Z",
      latestQuoteAt: "2026-07-04T12:30:00.000Z",
    });
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
    await repo.getSnapshotInfo();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined/empty instead of throwing when the fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    await expect(repo.getPrice("COMI")).resolves.toBeUndefined();
    await expect(repo.getAllPrices()).resolves.toEqual({});
    await expect(repo.getSnapshotInfo()).resolves.toBeNull();
  });

  it("returns undefined/empty when the response is not ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const repo = new SnapshotPriceRepository("/price-snapshot.json");

    await expect(repo.getPrice("COMI")).resolves.toBeUndefined();
    await expect(repo.getAllPrices()).resolves.toEqual({});
  });
});

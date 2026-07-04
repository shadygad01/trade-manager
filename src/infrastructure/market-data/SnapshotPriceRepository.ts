import type { PriceRepository, PriceSnapshotInfo } from "@domain/repositories";

interface PriceSnapshot {
  asOf: string;
  prices: Record<string, number>;
  /** Per-ticker quote metadata (price + market quote time + provider) — written by fetch-prices since the last-close upgrade; absent in older snapshots, so always optional. */
  quotes?: Record<string, { price: number; quotedAt?: string; source: string }>;
}

const DEFAULT_SNAPSHOT_PATH = () => `${import.meta.env.BASE_URL}price-snapshot.json`;
const CACHE_TTL_MS = 60_000;

/**
 * This class is the ONLY place in the app allowed to read market price data
 * (product requirement: "never introduce multiple competing price sources").
 * It reads a static JSON snapshot produced out-of-band by scripts/fetch-prices
 * and committed to /public, so a failed fetch means "prices unavailable right
 * now" — it must never throw, since price staleness must never crash the app.
 */
export class SnapshotPriceRepository implements PriceRepository {
  private cache: PriceSnapshot | undefined;
  private cacheFetchedAt = 0;
  private inFlight: Promise<PriceSnapshot | undefined> | undefined;

  constructor(private readonly snapshotPath?: string) {}

  async getPrice(ticker: string): Promise<number | undefined> {
    const snapshot = await this.load();
    return snapshot?.prices[ticker];
  }

  async getAllPrices(): Promise<Record<string, number>> {
    const snapshot = await this.load();
    return snapshot?.prices ?? {};
  }

  async getSnapshotInfo(): Promise<PriceSnapshotInfo | null> {
    const snapshot = await this.load();
    if (!snapshot || Object.keys(snapshot.prices).length === 0) return null;
    const quoteTimes = Object.values(snapshot.quotes ?? {})
      .map((q) => q.quotedAt)
      .filter((t): t is string => typeof t === "string");
    const latestQuoteAt = quoteTimes.length ? quoteTimes.reduce((a, b) => (a > b ? a : b)) : undefined;
    return { asOf: snapshot.asOf, latestQuoteAt };
  }

  private async load(): Promise<PriceSnapshot | undefined> {
    const isFresh = this.cache !== undefined && Date.now() - this.cacheFetchedAt < CACHE_TTL_MS;
    if (isFresh) {
      return this.cache;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchSnapshot();
    try {
      const snapshot = await this.inFlight;
      this.cache = snapshot;
      this.cacheFetchedAt = Date.now();
      return snapshot;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async fetchSnapshot(): Promise<PriceSnapshot | undefined> {
    const path = this.snapshotPath ?? DEFAULT_SNAPSHOT_PATH();
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        return undefined;
      }
      const data = (await response.json()) as PriceSnapshot;
      if (!data || typeof data.asOf !== "string" || typeof data.prices !== "object") {
        return undefined;
      }
      return data;
    } catch {
      return undefined;
    }
  }
}

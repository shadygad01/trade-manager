import { useSyncExternalStore } from "react";
import { getTrackingStartDate, setTrackingStartDate } from "@domain/value-objects/trackingWindow";

const STORAGE_KEY = "portfolio-os:tracking-start-date";

function load(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return raw;
  } catch {
    // Storage unavailable (e.g. private browsing) — keep the domain default.
  }
  return getTrackingStartDate();
}

setTrackingStartDate(load());

const listeners = new Set<() => void>();

/**
 * Reactive wrapper around the domain's mutable tracking-start-date setting
 * (see trackingWindow.ts) — persists the Import page's start-date picker to
 * localStorage and re-applies it on load, the same pattern language.ts
 * already uses for the language toggle. TradeService/PortfolioService read
 * the domain value directly (no React dependency), so calling set() here
 * immediately changes what they accept too, not just what this store reports.
 */
export const trackingStartDateStore = {
  get(): string {
    return getTrackingStartDate();
  },
  set(next: string): void {
    if (next === getTrackingStartDate()) return;
    setTrackingStartDate(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage full/unavailable — the change still applies for this page load.
    }
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useTrackingStartDate(): string {
  return useSyncExternalStore(trackingStartDateStore.subscribe, trackingStartDateStore.get, trackingStartDateStore.get);
}

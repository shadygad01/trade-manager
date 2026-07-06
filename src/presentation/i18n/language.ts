import { useSyncExternalStore } from "react";

export type Language = "en" | "ar";

const STORAGE_KEY = "portfolio-os:language";

function load(): Language {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "ar" || raw === "en") return raw;
  } catch {
    // Storage unavailable (e.g. private browsing) — default to English.
  }
  return "en";
}

let language: Language = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage full/unavailable — the toggle still works for this page load.
  }
}

/**
 * Module-level store (not React context) so plain functions like
 * formatMoney/formatDate — called from many places outside any component
 * tree — can read the current language synchronously, the same pattern
 * importSession.ts already uses for the Import pool.
 */
export const languageStore = {
  get(): Language {
    return language;
  },
  set(next: Language): void {
    if (next === language) return;
    language = next;
    persist();
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useLanguage(): Language {
  return useSyncExternalStore(languageStore.subscribe, languageStore.get, languageStore.get);
}

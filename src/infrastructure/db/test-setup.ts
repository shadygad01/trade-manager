/**
 * Vitest runs with environment: "node", which has no IndexedDB. fake-indexeddb/auto
 * installs an in-memory IndexedDB implementation on globalThis so Dexie-backed
 * repositories can be unit tested without a browser.
 */
import "fake-indexeddb/auto";

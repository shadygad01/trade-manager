// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isDeveloperModeEnabled } from "./developerMode";

const STORAGE_KEY = "portfolio-os:developer-mode";

describe("isDeveloperModeEnabled", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("is off by default, on a fresh app load with nothing in storage", () => {
    expect(isDeveloperModeEnabled()).toBe(false);
  });

  it("is on only when the exact persisted flag value is set", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    expect(isDeveloperModeEnabled()).toBe(true);
  });

  it("treats any other stored value as off, not just missing", () => {
    localStorage.setItem(STORAGE_KEY, "yes");
    expect(isDeveloperModeEnabled()).toBe(false);
  });
});

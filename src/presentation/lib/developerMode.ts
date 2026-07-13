/**
 * Developer Mode gate (docs/DIAGNOSTICS_CENTER_SPEC.md Part 4.1) — hidden,
 * off by default, the sole switch deciding whether the Diagnostics Center
 * records anything or is even reachable in the UI (Part 7.1). Read once at
 * module load / composition-root time (`presentation/lib/data.ts`,
 * `presentation/App.tsx`) — toggling it takes effect on the next page load,
 * not live, since it decides which DiagnosticsRecorder implementation and
 * which routes get wired up.
 *
 * No feature-flag mechanism existed anywhere in this app before this file
 * (confirmed during the architecture spec's research) and there is no
 * Settings screen with a version number to hide a tap-sequence behind
 * (Part 13's open question #1), so the hidden toggle is a keyboard shortcut:
 * Ctrl+Alt+Shift+D. Unlike a URL parameter, it never leaks via a shared
 * link or screenshot.
 */

const STORAGE_KEY = "portfolio-os:developer-mode";

export function isDeveloperModeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Storage unavailable (e.g. private browsing) — Developer Mode stays off.
    return false;
  }
}

function setDeveloperModeEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable — the toggle has no effect beyond this page load.
  }
}

/**
 * Registers the Ctrl+Alt+Shift+D listener once. Toggling reloads the page —
 * every consumer of `isDeveloperModeEnabled()` reads it once at boot, so a
 * live in-place toggle would leave the recorder/route wiring stale.
 */
export function installDeveloperModeHiddenToggle(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
      setDeveloperModeEnabled(!isDeveloperModeEnabled());
      window.location.reload();
    }
  });
}

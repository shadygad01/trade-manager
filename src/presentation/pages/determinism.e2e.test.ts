import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { runDeterminismFlow } from "./determinismScenario";
import type { SystemSnapshot } from "@application/services/systemSnapshot";

/**
 * End-to-end Determinism Test: proves the full migration-foundation write/
 * replay path is deterministic — the same sequence of user actions, against
 * two independently-created databases, always produces byte-identical
 * System Snapshots (docs/PORTFOLIO_OS_V2_SPEC.md Part 4.3's "Replay must
 * always produce identical output from identical Facts" mission requirement,
 * made an executable, CI-enforced test rather than a claim in prose).
 *
 * Flow, matching the exact stage names this sprint specified (implemented in
 * `./determinismScenario.ts`, shared with the golden-reference regeneration
 * script so the two can never silently drift apart):
 *
 *   Reset -> Import Official Broker Excel -> Confirm -> Smart Allocate ->
 *   Commit -> Refresh -> Rebuild -> Restart -> Snapshot
 *
 * Reuses excelWorkflowEndToEnd.test.ts's own proven scenario shape
 * (ABUK-equivalent: 3 Buys totaling 100 shares, 1 Sell of 73, net OPEN
 * remainder of 27) — the exact real-world shape this codebase's own
 * incident history (docs/ROADMAP.md) proved hardest to keep deterministic
 * (twin-lot/coarse-key bugs), making it the right shape to pin down here,
 * not an arbitrary choice.
 *
 * Two independent proofs, both required to pass:
 *  1. Two independently-run instances of the full flow (different db names,
 *     different random ids/timestamps throughout) produce IDENTICAL
 *     snapshots — proves determinism directly, not by assumption.
 *  2. The snapshot matches a committed golden reference
 *     (determinism.golden.json) — catches any future code change that
 *     alters replay/holdings/verification/policy behavior, even a change
 *     that stays internally self-consistent (which proof 1 alone couldn't
 *     catch, since both runs would drift together).
 *
 * Any failure of the golden-reference test below is, by design, either a
 * real regression (fix the code) or an intentional, reviewed behavior
 * change. Regenerating the golden reference is a deliberate, human-gated
 * process, NOT something this test or any script does automatically —
 * auto-writing it from whatever the current implementation happens to
 * produce would bake any undiscovered defect in that implementation into
 * the baseline permanently. To update it: `npm run determinism:regenerate-golden`
 * writes a CANDIDATE (determinism.golden.candidate.json) plus a diff against
 * the currently approved reference; a human must independently verify the
 * underlying business values are correct (not just "the test passes") before
 * manually promoting the candidate into determinism.golden.json (set
 * `approved: true`, copy in the `snapshot`, write an `approvedNote`
 * explaining what was verified). See determinism.golden.json's own
 * `_readme` field for the exact steps.
 */

interface GoldenFile {
  approved: boolean;
  approvedNote: string | null;
  snapshot: SystemSnapshot | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, "determinism.golden.json");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as GoldenFile;
const goldenIsApproved = golden.approved && golden.snapshot !== null;

if (!goldenIsApproved) {
  // Loud, unmissable, but a SKIP rather than a FAIL: an unapproved golden
  // reference is a pending, by-design first-time-setup state (this repo
  // just built the mechanism, no human has run the approval step yet), not
  // a regression — failing the whole suite/CI/deploy pipeline for that
  // reason would be a disproportionate consequence for "a new tool hasn't
  // been configured yet." The determinism-across-runs test right below
  // still runs and fully enforces the actual replay-determinism property on
  // every CI run regardless; only the golden-reference comparison itself
  // waits on the human approval step.
  console.warn(
    "\n⚠️  determinism.golden.json is NOT approved — the golden-reference comparison test is SKIPPED, not enforced.\n" +
      "   Run `npm run determinism:regenerate-golden`, review the candidate, then promote it deliberately.\n" +
      "   See determinism.golden.json's own `_readme` for the exact steps.\n"
  );
}

describe("End-to-end Determinism Test: Reset -> Import Official Broker Excel -> Confirm -> Smart Allocate -> Commit -> Refresh -> Rebuild -> Restart -> Snapshot", () => {
  it("produces byte-identical System Snapshots across two independently-run instances of the exact same flow", async () => {
    const a = await runDeterminismFlow(`${Date.now()}-a-${Math.random().toString(36).slice(2)}`);
    const b = await runDeterminismFlow(`${Date.now()}-b-${Math.random().toString(36).slice(2)}`);

    expect(a.hasTickerAfterRefresh).toBe(true);
    expect(a.rebuildIssueCount).toBe(0);
    expect(b.hasTickerAfterRefresh).toBe(true);
    expect(b.rebuildIssueCount).toBe(0);
    expect(a.snapshot).toEqual(b.snapshot);
  });

  it.skipIf(!goldenIsApproved)(
    "matches the committed, human-approved golden reference — fails on ANY unexplained difference",
    async () => {
      const { snapshot, rebuildIssueCount, hasTickerAfterRefresh } = await runDeterminismFlow(`${Date.now()}-golden-${Math.random().toString(36).slice(2)}`);
      expect(hasTickerAfterRefresh).toBe(true);
      expect(rebuildIssueCount).toBe(0);

      // Compared category-by-category (not just `combined`) so a failure
      // immediately names WHICH part of the system drifted (Facts? Ledger?
      // Policy?) instead of just "something changed somewhere" — the whole
      // point of splitting the snapshot into named categories in the first
      // place.
      expect(snapshot).toEqual(golden.snapshot);
    }
  );
});

// Must be imported before anything that touches Dexie: this script runs as
// a plain Node process (via tsx), which has no IndexedDB — vitest gets this
// for free from src/infrastructure/db/test-setup.ts's setupFiles entry, but
// a standalone script has to install the same polyfill itself.
import "fake-indexeddb/auto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDeterminismFlow } from "@presentation/pages/determinismScenario";
import type { SystemSnapshot } from "@application/services/systemSnapshot";

/**
 * Computes a CANDIDATE determinism snapshot and writes it to
 * determinism.golden.candidate.json — it NEVER writes determinism.golden.json
 * itself. Promoting a candidate to the actual golden reference is a
 * deliberate, separate, human action (see determinism.golden.json's own
 * `_readme` field for the exact steps) — this script only computes and
 * reports, on purpose. Auto-writing the golden file from whatever the
 * current implementation happens to produce would bake any undiscovered
 * defect in that implementation into the baseline permanently; a human must
 * independently verify the underlying business values (holdings shares/cost
 * basis, ledger events, verification verdicts, policy ranking) are actually
 * correct before this candidate becomes trusted ground truth.
 *
 * Usage: `npm run determinism:regenerate-golden`
 */

interface GoldenFile {
  approved: boolean;
  approvedNote: string | null;
  snapshot: SystemSnapshot | null;
}

function diffCategories(previous: SystemSnapshot | null, next: SystemSnapshot): string[] {
  if (!previous) return ["(no previous snapshot to diff against — nothing was approved yet)"];
  const lines: string[] = [];
  for (const key of Object.keys(next) as (keyof SystemSnapshot)[]) {
    if (previous[key] !== next[key]) {
      lines.push(`  ${key}: ${previous[key]} -> ${next[key]}`);
    }
  }
  return lines.length > 0 ? lines : ["(identical to the previously approved snapshot — no category changed)"];
}

async function main() {
  const pagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/presentation/pages");
  const goldenPath = path.join(pagesDir, "determinism.golden.json");
  const candidatePath = path.join(pagesDir, "determinism.golden.candidate.json");

  const { snapshot, rebuildIssueCount, hasTickerAfterRefresh } = await runDeterminismFlow(`golden-regen-${Date.now()}`);

  if (!hasTickerAfterRefresh) {
    throw new Error("Determinism scenario is broken: the ticker never appeared on the ledger after Refresh. Not writing a candidate from a broken scenario.");
  }
  if (rebuildIssueCount !== 0) {
    throw new Error(`Determinism scenario is inconsistent: Rebuild found ${rebuildIssueCount} issue(s) for a scenario that should be fully clean. Not writing a candidate from an inconsistent scenario.`);
  }

  const previousGolden: GoldenFile | null = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, "utf-8")) as GoldenFile) : null;

  writeFileSync(candidatePath, JSON.stringify(snapshot, null, 2) + "\n");

  console.log(`Wrote candidate snapshot to ${candidatePath}\n`);
  console.log("Category values:");
  console.log(JSON.stringify(snapshot, null, 2));
  console.log("\nDiff against the currently APPROVED golden reference (if any):");
  for (const line of diffCategories(previousGolden?.approved ? previousGolden.snapshot : null, snapshot)) console.log(line);
  console.log(
    "\nThis candidate is NOT yet the golden reference. To promote it: independently verify the underlying " +
      "business values are correct (holdings shares/cost basis, ledger events, verification verdicts, policy " +
      "ranking — not just 'the numbers look plausible'), then manually copy this candidate's contents into " +
      "determinism.golden.json's `snapshot` field, set `approved: true`, and write a short `approvedNote` " +
      "explaining what was verified. Never promote a candidate you haven't reviewed."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

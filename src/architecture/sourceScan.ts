import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Plain-text source scanning, not module imports — deliberately. These
 * regression guards need to inspect files across every layer (application,
 * infrastructure) from one place, which importing them normally would
 * violate (.dependency-cruiser.cjs's layering rules) or simply couldn't do
 * (dependency-cruiser reasons about import graphs, never method-call sites
 * — "does this file call `.trades.save(...)`" has no import-graph
 * equivalent). Reading source as text and regex-matching is the same
 * technique this codebase's own "repo-wide architectural audit" used by
 * hand (see docs/ROADMAP.md) — this module makes that technique reusable
 * and permanent instead of a one-off manual pass.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface SourceFile {
  /** Repo-relative path, e.g. "application/services/TradeService.ts" (relative to src/). */
  path: string;
  content: string;
}

/** Every non-test .ts/.tsx file under `src`, excluding this module's own directory (a regression guard should never flag itself). */
export function allSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      if (relative(SRC_ROOT, full).startsWith("architecture" + sep)) continue;
      files.push({ path: relative(SRC_ROOT, full).split(sep).join("/"), content: readFileSync(full, "utf-8") });
    }
  }
  walk(SRC_ROOT);
  return files;
}

/** Files (by repo-relative path, deduplicated) whose content matches `pattern` at least once. */
export function filesMatching(files: SourceFile[], pattern: RegExp): string[] {
  const matches = new Set<string>();
  for (const f of files) {
    if (pattern.test(f.content)) matches.add(f.path);
  }
  return Array.from(matches).sort();
}

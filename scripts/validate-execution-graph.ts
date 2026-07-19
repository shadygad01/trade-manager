import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allSourceFiles, type SourceFile } from "../src/architecture/sourceScan";

/**
 * Graph Validator — checks that docs/EXECUTION_GRAPH.json still matches the
 * real repository instead of drifting into aspirational documentation.
 *
 * Deliberately reuses src/architecture/sourceScan.ts's plain-text file scan
 * (the same "read source as text, regex-match" technique regressionGuards.test.ts
 * already established as this codebase's house style for cross-layer source
 * inspection — see that module's own doc comment) rather than adding a second
 * file-walking implementation or a real TS/AST parser. This validator does
 * NOT re-implement what already exists elsewhere:
 *   - Layer boundaries (domain -> nothing, application -> domain only, etc.)
 *     are enforced by .dependency-cruiser.cjs (`npm run arch:check`) — not
 *     re-checked here, only cross-referenced (see "layer drift" below, which
 *     checks the GRAPH's own `layer` field against the file path, not the
 *     import graph dependency-cruiser already covers).
 *   - Frozen writer counts / singular-function assertions are enforced by
 *     src/architecture/regressionGuards.test.ts — not re-implemented here.
 *     This validator only checks that each node's `ciGuards` references still
 *     correspond to a real guard title in that file (so a renamed/removed
 *     guard doesn't leave a dangling, misleading citation in the graph).
 *
 * Usage: `npm run graph:check` (or `tsx scripts/validate-execution-graph.ts`).
 * Add `--json` to print the report as JSON instead of the human-readable form.
 * Exit code is 1 if there are any Errors, 0 otherwise (Warnings never fail CI
 * — see docs/EXECUTION_GRAPH.md's "Validator" section for the severity policy).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_PATH = path.join(REPO_ROOT, "docs/EXECUTION_GRAPH.json");
const REGRESSION_GUARDS_PATH = path.join(REPO_ROOT, "src/architecture/regressionGuards.test.ts");
const TSCONFIG_PATH = path.join(REPO_ROOT, "tsconfig.json");

interface Edge {
  id?: string;
  external?: string;
  via?: string;
  note?: string;
}

interface PublicInterface {
  file: string;
  kind: string;
  name: string;
}

interface GraphNode {
  id: string;
  name: string;
  layer: "domain" | "application" | "infrastructure" | "presentation";
  cluster: string;
  responsibility: string;
  filesOwned: string[];
  publicInterfaces: PublicInterface[];
  upstreamDependencies: Edge[];
  downstreamConsumers: Edge[];
  sharedState: string[];
  criticality: "critical" | "high" | "medium" | "low";
  criticalityRationale: string;
  requiredRegressionTests: {
    coLocatedUnitTests: string[];
    crossCuttingOrIntegrationTests: string[];
    ciRegressionGuards: string[];
  };
}

interface SharedHelperFile {
  path: string;
  note: string;
}

interface AcceptedCycle {
  nodes: string[];
  reason: string;
}

interface ExecutionGraph {
  ownershipScope: string[];
  sharedHelperFiles: SharedHelperFile[];
  acceptedCycles: AcceptedCycle[];
  criticalityCounts: Record<string, number>;
  nodeCount: number;
  nodes: GraphNode[];
}

interface Finding {
  category: string;
  node?: string;
  file?: string;
  message: string;
}

interface Report {
  errors: Finding[];
  warnings: Finding[];
  suggestions: Finding[];
}

function loadGraph(): ExecutionGraph {
  return JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
}

function loadTsconfigPaths(): Record<string, string> {
  const raw = readFileSync(TSCONFIG_PATH, "utf-8");
  // tsconfig.json has no comments in this repo, but strip a trailing-comma-free
  // JSON.parse failure risk is low; if it ever needs comment stripping, that's
  // a one-line addition here.
  const parsed = JSON.parse(raw);
  const paths: Record<string, string[]> = parsed.compilerOptions?.paths ?? {};
  const result: Record<string, string> = {};
  for (const [alias, targets] of Object.entries(paths)) {
    const prefix = alias.replace(/\/\*$/, "");
    const target = targets[0].replace(/\/\*$/, "");
    result[prefix] = target; // e.g. "@application" -> "src/application"
  }
  return result;
}

const IMPORT_RE = /^\s*(?:export\s+)?import\s+(?:type\s+)?(?:[\w*{},\s]+from\s+)?["']([^"']+)["']|^\s*export\s+(?:type\s+)?\{[^}]*\}\s+from\s+["']([^"']+)["']/gm;

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

/** Resolves an import specifier to a repo-relative file path (posix, src/... form), or null if it's a bare package import or can't be resolved to a real file. */
function resolveSpecifier(specifier: string, fromFileRelToRepo: string, tsPaths: Record<string, string>): string | null {
  let candidate: string;
  if (specifier.startsWith(".")) {
    const fromDir = path.posix.dirname(fromFileRelToRepo);
    candidate = path.posix.normalize(path.posix.join(fromDir, specifier));
  } else {
    const aliasHit = Object.keys(tsPaths).find((prefix) => specifier === prefix || specifier.startsWith(prefix + "/"));
    if (!aliasHit) return null; // bare package import (react, dexie, etc.) — not part of the graph
    candidate = specifier.replace(aliasHit, tsPaths[aliasHit]);
  }
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(path.join(REPO_ROOT, candidate + ext))) return candidate + ext;
  }
  if (existsSync(path.join(REPO_ROOT, candidate)) && /\.tsx?$/.test(candidate)) return candidate;
  return null;
}

const EXPORT_RE = /^export\s+(async\s+function|function|const|interface|type|class|abstract class)\s+([A-Za-z0-9_]+)/;

function extractExports(content: string): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(EXPORT_RE);
    if (m) out.push({ kind: /function$/.test(m[1]) ? "function" : m[1].trim(), name: m[2] });
  }
  return out;
}

/**
 * Tarjan's strongly-connected-components algorithm. Reports each cluster of
 * mutually-reachable nodes exactly once, as a sorted node-id list — not every
 * individual cycle path within it. A large SCC can contain combinatorially
 * many distinct cycle paths (rotations/sub-cycles of the same underlying
 * tangle); enumerating all of them is noise, not signal. Only SCCs with more
 * than one node represent a real circular dependency (a singleton is just a
 * node with no self-loop, which self-imports would already be excluded from
 * by the caller skipping self-edges).
 */
function findStronglyConnectedComponents(adjacency: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc.sort());
    }
  }

  for (const node of adjacency.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return sccs;
}

function normalizeWords(s: string): Set<string> {
    return new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 5)
    );
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const graph = loadGraph();
  const tsPaths = loadTsconfigPaths();
  const report: Report = { errors: [], warnings: [], suggestions: [] };
  const err = (f: Finding) => report.errors.push(f);
  const warn = (f: Finding) => report.warnings.push(f);
  const suggest = (f: Finding) => report.suggestions.push(f);

  // ---- Graph consistency validation ----
  const idCounts = new Map<string, number>();
  for (const n of graph.nodes) idCounts.set(n.id, (idCounts.get(n.id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) err({ category: "graph-consistency", node: id, message: `node id "${id}" appears ${count} times (must be unique)` });
  }
  if (graph.nodeCount !== graph.nodes.length) {
    err({ category: "graph-consistency", message: `top-level nodeCount (${graph.nodeCount}) does not match nodes.length (${graph.nodes.length})` });
  }
  const actualCriticalityCounts: Record<string, number> = {};
  for (const n of graph.nodes) actualCriticalityCounts[n.criticality] = (actualCriticalityCounts[n.criticality] ?? 0) + 1;
  for (const level of new Set([...Object.keys(graph.criticalityCounts), ...Object.keys(actualCriticalityCounts)])) {
    if (graph.criticalityCounts[level] !== actualCriticalityCounts[level]) {
      err({
        category: "graph-consistency",
        message: `criticalityCounts.${level} says ${graph.criticalityCounts[level] ?? 0}, actual count across nodes is ${actualCriticalityCounts[level] ?? 0}`,
      });
    }
  }

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    for (const edge of [...n.upstreamDependencies, ...n.downstreamConsumers]) {
      if (edge.id && !nodeIds.has(edge.id)) {
        err({ category: "graph-consistency", node: n.id, message: `edge references unknown node id "${edge.id}"` });
      }
      if (!edge.id && !edge.external) {
        err({ category: "graph-consistency", node: n.id, message: `edge has neither "id" nor "external" — malformed` });
      }
      if (edge.external && !edge.note) {
        warn({ category: "graph-consistency", node: n.id, message: `external edge "${edge.external}" has no "note" explaining why it isn't its own node` });
      }
    }
  }

  // mirror consistency: A.downstream includes B  <=>  B.upstream includes A
  for (const n of graph.nodes) {
    for (const edge of n.downstreamConsumers) {
      if (!edge.id) continue;
      const other = byId.get(edge.id)!;
      if (!other.upstreamDependencies.some((e) => e.id === n.id)) {
        warn({ category: "graph-consistency", node: n.id, message: `declares "${edge.id}" as a downstream consumer, but ${edge.id} does not list "${n.id}" as an upstream dependency` });
      }
    }
    for (const edge of n.upstreamDependencies) {
      if (!edge.id) continue;
      const other = byId.get(edge.id)!;
      if (!other.downstreamConsumers.some((e) => e.id === n.id)) {
        warn({ category: "graph-consistency", node: n.id, message: `declares "${edge.id}" as an upstream dependency, but ${edge.id} does not list "${n.id}" as a downstream consumer` });
      }
    }
  }

  // ---- Ownership validation + ownership conflicts ----
  const fileOwner = new Map<string, string>();
  for (const n of graph.nodes) {
    for (const f of n.filesOwned) {
      if (!existsSync(path.join(REPO_ROOT, f))) {
        err({ category: "ownership", node: n.id, file: f, message: `filesOwned entry does not exist on disk` });
        continue;
      }
      const prevOwner = fileOwner.get(f);
      if (prevOwner && prevOwner !== n.id) {
        err({ category: "ownership-conflict", file: f, message: `owned by both "${prevOwner}" and "${n.id}" — a file must belong to exactly one node` });
      } else {
        fileOwner.set(f, n.id);
      }
    }
  }
  const sharedHelperSet = new Set(graph.sharedHelperFiles.map((f) => f.path));
  for (const f of graph.sharedHelperFiles) {
    if (!existsSync(path.join(REPO_ROOT, f.path))) {
      err({ category: "ownership", file: f.path, message: `sharedHelperFiles entry does not exist on disk` });
    }
    if (fileOwner.has(f.path)) {
      err({ category: "ownership-conflict", file: f.path, message: `listed in sharedHelperFiles AND owned by node "${fileOwner.get(f.path)}" — pick one` });
    }
  }

  // ---- Architecture drift: node.layer vs. real file path ----
  const layerPrefix: Record<string, string> = { domain: "src/domain/", application: "src/application/", infrastructure: "src/infrastructure/", presentation: "src/presentation/" };
  for (const n of graph.nodes) {
    for (const f of n.filesOwned) {
      if (!f.startsWith(layerPrefix[n.layer])) {
        err({ category: "architecture-drift", node: n.id, file: f, message: `node's declared layer is "${n.layer}" but this file's path doesn't start with "${layerPrefix[n.layer]}"` });
      }
    }
  }

  // ---- Orphan file detection ----
  const allFiles: SourceFile[] = allSourceFiles();
  for (const scopeDir of graph.ownershipScope) {
    const scopeDirRelToSrc = scopeDir.replace(/^src\//, "");
    for (const f of allFiles) {
      if (!f.path.startsWith(scopeDirRelToSrc + "/") && f.path !== scopeDirRelToSrc) continue;
      const repoRelPath = "src/" + f.path;
      if (fileOwner.has(repoRelPath) || sharedHelperSet.has(repoRelPath)) continue;
      err({ category: "orphan-file", file: repoRelPath, message: `inside ownershipScope "${scopeDir}" but not claimed by any node's filesOwned or listed in sharedHelperFiles` });
      const dir = path.posix.dirname(repoRelPath);
      const neighborNode = [...fileOwner.entries()].find(([owned]) => path.posix.dirname(owned) === dir)?.[1];
      suggest({
        category: "orphan-file",
        file: repoRelPath,
        message: neighborNode
          ? `consider adding to node "${neighborNode}" (same directory as other files it owns), or to sharedHelperFiles if it's used by 2+ nodes`
          : `no sibling-owned file in the same directory to infer a node from — review manually`,
      });
    }
  }

  // ---- Public interface drift ----
  for (const n of graph.nodes) {
    for (const f of n.filesOwned) {
      const content = readFileSync(path.join(REPO_ROOT, f), "utf-8");
      const actualExports = extractExports(content);
      const declared = n.publicInterfaces.filter((pi) => pi.file === f);
      const actualNames = new Set(actualExports.map((e) => e.name));
      const declaredNames = new Set(declared.map((d) => d.name));
      for (const name of declaredNames) {
        if (!actualNames.has(name)) {
          err({ category: "interface-drift", node: n.id, file: f, message: `publicInterfaces claims export "${name}" but it no longer exists in this file` });
        }
      }
      for (const e of actualExports) {
        if (!declaredNames.has(e.name)) {
          warn({ category: "interface-drift", node: n.id, file: f, message: `exports "${e.name}" (${e.kind}) but it isn't listed in publicInterfaces` });
          suggest({ category: "interface-drift", node: n.id, file: f, message: `add {"file":"${f}","kind":"${e.kind}","name":"${e.name}"} to publicInterfaces` });
        }
      }
    }
  }

  // ---- Dependency validation + circular dependency detection ----
  function reportSCCs(sccs: string[][], source: string) {
    for (const scc of sccs) {
      const key = scc.join(",");
      const accepted = graph.acceptedCycles.find((c) => c.nodes.slice().sort().join(",") === key);
      if (accepted) {
        warn({ category: "circular-dependency", message: `known, accepted circular dependency among [${scc.join(", ")}] (${source}) — ${accepted.reason}` });
      } else {
        err({
          category: "circular-dependency",
          message: `NEW circular dependency among [${scc.join(", ")}] (${source}) — not in acceptedCycles. Either this is a genuine new architectural regression (fix the code) or a real, pre-existing mutual dependency the graph hasn't disclosed yet (add it to acceptedCycles with a reason, the same way regressionGuards.test.ts freezes known violations).`,
        });
      }
    }
  }

  const declaredAdjacency = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    declaredAdjacency.set(n.id, new Set(n.upstreamDependencies.filter((e) => e.id).map((e) => e.id!)));
  }
  reportSCCs(findStronglyConnectedComponents(declaredAdjacency), "declared upstream edges");

  const actualAdjacency = new Map<string, Set<string>>();
  for (const n of graph.nodes) actualAdjacency.set(n.id, new Set());
  const actualEdges = new Set<string>();
  for (const n of graph.nodes) {
    for (const f of n.filesOwned) {
      const content = readFileSync(path.join(REPO_ROOT, f), "utf-8");
      for (const spec of extractImportSpecifiers(content)) {
        const resolved = resolveSpecifier(spec, f, tsPaths);
        if (!resolved) continue;
        const targetNode = fileOwner.get(resolved);
        if (!targetNode || targetNode === n.id) continue;
        actualEdges.add(`${n.id}->${targetNode}`);
        actualAdjacency.get(n.id)!.add(targetNode);
      }
    }
  }
  for (const edgeKey of actualEdges) {
    const [from, to] = edgeKey.split("->");
    const fromNode = byId.get(from)!;
    const declared = fromNode.upstreamDependencies.some((e) => e.id === to);
    if (!declared) {
      warn({ category: "dependency-validation", node: from, message: `imports files owned by "${to}" but does not declare it as an upstream dependency` });
      suggest({ category: "dependency-validation", node: from, message: `add {"id":"${to}"} to "${from}".upstreamDependencies (and mirror it on "${to}".downstreamConsumers)` });
    }
  }
  for (const n of graph.nodes) {
    for (const edge of n.upstreamDependencies) {
      if (!edge.id) continue;
      if (!actualEdges.has(`${n.id}->${edge.id}`)) {
        warn({ category: "dependency-validation", node: n.id, message: `declares "${edge.id}" as an upstream dependency, but no current import from ${n.id}'s files reaches ${edge.id}'s files — possibly stale` });
      }
    }
  }
  reportSCCs(findStronglyConnectedComponents(actualAdjacency), "real imports");

  // ---- Architecture drift: ciRegressionGuards references still exist ----
  const guardsText = readFileSync(REGRESSION_GUARDS_PATH, "utf-8");
  const titleRe = /\b(?:it|describe)\(\s*"([^"]+)"/g;
  const guardTitles: string[] = [];
  let tm: RegExpExecArray | null;
  while ((tm = titleRe.exec(guardsText)) !== null) guardTitles.push(tm[1]);
  const guardTitleWords = guardTitles.map((t) => normalizeWords(t));
  for (const n of graph.nodes) {
    for (const guardDesc of n.requiredRegressionTests.ciRegressionGuards) {
      const descWords = normalizeWords(guardDesc);
      const matched = guardTitleWords.some((titleWords) => {
        let overlap = 0;
        for (const w of descWords) if (titleWords.has(w)) overlap++;
        return overlap >= 2;
      });
      if (!matched) {
        warn({
          category: "architecture-drift",
          node: n.id,
          message: `ciRegressionGuards entry "${guardDesc}" has no matching it()/describe() title in regressionGuards.test.ts (heuristic keyword match — verify by hand before treating this as confirmed drift)`,
        });
      }
    }
  }

  // ---- Report ----
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const line = (f: Finding) => `  [${f.category}]${f.node ? ` (${f.node})` : ""}${f.file ? ` ${f.file}` : ""}: ${f.message}`;
    console.log("# Execution Graph Validation Report\n");
    console.log(`Graph: ${GRAPH_PATH}`);
    console.log(`Nodes checked: ${graph.nodes.length}\n`);
    console.log(`## Errors (${report.errors.length})`);
    if (report.errors.length === 0) console.log("  (none)");
    for (const f of report.errors) console.log(line(f));
    console.log(`\n## Warnings (${report.warnings.length})`);
    if (report.warnings.length === 0) console.log("  (none)");
    for (const f of report.warnings) console.log(line(f));
    console.log(`\n## Suggested graph updates (${report.suggestions.length})`);
    if (report.suggestions.length === 0) console.log("  (none)");
    for (const f of report.suggestions) console.log(line(f));
    console.log(`\n${report.errors.length === 0 ? "PASS" : "FAIL"} — ${report.errors.length} error(s), ${report.warnings.length} warning(s), ${report.suggestions.length} suggestion(s).`);
  }

  process.exit(report.errors.length > 0 ? 1 : 0);
}

main();

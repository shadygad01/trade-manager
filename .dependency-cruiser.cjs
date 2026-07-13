/**
 * Machine-enforces the layering documented in docs/ARCHITECTURE.md:
 *   presentation -> application -> domain
 *   infrastructure -> domain
 * Dependencies only ever point inward. Until this file existed, that
 * boundary was convention + code review only — a stray import from
 * src/domain reaching into @presentation would have compiled and passed
 * every test. Run via `npm run lint` (see package.json).
 */
module.exports = {
  forbidden: [
    {
      name: "domain-no-outward-deps",
      comment: "domain must depend on nothing else in this app — it's the innermost layer.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/(application|infrastructure|presentation)" },
    },
    {
      name: "application-no-infrastructure-or-presentation",
      comment:
        "application is written entirely against domain's repository interfaces — it must never import a concrete infrastructure adapter or anything from presentation.",
      severity: "error",
      from: { path: "^src/application" },
      to: { path: "^src/(infrastructure|presentation)" },
    },
    {
      name: "infrastructure-no-presentation",
      comment: "infrastructure implements domain's ports — it must never depend on presentation.",
      severity: "error",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/presentation" },
    },
    {
      name: "only-repositories-and-purge-touch-db-directly",
      comment:
        "db.ts (the raw Dexie instance) may only be imported by its own repository adapters and purge.ts's disclosed, sanctioned bypass of the RawTransaction append-only contract (see purge.ts's own doc comment). Every other caller — including presentation — must go through a repository interface, never Dexie directly, or the RawTransactionRepository's structural no-update/no-delete guarantee (see docs/PORTFOLIO_OS_V2_SPEC.md Part 2.1) has a silent second door. Test files are exempted: several integration tests deliberately restart against the same on-disk Dexie database to prove real persistence, which is a legitimate, different use case from a production write path. determinismScenario.ts is exempted by explicit name, not by a broad pattern: it is test/tooling infrastructure ONLY (shared by determinism.e2e.test.ts and scripts/regenerate-determinism-golden.ts, zero production callers), needs a real Dexie 'Restart' the same way excelWorkflowEndToEnd.test.ts does, and is named/shaped so a reviewer immediately sees it isn't production code — adding a new exemption here should always be this deliberate, one file at a time.",
      severity: "error",
      from: {
        path: "^src",
        pathNot: [
          "^src/infrastructure/db/repositories",
          "^src/infrastructure/db/purge\\.ts$",
          "\\.test\\.tsx?$",
          "^src/presentation/pages/determinismScenario\\.ts$",
        ],
      },
      to: { path: "^src/infrastructure/db/db\\.ts$" },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};

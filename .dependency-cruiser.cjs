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

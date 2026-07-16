import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";

// GitHub Pages serves this app from a /trade-manager/ subpath; Cloudflare
// Workers serves it from the domain root (trade-manager.shady-gad-mb.workers.dev/).
// GH_PAGES_BUILD is set explicitly by deploy-pages.yml's build step only —
// every other build (local dev, `npm run build`, Cloudflare's own build
// pipeline, this repo's CI smoke-test build) defaults to root, which is what
// Cloudflare needs and is also the safe default for anything not GH Pages.
// The Cloudflare plugin's configureServer hook assumes a real dev/build Vite
// server and crashes inside Vitest's own Vite instance (process.env.VITEST is
// Vitest's documented signal for guarding plugins like this).
export default defineConfig({
  base: process.env.GH_PAGES_BUILD ? "/trade-manager/" : "/",
  plugins: [react(), tailwindcss(), ...(process.env.VITEST ? [] : [cloudflare()])],
  resolve: {
    alias: {
      "@domain": path.resolve(__dirname, "src/domain"),
      "@application": path.resolve(__dirname, "src/application"),
      "@infrastructure": path.resolve(__dirname, "src/infrastructure"),
      "@presentation": path.resolve(__dirname, "src/presentation"),
    },
  },
  test: {
    environment: "node",
    // Several integration suites intentionally exercise one shared fake
    // IndexedDB/runtime. Running files concurrently makes those suites race
    // each other's module-level state and fail nondeterministically despite
    // passing in isolation. Keep test files serial; individual tests and all
    // production workers remain unaffected.
    fileParallelism: false,
    setupFiles: ["./src/infrastructure/db/test-setup.ts", "./src/presentation/testUtils/setupTests.ts"],
  },
});

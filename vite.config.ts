import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";

// Served from https://shadygad01.github.io/trade-manager/ — base must match the repo name.
// The Cloudflare plugin's configureServer hook assumes a real dev/build Vite
// server and crashes inside Vitest's own Vite instance (process.env.VITEST is
// Vitest's documented signal for guarding plugins like this).
export default defineConfig({
  base: "/trade-manager/",
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
    setupFiles: ["./src/infrastructure/db/test-setup.ts", "./src/presentation/testUtils/setupTests.ts"],
  },
});
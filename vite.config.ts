import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Served from https://shadygad01.github.io/trade-manager/ — base must match the repo name.
export default defineConfig({
  base: "/trade-manager/",
  plugins: [react(), tailwindcss()],
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
    setupFiles: ["./src/infrastructure/db/test-setup.ts"],
  },
});

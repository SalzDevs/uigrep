import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@uigrep/schema": path.resolve(
        import.meta.dirname,
        "../packages/schema/src/index.ts",
      ),
    },
  },
});

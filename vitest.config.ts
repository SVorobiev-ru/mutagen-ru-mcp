import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**", "node_modules/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        "src/core/**": { lines: 90 },
        "src/budget/**": { lines: 90 },
        "src/cache/**": { lines: 90 },
        "src/mcp/**": { lines: 85 },
        "src/tables/**": { lines: 85 },
        "src/cli/**": { lines: 85 },
        "src/text/**": { lines: 90 },
        "src/scenarios/**": { lines: 85 },
      },
    },
  },
});

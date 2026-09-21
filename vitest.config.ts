import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // E2E suites intentionally exercise the same DATA_PATH bundle store.
    // Run files serially so one suite cannot observe another suite's temporary
    // bundle between its create/list/delete assertions.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    include: ["tests/**/*.spec.ts"],
    setupFiles: "./tests/e2e/setup.ts",
  },
});

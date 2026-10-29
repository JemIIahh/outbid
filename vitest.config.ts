import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fork tests each start their own anvil; keep them from fighting over ports.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["test/**/*.test.ts"],
  },
});

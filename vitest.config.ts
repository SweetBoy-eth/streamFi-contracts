import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["indexer/test/**/*.test.ts"],
    globals: false,
    environment: "node",
  },
});

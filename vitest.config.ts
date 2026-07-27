import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: true,
    maxWorkers: 8,
    pool: "forks",
  },
});

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    isolate: true,
    maxWorkers: 8,
    pool: "forks",
  },
});

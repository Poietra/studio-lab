import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
let fastManimRoot = resolve(workspaceRoot, "..", "fast-manim");
let update = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--update") {
    update = true;
    continue;
  }
  if (argument === "--fast-manim-root") {
    const value = process.argv[index + 1];
    if (!value) throw new Error("--fast-manim-root requires a path.");
    fastManimRoot = resolve(value);
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${argument}`);
}

const python = resolve(fastManimRoot, ".venv", "bin", "python");
if (!existsSync(python)) throw new Error(`Pinned fast-manim Python was not found at ${python}.`);

const completed = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "scripts/run-real-manim-census.real.test.ts", "--reporter=dot"],
  {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      POIETRA_FAST_MANIM_SNAPSHOT_COMMAND: JSON.stringify([python, "-m", "manim.renderer.source_runtime_identity"]),
      POIETRA_REAL_MANIM_CENSUS_FAST_MANIM_ROOT: fastManimRoot,
      ...(update ? { POIETRA_REAL_MANIM_CENSUS_UPDATE: "1" } : {}),
    },
    stdio: "inherit",
  },
);
if (completed.error) throw completed.error;
if (completed.status !== 0) {
  process.exitCode = completed.status ?? 1;
} else if (update) {
  const formatted = spawnSync(
    "pnpm",
    ["exec", "biome", "format", "--write", "fixtures/real-manim-census-v1/baseline.json"],
    { cwd: workspaceRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (formatted.error) throw formatted.error;
  process.exitCode = formatted.status ?? 1;
}

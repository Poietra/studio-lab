import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
let fastManimRoot = resolve(workspaceRoot, "..", "fast-manim");
let replaceCorpus = false;
let update = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--update") {
    update = true;
    continue;
  }
  if (argument === "--replace-corpus") {
    replaceCorpus = true;
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
if (replaceCorpus && !update) throw new Error("--replace-corpus requires --update.");

const python = resolve(fastManimRoot, ".venv", "bin", "python");

const completed = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "scripts/run-real-manim-census.real.test.ts", "--reporter=dot"],
  {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND: JSON.stringify([python, "-m", "manim.renderer.runtime_trace"]),
      POIETRA_FAST_MANIM_SNAPSHOT_COMMAND: JSON.stringify([python, "-m", "manim.renderer.source_runtime_identity"]),
      POIETRA_REAL_MANIM_CENSUS_FAST_MANIM_ROOT: fastManimRoot,
      POIETRA_REAL_MANIM_CENSUS_REPLACE_CORPUS: replaceCorpus ? "1" : "0",
      POIETRA_REAL_MANIM_CENSUS_UPDATE: update ? "1" : "0",
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

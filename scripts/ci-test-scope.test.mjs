import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function vitestScope(scriptName) {
  const tokens = packageJson.scripts[scriptName]?.trim().split(/\s+/u) ?? [];
  assert.deepEqual(tokens.slice(0, 2), ["vitest", "run"], `${scriptName} must remain a direct Vitest run command`);

  const filters = [];
  const excludes = [];
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--exclude") {
      excludes.push(tokens[index + 1]);
      index += 1;
    } else if (!token.startsWith("-")) {
      filters.push(token);
    }
  }
  return { excludes, filters };
}

function selectedByScope(path, { excludes, filters }) {
  const selected = filters.some((filter) => path === filter || path.startsWith(`${filter}/`));
  return selected && !excludes.some((exclude) => path === exclude);
}

test("every deterministic Vitest file belongs to a regular CI suite", () => {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const vitestFiles = trackedFiles.filter((path) => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path));
  const regularScopes = [vitestScope("test:unit"), vitestScope("test:integration")];
  const separatelyOwned = new Set([
    // These run in the dependency-free Select CI lanes job.
    "scripts/ci-change-scope.test.mjs",
    "scripts/ci-test-scope.test.mjs",
    // These require external, pinned Manim repositories and remain manual.
    "scripts/run-real-manim-census.real.test.ts",
    "scripts/run-real-manim-project-census.real.test.ts",
  ]);

  const unassigned = vitestFiles.filter(
    (path) => !separatelyOwned.has(path) && !regularScopes.some((scope) => selectedByScope(path, scope)),
  );
  assert.deepEqual(unassigned, []);
});

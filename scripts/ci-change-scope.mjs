import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const scopeNames = ["engine_core", "engine_wasm", "web", "tests", "storage", "browser", "electron", "tauri"];

function emptyScopes() {
  return Object.fromEntries(scopeNames.map((name) => [name, false]));
}

function allScopes() {
  return Object.fromEntries(scopeNames.map((name) => [name, true]));
}

function enable(scopes, ...names) {
  for (const name of names) scopes[name] = true;
}

function isDocumentation(path) {
  return path === "README.md" || path.startsWith("docs/") || path.endsWith(".md");
}

function isGlobalConfiguration(path) {
  return (
    path.startsWith(".github/") ||
    path === ".npmrc" ||
    path === "biome.json" ||
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path === "rust-toolchain.toml" ||
    path === "tsconfig.json" ||
    path.startsWith("playwright.") ||
    path.startsWith("vite.") ||
    path.startsWith("wrangler.")
  );
}

export function classifyChangedPaths(paths) {
  const scopes = emptyScopes();

  for (const rawPath of paths) {
    const path = rawPath.replaceAll("\\", "/");
    if (!path || isDocumentation(path)) continue;
    if (isGlobalConfiguration(path)) return allScopes();

    if (path.startsWith("src-tauri/")) {
      enable(scopes, "tauri");
      continue;
    }

    if (path.startsWith("engine/") || path.startsWith("fixtures/engine-v1/")) {
      enable(scopes, "engine_core", "engine_wasm", "web", "tests", "browser");
      continue;
    }

    if (
      path.startsWith("electron/") ||
      path.startsWith("scripts/electron-") ||
      path === "scripts/package-electron.mjs"
    ) {
      enable(scopes, "engine_wasm", "web", "browser", "electron");
      continue;
    }

    if (path.startsWith("src/") || path.startsWith("server/") || path.startsWith("e2e/")) {
      enable(scopes, "engine_wasm", "web", "tests", "browser");
      if (path.startsWith("server/storage/") || path.includes("storage-e2e")) enable(scopes, "storage");
      continue;
    }

    if (path.startsWith("public/") || path === "index.html") {
      enable(scopes, "engine_wasm", "web", "browser");
      continue;
    }

    if (
      path.startsWith("scripts/build-engine-wasm") ||
      path.startsWith("scripts/smoke-engine-wasm") ||
      path.startsWith("scripts/smoke-mathtex-") ||
      path.startsWith("scripts/measure-mathtex-wasm")
    ) {
      enable(scopes, "engine_core", "engine_wasm", "web", "tests", "browser");
      continue;
    }

    if (path.startsWith("scripts/")) return allScopes();

    // Unknown non-documentation files are treated conservatively.
    return allScopes();
  }

  return scopes;
}

function changedPaths(baseSha, headSha) {
  if (!baseSha || !headSha || /^0+$/.test(baseSha)) return null;
  const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", "-z", baseSha, headSha], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  return result.stdout.split("\0").filter(Boolean);
}

function writeOutputs(scopes, paths) {
  const outputPath = process.env.GITHUB_OUTPUT;
  for (const [name, enabled] of Object.entries(scopes)) {
    const line = `${name}=${enabled}\n`;
    if (outputPath) appendFileSync(outputPath, line);
    else process.stdout.write(line);
  }
  process.stdout.write(`Changed files: ${paths?.length ?? "all (no comparable base)"}\n`);
  if (paths?.length) process.stdout.write(`${paths.join("\n")}\n`);
}

function main() {
  const forceAll = process.env.POIETRA_CI_FORCE_ALL === "true";
  const paths = forceAll ? null : changedPaths(process.env.POIETRA_CI_BASE_SHA, process.env.POIETRA_CI_HEAD_SHA);
  writeOutputs(paths === null ? allScopes() : classifyChangedPaths(paths), paths);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

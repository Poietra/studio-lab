import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const scopeNames = [
  "account_browser",
  "browser",
  "code",
  "electron",
  "engine_core",
  "engine_wasm",
  "render_parity",
  "storage",
  "tauri",
  "tests",
  "web",
];

function emptyScopes() {
  return Object.fromEntries(scopeNames.map((name) => [name, false]));
}

function allScopes() {
  return Object.fromEntries(scopeNames.map((name) => [name, true]));
}

function enable(scopes, ...names) {
  for (const name of names) scopes[name] = true;
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
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

function isAccountBrowserPath(path) {
  return (
    path === "src/app.tsx" ||
    path.startsWith("src/accounts/") ||
    path.startsWith("src/billing/") ||
    path.startsWith("src/collaboration/") ||
    /^src\/studio\/(?:editor-collaboration-mutation|editor-mutation-pending-journal|editor-session-|use-editor-document-authority)/u.test(
      path,
    ) ||
    path.startsWith("server/accounts/") ||
    path.startsWith("server/billing/") ||
    path.startsWith("server/collaboration/") ||
    path.startsWith("server/storage/postgres/") ||
    path === "server/manim-api.ts" ||
    path === "server/manim-production-server.ts" ||
    path === "server/manim-render-http.ts" ||
    /^server\/(?:account-|billing-|cloudflare-account-|cloudflare-billing-|cloudflare-editor-collaboration-|editor-collaboration-|editor-document-|editor-project-room-)/u.test(
      path,
    ) ||
    /^e2e\/(?:account-|editor-cloud-session|editor-document-postgres-fixture)/u.test(path)
  );
}

function isRenderParityPath(path) {
  return (
    path.startsWith("engine/") ||
    path.startsWith("fixtures/engine-v1/") ||
    path === "src/app.tsx" ||
    path.startsWith("src/engine/") ||
    path.startsWith("src/render-pipeline/") ||
    path.startsWith("src/studio/") ||
    /^server\/(?:durable-fast-manim-|durable-manim-render-|fast-manim-|manim-render-|production-durable-manim-)/u.test(
      path,
    ) ||
    /^e2e\/(?:camera-focus|engine-|group-visibility|native-project-reload|persistent-dynamic-preview|preview-renderer|real-|shape-transform|visual-parity)/u.test(
      path,
    ) ||
    path.startsWith("scripts/build-engine-wasm") ||
    path.startsWith("scripts/measure-mathtex-wasm") ||
    path.startsWith("scripts/smoke-engine-wasm") ||
    path.startsWith("scripts/smoke-mathtex-")
  );
}

export function classifyChangedPaths(paths) {
  const scopes = emptyScopes();

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (!path || isDocumentation(path)) continue;
    scopes.code = true;
    if (isGlobalConfiguration(path)) return allScopes();

    if (path.startsWith("src-tauri/")) {
      enable(scopes, "tauri");
      continue;
    }

    if (path.startsWith("engine/") || path.startsWith("fixtures/engine-v1/")) {
      enable(scopes, "engine_core", "engine_wasm", "web", "tests", "browser", "render_parity");
      continue;
    }

    if (
      path.startsWith("electron/") ||
      path.startsWith("scripts/electron-") ||
      path === "scripts/package-electron.mjs"
    ) {
      enable(scopes, "engine_wasm", "web", "tests", "browser", "electron");
      continue;
    }

    if (path.startsWith("src/") || path.startsWith("server/") || path.startsWith("e2e/")) {
      enable(scopes, "engine_wasm", "web", "tests", "browser");
      if (path.startsWith("server/storage/") || path.includes("storage-e2e")) enable(scopes, "storage");
      if (isAccountBrowserPath(path)) enable(scopes, "account_browser");
      if (isRenderParityPath(path)) enable(scopes, "render_parity");
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
      enable(scopes, "engine_core", "engine_wasm", "web", "tests", "browser", "render_parity");
      continue;
    }

    if (path.startsWith("scripts/")) return allScopes();

    // Unknown non-documentation files are treated conservatively.
    return allScopes();
  }

  return scopes;
}

export function selectScopes(paths, { forceAll = false, fullForCode = false } = {}) {
  if (forceAll || paths === null) return allScopes();
  if (
    fullForCode &&
    paths.some((rawPath) => {
      const path = normalizePath(rawPath);
      return path && !isDocumentation(path);
    })
  ) {
    // Main still runs the regular compatibility matrix for every code change,
    // while production-account and render-parity suites remain change-scoped.
    const pathScopes = classifyChangedPaths(paths);
    return {
      ...allScopes(),
      account_browser: pathScopes.account_browser,
      render_parity: pathScopes.render_parity,
    };
  }
  return classifyChangedPaths(paths);
}

export function changedPaths(baseSha, headSha, cwd) {
  if (!baseSha || !headSha || /^0+$/.test(baseSha)) return null;
  const result = spawnSync("git", ["diff", "--name-only", "-z", baseSha, headSha], { cwd, encoding: "utf8" });
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
  writeOutputs(
    selectScopes(paths, {
      forceAll,
      fullForCode: process.env.POIETRA_CI_FULL_FOR_CODE === "true",
    }),
    paths,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

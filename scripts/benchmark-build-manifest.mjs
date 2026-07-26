import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build manifest for the served benchmark executable set.
 *
 * Generated at build time and stamped with the commit identity, so the
 * benchmark harness can verify — over HTTP, before and after measurement —
 * that every byte it exercised (host page, entry chunk, canvas client chunk,
 * Worker chunk, wasm-bindgen JS, WASM binary) came from exactly this build of
 * exactly this commit. A stale or swapped dist is rejected, not measured.
 */
export const BENCHMARK_BUILD_MANIFEST_FILENAME = "benchmark-build-manifest.json";
export const BENCHMARK_BUILD_MANIFEST_SCHEMA = "poietra.benchmark-build-manifest";
export const BENCHMARK_BUILD_MANIFEST_VERSION = 1;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Relative paths of the benchmark executable set: the host page, every JS
 * chunk, and the wasm-bindgen JS/WASM pair. Non-executable served assets are
 * deliberately not part of the manifest.
 */
export function collectBenchmarkFilePaths(distDir) {
  const paths = ["benchmark.html"];
  for (const entry of readdirSync(join(distDir, "assets"))) {
    if (entry.endsWith(".js")) paths.push(`assets/${entry}`);
  }
  for (const entry of readdirSync(join(distDir, "engine-wasm"))) {
    if (entry.endsWith(".js") || entry.endsWith(".wasm")) paths.push(`engine-wasm/${entry}`);
  }
  return paths.sort();
}

export function makeBenchmarkBuildManifest(distDir, identity) {
  const files = collectBenchmarkFilePaths(distDir).map((path) => {
    const bytes = readFileSync(join(distDir, path));
    return { byteLength: bytes.byteLength, path, sha256: sha256(bytes) };
  });
  return {
    commit: identity.commit,
    files,
    generatedAtEpochMs: Date.now(),
    schema: BENCHMARK_BUILD_MANIFEST_SCHEMA,
    treeState: identity.treeState,
    version: BENCHMARK_BUILD_MANIFEST_VERSION,
  };
}

export function writeBenchmarkBuildManifest(distDir) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  const manifest = makeBenchmarkBuildManifest(distDir, { commit, treeState: dirty ? "dirty" : "clean" });
  writeFileSync(join(distDir, BENCHMARK_BUILD_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

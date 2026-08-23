import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const buildScript = fileURLToPath(new URL("build-engine-wasm.mjs", import.meta.url));
const canvasSmokeScript = fileURLToPath(new URL("smoke-engine-wasm.mjs", import.meta.url));

const canvasArtifacts = ["public/engine-wasm/poietra_wasm.js", "public/engine-wasm/poietra_wasm_bg.wasm"];
const mathTexArtifacts = [
  "public/engine-wasm/mathtex-outline/poietra_mathtex_wasm.js",
  "public/engine-wasm/mathtex-outline/poietra_mathtex_wasm_bg.wasm",
];
const canvasSources = [
  "engine/Cargo.lock",
  "engine/Cargo.toml",
  ...[
    "poietra-eval",
    "poietra-export-mux",
    "poietra-geometry",
    "poietra-render-wgpu",
    "poietra-scene-ir",
    "poietra-wasm",
  ].flatMap((crate) => [`engine/crates/${crate}/Cargo.toml`, `engine/crates/${crate}/src`]),
];

function repositoryPath(path) {
  return fileURLToPath(new URL(path, new URL("../", import.meta.url)));
}

function hasEveryArtifact(paths) {
  return paths.every((path) => existsSync(repositoryPath(path)));
}

function newestModifiedTime(path) {
  const absolutePath = repositoryPath(path);
  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return readdirSync(absolutePath, { withFileTypes: true }).reduce(
    (latest, entry) => Math.max(latest, newestModifiedTime(`${path}/${entry.name}`)),
    stats.mtimeMs,
  );
}

function canvasArtifactIsFresh() {
  const oldestArtifact = Math.min(...canvasArtifacts.map((path) => statSync(repositoryPath(path)).mtimeMs));
  return canvasSources.every((path) => newestModifiedTime(path) <= oldestArtifact);
}

function canvasArtifactIsCurrent() {
  if (!hasEveryArtifact(canvasArtifacts) || !canvasArtifactIsFresh()) return false;
  try {
    execFileSync(process.execPath, [canvasSmokeScript], { cwd: repositoryRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasCanvas = canvasArtifactIsCurrent();
const hasMathTex = hasEveryArtifact(mathTexArtifacts);

if (!hasCanvas || !hasMathTex) {
  const target = hasCanvas ? "mathtex" : hasMathTex ? "canvas" : "all";
  console.log(`[poietra-dev] Building missing ${target} WebAssembly artifacts before starting Studio.`);
  execFileSync(process.execPath, [buildScript, target], { cwd: repositoryRoot, stdio: "inherit" });
}

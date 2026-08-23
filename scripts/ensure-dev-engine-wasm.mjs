import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const buildScript = fileURLToPath(new URL("build-engine-wasm.mjs", import.meta.url));

const canvasArtifacts = ["public/engine-wasm/poietra_wasm.js", "public/engine-wasm/poietra_wasm_bg.wasm"];
const mathTexArtifacts = [
  "public/engine-wasm/mathtex-outline/poietra_mathtex_wasm.js",
  "public/engine-wasm/mathtex-outline/poietra_mathtex_wasm_bg.wasm",
];

function hasEveryArtifact(paths) {
  return paths.every((path) => existsSync(fileURLToPath(new URL(path, new URL("../", import.meta.url)))));
}

const hasCanvas = hasEveryArtifact(canvasArtifacts);
const hasMathTex = hasEveryArtifact(mathTexArtifacts);

if (!hasCanvas || !hasMathTex) {
  const target = hasCanvas ? "mathtex" : hasMathTex ? "canvas" : "all";
  console.log(`[poietra-dev] Building missing ${target} WebAssembly artifacts before starting Studio.`);
  execFileSync(process.execPath, [buildScript, target], { cwd: repositoryRoot, stdio: "inherit" });
}

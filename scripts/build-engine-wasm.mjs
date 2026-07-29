import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const expectedVersion = "wasm-pack 0.15.0";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

let installedVersion;
try {
  installedVersion = execFileSync("wasm-pack", ["--version"], { encoding: "utf8" }).trim();
} catch {
  console.error(`Install ${expectedVersion} with: cargo install wasm-pack --locked --version 0.15.0`);
  process.exit(1);
}

if (installedVersion !== expectedVersion) {
  console.error(`Expected ${expectedVersion}, received ${installedVersion}.`);
  process.exit(1);
}

function buildWasmPackage(cratePath, outDir, outName, profileArgs) {
  execFileSync(
    "wasm-pack",
    ["build", cratePath, "--target", "web", ...profileArgs, "--out-dir", outDir, "--out-name", outName],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
}

buildWasmPackage("engine/crates/poietra-wasm", "../../../public/engine-wasm", "poietra_wasm", ["--release"]);
buildWasmPackage(
  "engine/crates/poietra-mathtex-wasm",
  "../../../public/engine-wasm/mathtex-outline",
  "poietra_mathtex_wasm",
  ["--profile", "mathtex-wasm-size"],
);

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

execFileSync(
  "wasm-pack",
  [
    "build",
    "engine/crates/poietra-wasm",
    "--target",
    "web",
    "--release",
    "--out-dir",
    "../../../public/engine-wasm",
    "--out-name",
    "poietra_wasm",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const engineRoot = resolve(repositoryRoot, "engine");
const build = spawnSync(
  "cargo",
  ["build", "--locked", "--package", "poietra-mathtex-py", "--manifest-path", "Cargo.toml"],
  { cwd: engineRoot, encoding: "utf8" },
);
if (build.status !== 0) {
  process.stderr.write(build.stdout ?? "");
  process.stderr.write(build.stderr ?? "");
  process.exit(build.status ?? 1);
}
const metadata = spawnSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--no-deps", "--manifest-path", "Cargo.toml"],
  { cwd: engineRoot, encoding: "utf8" },
);
if (metadata.status !== 0) {
  process.stderr.write(metadata.stdout ?? "");
  process.stderr.write(metadata.stderr ?? "");
  process.exit(metadata.status ?? 1);
}
const targetDirectory = JSON.parse(metadata.stdout).target_directory;
if (typeof targetDirectory !== "string" || targetDirectory.length === 0) {
  throw new Error("Cargo metadata did not expose the MathTex Python build target directory.");
}

const sourceName =
  process.platform === "win32"
    ? "poietra_mathtex_outline.dll"
    : process.platform === "darwin"
      ? "libpoietra_mathtex_outline.dylib"
      : "libpoietra_mathtex_outline.so";
const moduleName = process.platform === "win32" ? "poietra_mathtex_outline.pyd" : "poietra_mathtex_outline.so";
const fixtureRoot = await mkdtemp(join(tmpdir(), "poietra-mathtex-python-"));

try {
  await copyFile(resolve(targetDirectory, "debug", sourceName), join(fixtureRoot, moduleName));
  const pythonSource = String.raw`
import json
import poietra_mathtex_outline

assert poietra_mathtex_outline.abi_version() == 1
compiled_bytes = poietra_mathtex_outline.compile_mathtex_outline_v1(["E = mc^2"])
assert isinstance(compiled_bytes, bytes)
compiled = json.loads(compiled_bytes)
assert compiled["schema"] == "poietra.mathtex-outline-response"
assert compiled["version"] == 1
assert compiled["result"]["kind"] == "compiled"
assert compiled["result"]["fillRule"] == "nonzero"
assert len(compiled["result"]["path"]["subpaths"]) > 1

unsupported = json.loads(poietra_mathtex_outline.compile_mathtex_outline_v1([r"\frac{1}{2}"]))
assert unsupported["result"]["kind"] == "unsupported"
assert unsupported["result"]["code"] == "syntax-unsupported"
print(json.dumps({"abiVersion": 1, "compiledSubpaths": len(compiled["result"]["path"]["subpaths"])}))
`;
  const python = spawnSync(process.env.PYTHON ?? "python3", ["-c", pythonSource], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: fixtureRoot },
  });
  if (python.status !== 0) {
    process.stderr.write(python.stdout ?? "");
    process.stderr.write(python.stderr ?? "");
    process.exit(python.status ?? 1);
  }
  const evidence = JSON.parse(python.stdout);
  assert.equal(evidence.abiVersion, 1);
  assert.ok(evidence.compiledSubpaths > 1);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}

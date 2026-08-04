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
assert poietra_mathtex_outline.segmented_abi_version() == 1
compiled_bytes = poietra_mathtex_outline.compile_mathtex_outline_v1(["E = mc^2"])
assert isinstance(compiled_bytes, bytes)
compiled = json.loads(compiled_bytes)
assert compiled["schema"] == "poietra.mathtex-outline-response"
assert compiled["version"] == 1
assert compiled["result"]["kind"] == "compiled"
assert compiled["result"]["fillRule"] == "nonzero"
assert len(compiled["result"]["path"]["subpaths"]) > 1

fraction = json.loads(poietra_mathtex_outline.compile_mathtex_outline_v1([r"\frac{1}{2}"]))
assert fraction["result"]["kind"] == "compiled"
unsupported = json.loads(poietra_mathtex_outline.compile_mathtex_outline_v1([]))
assert unsupported["result"]["kind"] == "unsupported"
assert unsupported["result"]["code"] == "invalid-request"

def segmented(request):
    return json.loads(poietra_mathtex_outline.compile_segmented_tex_outline_v1(
        json.dumps(request, separators=(",", ":")).encode("utf-8")
    ))

segmented_text = segmented({
    "schema": "poietra.segmented-tex-outline-request",
    "version": 1,
    "mode": "tex-text",
    "sourceKind": "literal",
    "source": "This is a some text",
    "paintMatches": [{
        "literal": "text",
        "paint": {"red": 1, "green": 1, "blue": 0, "alpha": 1},
    }],
})
assert segmented_text["result"]["kind"] == "compiled"
assert len(segmented_text["result"]["fragments"]) == 15
assert [
    fragment["order"]
    for fragment in segmented_text["result"]["fragments"]
    if fragment["paint"]["blue"] == 0
] == [11, 12, 13, 14]

segmented_math = segmented({
    "schema": "poietra.segmented-tex-outline-request",
    "version": 1,
    "mode": "mathtex-math",
    "sourceKind": "literal",
    "source": r"\sum_{k=1}^\infty {1 \over k^2} = {\pi^2 \over 6}",
    "paintMatches": [],
})
assert segmented_math["result"]["kind"] == "compiled"
assert len(segmented_math["result"]["fragments"]) == 14
assert sum(fragment["kind"] == "rule" for fragment in segmented_math["result"]["fragments"]) == 2

dynamic = segmented({
    "schema": "poietra.segmented-tex-outline-request",
    "version": 1,
    "mode": "tex-text",
    "sourceKind": "dynamic",
    "source": "make_text()",
    "paintMatches": [],
})
assert dynamic["result"]["kind"] == "unsupported"
assert dynamic["result"]["code"] == "dynamic-source-unsupported"
print(json.dumps({
    "abiVersion": 1,
    "compiledSubpaths": len(compiled["result"]["path"]["subpaths"]),
    "fractionSubpaths": len(fraction["result"]["path"]["subpaths"]),
    "segmentedFormulaFragments": len(segmented_math["result"]["fragments"]),
    "segmentedTextFragments": len(segmented_text["result"]["fragments"]),
}))
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
  assert.ok(evidence.fractionSubpaths > 1);
  assert.equal(evidence.segmentedFormulaFragments, 14);
  assert.equal(evidence.segmentedTextFragments, 15);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}

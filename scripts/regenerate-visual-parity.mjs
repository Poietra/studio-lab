import { execFileSync } from "node:child_process";
import { accessSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const nativeArtifactRoot = resolve(
  process.env.POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR ?? "test-results/visual-parity/native",
);
const outputRoot = resolve(process.env.POIETRA_VISUAL_PARITY_OUTPUT_DIR ?? "test-results/visual-parity/output");
const corpus = JSON.parse(readFileSync(resolve("fixtures/visual-parity-v1/corpus.json"), "utf8"));
const entryIdPattern = /^[a-z0-9-]+--[a-z0-9-]+$/;
if (corpus.schema !== "poietra.visual-parity-corpus" || corpus.version !== 1 || !Array.isArray(corpus.entries)) {
  throw new Error("The visual parity corpus must use the v1 envelope.");
}
for (const entry of corpus.entries) {
  if (typeof entry.id !== "string" || !entryIdPattern.test(entry.id)) {
    throw new Error("Every visual parity corpus entry must have one safe artifact ID.");
  }
}
const nativeTestByEntryId = new Map([
  ["dynamic-affine-camera--a-first", "renders_dynamic_affine_camera_samples_with_fallback_adapter"],
  ["png-alpha-edge-camera--midpoint", "renders_png_alpha_edge_camera_midpoint_with_fallback_adapter"],
  ["mathtex-nested-radical-fraction--static", "renders_mathtex_nested_radical_fraction_with_fallback_adapter"],
  ["generic-stroke-topology--sample", "renders_shared_generic_stroke_fixture_with_fallback_adapter"],
  ["real-mathtex-morph-v5--a-initial", "renders_real_mathtex_morph_v5_samples_with_fallback_adapter"],
  ["real-mathtex-morph-v5--outbound-midpoint", "renders_real_mathtex_morph_v5_samples_with_fallback_adapter"],
  ["real-mathtex-morph-v5--maxwell-hold", "renders_real_mathtex_morph_v5_samples_with_fallback_adapter"],
  ["real-mathtex-morph-v5--return-midpoint", "renders_real_mathtex_morph_v5_samples_with_fallback_adapter"],
  ["real-mathtex-morph-v5--a-restored", "renders_real_mathtex_morph_v5_samples_with_fallback_adapter"],
  ["real-generic-vmobject-v6--static", "renders_real_generic_vmobject_v6_static_with_fallback_adapter"],
  ["real-square-to-circle-v8--create-midpoint", "renders_real_square_to_circle_v8_samples_with_fallback_adapter"],
  ["real-square-to-circle-v8--square", "renders_real_square_to_circle_v8_samples_with_fallback_adapter"],
  ["real-square-to-circle-v8--analytic-winding-root", "renders_real_square_to_circle_v8_samples_with_fallback_adapter"],
  ["real-square-to-circle-v8--circle", "renders_real_square_to_circle_v8_samples_with_fallback_adapter"],
  ["real-square-to-circle-v8--fade-midpoint", "renders_real_square_to_circle_v8_samples_with_fallback_adapter"],
  ["real-warp-square-v9--source", "renders_real_warp_square_v9_samples_with_fallback_adapter"],
  ["real-warp-square-v9--quarter", "renders_real_warp_square_v9_samples_with_fallback_adapter"],
  ["real-warp-square-v9--midpoint", "renders_real_warp_square_v9_samples_with_fallback_adapter"],
  ["real-warp-square-v9--target", "renders_real_warp_square_v9_samples_with_fallback_adapter"],
  ["real-warp-square-v9--hold", "renders_real_warp_square_v9_samples_with_fallback_adapter"],
  ["real-line-joints-v10--static", "renders_real_line_joints_v10_static_with_fallback_adapter"],
]);
const expectedArtifactIds = corpus.entries.map(({ id }) => id).sort();
const configuredArtifactIds = [...nativeTestByEntryId.keys()].sort();
if (JSON.stringify(configuredArtifactIds) !== JSON.stringify(expectedArtifactIds)) {
  throw new Error(
    `Native visual parity producers must exactly match the corpus: expected ${expectedArtifactIds.join(", ")}; configured ${configuredArtifactIds.join(", ")}`,
  );
}

function removeGeneratedEntryDirectories(root, markerFile, expectedSchema, markerEntryId) {
  if (!existsSync(root)) return;
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || !entryIdPattern.test(directory.name)) continue;
    const markerPath = resolve(root, directory.name, markerFile);
    if (!existsSync(markerPath)) continue;
    let marker;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
      continue;
    }
    if (marker.schema === expectedSchema && markerEntryId(marker) === directory.name) {
      rmSync(resolve(root, directory.name), { force: true, recursive: true });
    }
  }
}

removeGeneratedEntryDirectories(
  nativeArtifactRoot,
  "metadata.json",
  "poietra.visual-parity-native-artifact",
  (marker) => marker.corpusEntryId,
);
removeGeneratedEntryDirectories(outputRoot, "report.json", "poietra.visual-parity-report", (marker) =>
  marker.corpus ? marker.corpus.entryId : undefined,
);
for (const entry of corpus.entries) {
  rmSync(resolve(nativeArtifactRoot, entry.id), { force: true, recursive: true });
  rmSync(resolve(outputRoot, entry.id), { force: true, recursive: true });
}
const environment = {
  ...process.env,
  POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR: nativeArtifactRoot,
  POIETRA_VISUAL_PARITY_OUTPUT_DIR: outputRoot,
  WGPU_BACKEND: process.env.WGPU_BACKEND ?? "vulkan",
};

const nativeTests = corpus.entries.map((entry) => {
  const nativeTest = nativeTestByEntryId.get(entry.id);
  if (!nativeTest) throw new Error(`Missing native visual parity producer for ${entry.id}.`);
  return nativeTest;
});
for (const nativeTest of new Set(nativeTests)) {
  execFileSync(
    cargo,
    [
      "+1.92.0",
      "test",
      "--locked",
      "--package",
      "poietra-render-wgpu",
      "--test",
      "headless_gpu",
      "--manifest-path",
      "engine/Cargo.toml",
      nativeTest,
      "--",
      "--exact",
      "--ignored",
      "--nocapture",
    ],
    { env: environment, stdio: "inherit" },
  );
}
const producedArtifactIds = readdirSync(nativeArtifactRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(producedArtifactIds) !== JSON.stringify(expectedArtifactIds)) {
  throw new Error(
    `Native visual parity artifacts must exactly match the corpus: expected ${expectedArtifactIds.join(", ")}; received ${producedArtifactIds.join(", ")}`,
  );
}
for (const entry of corpus.entries) {
  const entryDirectory = resolve(nativeArtifactRoot, entry.id);
  accessSync(resolve(entryDirectory, "metadata.json"));
  accessSync(resolve(entryDirectory, "expected.rgba"));
}
execFileSync(pnpm, ["build:canvas:wasm"], { env: environment, stdio: "inherit" });
execFileSync(pnpm, ["exec", "playwright", "test", "--config", "playwright.visual-parity.config.ts"], {
  env: environment,
  stdio: "inherit",
});

console.log(`visual parity artifacts: ${outputRoot}`);

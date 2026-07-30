import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const nativeArtifactRoot = resolve(
  process.env.POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR ?? "test-results/visual-parity/native",
);
const outputRoot = resolve(process.env.POIETRA_VISUAL_PARITY_OUTPUT_DIR ?? "test-results/visual-parity/output");
const environment = {
  ...process.env,
  POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR: nativeArtifactRoot,
  POIETRA_VISUAL_PARITY_OUTPUT_DIR: outputRoot,
  WGPU_BACKEND: process.env.WGPU_BACKEND ?? "vulkan",
};

for (const nativeTest of [
  "renders_dynamic_affine_camera_samples_with_fallback_adapter",
  "renders_png_alpha_edge_camera_midpoint_with_fallback_adapter",
]) {
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
execFileSync(pnpm, ["build:canvas:wasm"], { env: environment, stdio: "inherit" });
execFileSync(pnpm, ["exec", "playwright", "test", "--config", "playwright.visual-parity.config.ts"], {
  env: environment,
  stdio: "inherit",
});

console.log(`visual parity artifacts: ${outputRoot}`);

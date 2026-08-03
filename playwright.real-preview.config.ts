import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";
import { encodeRgbaPngV1 } from "./e2e/png-rgba";
import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./e2e/webgpu-launch";

const producerCommand = process.env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND?.trim();
if (!producerCommand) {
  throw new Error(
    "POIETRA_FAST_MANIM_SNAPSHOT_COMMAND must name the real fast-manim snapshot producer as a command or JSON argv array.",
  );
}
const snapshotProfile = process.env.POIETRA_E2E_REAL_PREVIEW_PROFILE?.trim() || "2";
if (
  snapshotProfile !== "2" &&
  snapshotProfile !== "3" &&
  snapshotProfile !== "4" &&
  snapshotProfile !== "5" &&
  snapshotProfile !== "7"
) {
  throw new Error("POIETRA_E2E_REAL_PREVIEW_PROFILE must be 2, 3, 4, 5, or 7.");
}
const externalBaseUrl = (() => {
  const configured = process.env.POIETRA_E2E_EXTERNAL_BASE_URL?.trim();
  if (!configured) return null;
  const url = new URL(configured);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("POIETRA_E2E_EXTERNAL_BASE_URL must be an uncredentialed loopback HTTP origin.");
  }
  return url.origin;
})();

function resolveManimCommand() {
  const explicit = process.env.POIETRA_MANIM_COMMAND?.trim();
  if (explicit) return explicit;
  try {
    const producerArgv: unknown = JSON.parse(producerCommand);
    if (
      Array.isArray(producerArgv) &&
      producerArgv.length >= 3 &&
      producerArgv.every((argument) => typeof argument === "string") &&
      producerArgv[1] === "-m"
    ) {
      return JSON.stringify([producerArgv[0], "-m", "manim"]);
    }
  } catch {
    // A non-JSON producer command cannot identify its companion Manim CLI.
  }
  return null;
}

const manimCommand = resolveManimCommand();
if ((snapshotProfile === "4" || snapshotProfile === "7") && !manimCommand) {
  throw new Error(
    "The real editable Scene E2E requires POIETRA_MANIM_COMMAND, unless the snapshot producer is a JSON Python -m argv array.",
  );
}
if (snapshotProfile === "7" && !externalBaseUrl) {
  for (const command of ["latex", "dvisvgm"]) {
    if (spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0) {
      throw new Error(`The real mixed V7 E2E requires ${command} on PATH for the full Manim render.`);
    }
  }
}

const dataRoot = join(process.cwd(), "test-results", `workspace-store-${process.pid}-real-preview-v${snapshotProfile}`);
const mutableHarness = snapshotProfile === "4" || snapshotProfile === "7";
const harnessRoot = mutableHarness
  ? mkdtempSync(join(tmpdir(), `poietra-real-preview-harness-v${snapshotProfile}-`))
  : join(process.cwd(), "fixtures", "real-preview-harness");
if (mutableHarness) {
  cpSync(join(process.cwd(), "fixtures", "real-preview-harness"), harnessRoot, { recursive: true });
}
if (snapshotProfile === "4") {
  const width = 270;
  const height = 135;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], offset);
    }
  }
  writeFileSync(join(harnessRoot, "image.png"), encodeRgbaPngV1(rgba, width, height));
}
const port = Number(process.env.POIETRA_E2E_REAL_PREVIEW_PORT ?? 4184);

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [
    {
      name:
        snapshotProfile === "7"
          ? "real-mixed-preview-webgpu"
          : snapshotProfile === "5"
            ? "real-mathtex-morph-preview-webgpu"
            : snapshotProfile === "3"
              ? "real-mathtex-preview-webgpu"
              : snapshotProfile === "4"
                ? "real-image-preview-webgpu"
                : "real-preview-webgpu",
      testMatch:
        snapshotProfile === "7"
          ? "**/real-mixed-preview.webgpu.ts"
          : snapshotProfile === "5"
            ? "**/real-mathtex-morph-preview.webgpu.ts"
            : snapshotProfile === "3"
              ? "**/real-mathtex-preview.webgpu.ts"
              : snapshotProfile === "4"
                ? "**/real-image-preview.webgpu.ts"
                : "**/real-scene-preview.webgpu.ts",
      use: {
        browserName: "chromium",
        channel: WEBGPU_CHROMIUM_CHANNEL,
        launchOptions: { args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS] },
      },
    },
  ],
  reporter: "line",
  testDir: "./e2e",
  use: {
    baseURL: externalBaseUrl ?? `http://127.0.0.1:${port}`,
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1440 },
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: `pnpm dev:web --port ${port}`,
          env: {
            POIETRA_AI_DEBUG_LOG: "off",
            POIETRA_FAST_MANIM_SNAPSHOT_COMMAND: producerCommand,
            POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN: "1",
            POIETRA_FAST_MANIM_SNAPSHOT_VERSION: snapshotProfile,
            ...(manimCommand ? { POIETRA_MANIM_COMMAND: manimCommand } : {}),
            POIETRA_MANIM_PROJECTS: JSON.stringify([
              {
                id: "real-preview-harness",
                name: "Real Preview Harness",
                root: harnessRoot,
              },
            ]),
            POIETRA_STUDIO_DATA_ROOT: dataRoot,
            VITE_POIETRA_AI_ENDPOINT: "/api/ai/edit-suggestions",
          },
          stdout: "pipe" as const,
          timeout: 120_000,
          wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${port}/`) },
        },
      }),
  workers: 1,
});

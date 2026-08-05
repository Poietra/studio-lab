import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const WRITE_STUFF_TEX_CACHE_V1 = {
  "2001da0d734dc8fc.svg": "8e6c76607b68689555296fc8039cf6c82ea29bf9ef0445a4dc6c030e9e13efa7",
  "2001da0d734dc8fc.tex": "2001da0d734dc8fcaf7e6d3d0b5035e82d71733ab5feca774aa5740e8b099716",
  "5c2081ce9e37598c.svg": "cb2e99f837c1316e47b67157bf787b1f096a14b01f4392482eba740dd3ac1dbc",
  "5c2081ce9e37598c.tex": "5c2081ce9e37598c6bdd8ac3dd52ce6616d99b162c7c64071e9a6ef4ad20d8a8",
  "8f249e3b899ba7b1.svg": "1496ea173fbe28fab26772d9509d9b34dc58ce8bd6b01a8950899a9adcb4139d",
  "8f249e3b899ba7b1.tex": "8f249e3b899ba7b13ac37b744ca8509b929b2431baf1d2ff07d28892576ac419",
} as const;
if (
  snapshotProfile !== "2" &&
  snapshotProfile !== "3" &&
  snapshotProfile !== "4" &&
  snapshotProfile !== "5" &&
  snapshotProfile !== "7" &&
  snapshotProfile !== "8" &&
  snapshotProfile !== "9" &&
  snapshotProfile !== "10" &&
  snapshotProfile !== "11" &&
  snapshotProfile !== "12"
) {
  throw new Error("POIETRA_E2E_REAL_PREVIEW_PROFILE must be 2, 3, 4, 5, 7, 8, 9, 10, 11, or 12.");
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
if (
  (snapshotProfile === "4" ||
    snapshotProfile === "7" ||
    snapshotProfile === "9" ||
    snapshotProfile === "10" ||
    snapshotProfile === "12") &&
  !manimCommand
) {
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
const officialV8ProjectRoot = process.env.POIETRA_FAST_MANIM_V8_PROJECT_ROOT?.trim();
if (snapshotProfile === "8" && !externalBaseUrl && !officialV8ProjectRoot) {
  throw new Error("The real SquareToCircle V8 E2E requires POIETRA_FAST_MANIM_V8_PROJECT_ROOT.");
}
const mutableHarness =
  snapshotProfile === "4" ||
  snapshotProfile === "7" ||
  snapshotProfile === "9" ||
  snapshotProfile === "10" ||
  snapshotProfile === "12";
const harnessRoot = mutableHarness
  ? mkdtempSync(join(tmpdir(), `poietra-real-preview-harness-v${snapshotProfile}-`))
  : join(process.cwd(), "fixtures", "real-preview-harness");
if (mutableHarness) {
  cpSync(join(process.cwd(), "fixtures", "real-preview-harness"), harnessRoot, { recursive: true });
}
let writeStuffTexCacheRoot: string | null = null;
if (snapshotProfile === "12" && !externalBaseUrl) {
  const sourceRoot = join(process.cwd(), "fixtures", "write-stuff-tex-cache-v1");
  const expectedFiles = Object.keys(WRITE_STUFF_TEX_CACHE_V1).sort();
  const actualFiles = readdirSync(sourceRoot).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("The pinned WriteStuff Tex cache contains an unexpected file set.");
  }
  const targetRoot = join(harnessRoot, "media", "Tex");
  mkdirSync(targetRoot, { recursive: true });
  for (const file of expectedFiles) {
    const bytes = readFileSync(join(sourceRoot, file));
    const expectedDigest = WRITE_STUFF_TEX_CACHE_V1[file as keyof typeof WRITE_STUFF_TEX_CACHE_V1];
    if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
      throw new Error(`The pinned WriteStuff Tex cache file ${file} failed its SHA-256 check.`);
    }
    writeFileSync(join(targetRoot, file), bytes, { flag: "wx" });
  }
  writeStuffTexCacheRoot = targetRoot;
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
const effectiveManimCommand = (() => {
  if (snapshotProfile !== "12" || externalBaseUrl) return manimCommand;
  if (!manimCommand || !writeStuffTexCacheRoot) {
    throw new Error("The real WriteStuff E2E requires a verified Tex cache and Manim command.");
  }
  let command: unknown;
  try {
    command = JSON.parse(manimCommand);
  } catch {
    throw new Error("The real WriteStuff E2E requires POIETRA_MANIM_COMMAND as a JSON Python -m manim argv array.");
  }
  if (
    !Array.isArray(command) ||
    command.length !== 3 ||
    !command.every((argument) => typeof argument === "string" && argument.length > 0) ||
    command[1] !== "-m" ||
    command[2] !== "manim"
  ) {
    throw new Error('The real WriteStuff E2E requires POIETRA_MANIM_COMMAND as [python, "-m", "manim"].');
  }
  return JSON.stringify([
    process.execPath,
    join(process.cwd(), "scripts", "run-write-stuff-manim-e2e.mjs"),
    command[0],
    writeStuffTexCacheRoot,
    JSON.stringify(WRITE_STUFF_TEX_CACHE_V1),
  ]);
})();

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [
    {
      name:
        snapshotProfile === "12"
          ? "real-write-stuff-in-preview-webgpu"
          : snapshotProfile === "11"
            ? "real-spiral-in-preview-webgpu"
            : snapshotProfile === "10"
              ? "real-line-joints-preview-webgpu"
              : snapshotProfile === "9"
                ? "real-warp-square-preview-webgpu"
                : snapshotProfile === "8"
                  ? "real-square-to-circle-preview-webgpu"
                  : snapshotProfile === "7"
                    ? "real-mixed-preview-webgpu"
                    : snapshotProfile === "5"
                      ? "real-mathtex-morph-preview-webgpu"
                      : snapshotProfile === "3"
                        ? "real-mathtex-preview-webgpu"
                        : snapshotProfile === "4"
                          ? "real-image-preview-webgpu"
                          : "real-preview-webgpu",
      testMatch:
        snapshotProfile === "12"
          ? "**/real-write-stuff-in-preview.webgpu.ts"
          : snapshotProfile === "11"
            ? "**/real-spiral-in-preview.webgpu.ts"
            : snapshotProfile === "10"
              ? "**/real-line-joints-preview.webgpu.ts"
              : snapshotProfile === "9"
                ? "**/real-warp-square-preview.webgpu.ts"
                : snapshotProfile === "8"
                  ? "**/real-square-to-circle-preview.webgpu.ts"
                  : snapshotProfile === "7"
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
            ...(effectiveManimCommand ? { POIETRA_MANIM_COMMAND: effectiveManimCommand } : {}),
            POIETRA_MANIM_PROJECTS: JSON.stringify([
              {
                id: "real-preview-harness",
                name: "Real Preview Harness",
                root: snapshotProfile === "8" ? officialV8ProjectRoot : harnessRoot,
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

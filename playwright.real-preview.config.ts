import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";
import { encodeRgbaPngV1 } from "./e2e/png-rgba";
import {
  publishRealPreviewRunStateEnvironmentV1,
  REAL_PREVIEW_HARNESS_PREFIX_V1,
  realPreviewRunStateFromEnvironmentV1,
  reclaimRealPreviewRunStateV1,
} from "./e2e/real-preview-run-state";
import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./e2e/webgpu-launch";

const snapshotProfile = process.env.POIETRA_E2E_REAL_PREVIEW_PROFILE?.trim() || "2";
const openingRuntimeTraceProfile = snapshotProfile === "runtime-trace-opening";
const runtimeTraceProfile = snapshotProfile === "runtime-trace" || openingRuntimeTraceProfile;
const producerCommand = process.env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND?.trim() ?? "";
const runtimeTraceCommand = process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND?.trim() ?? "";
if (runtimeTraceProfile ? !runtimeTraceCommand : !producerCommand) {
  throw new Error(
    runtimeTraceProfile
      ? "POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND must name the real fast-manim Runtime Trace producer as a command or JSON argv array."
      : "POIETRA_FAST_MANIM_SNAPSHOT_COMMAND must name the real fast-manim snapshot producer as a command or JSON argv array.",
  );
}
const WRITE_STUFF_TEX_CACHE_V1 = {
  "2001da0d734dc8fc.svg": "8e6c76607b68689555296fc8039cf6c82ea29bf9ef0445a4dc6c030e9e13efa7",
  "2001da0d734dc8fc.tex": "2001da0d734dc8fcaf7e6d3d0b5035e82d71733ab5feca774aa5740e8b099716",
  "5c2081ce9e37598c.svg": "cb2e99f837c1316e47b67157bf787b1f096a14b01f4392482eba740dd3ac1dbc",
  "5c2081ce9e37598c.tex": "5c2081ce9e37598c6bdd8ac3dd52ce6616d99b162c7c64071e9a6ef4ad20d8a8",
  "8f249e3b899ba7b1.svg": "1496ea173fbe28fab26772d9509d9b34dc58ce8bd6b01a8950899a9adcb4139d",
  "8f249e3b899ba7b1.tex": "8f249e3b899ba7b13ac37b744ca8509b929b2431baf1d2ff07d28892576ac419",
} as const;
if (
  snapshotProfile !== "runtime-trace" &&
  snapshotProfile !== "runtime-trace-opening" &&
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
  throw new Error(
    "POIETRA_E2E_REAL_PREVIEW_PROFILE must be runtime-trace, runtime-trace-opening, 2, 3, 4, 5, 7, 8, 9, 10, 11, or 12.",
  );
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
if (snapshotProfile === "8" && externalBaseUrl) {
  throw new Error(
    "The real SquareToCircle V8 E2E mutates its isolated source harness and cannot target an external server.",
  );
}

function resolveManimCommand() {
  const explicit = process.env.POIETRA_MANIM_COMMAND?.trim();
  if (explicit) return explicit;
  const activeProducerCommand = runtimeTraceProfile ? runtimeTraceCommand : producerCommand;
  try {
    const producerArgv: unknown = JSON.parse(activeProducerCommand);
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
  (runtimeTraceProfile ||
    snapshotProfile === "4" ||
    snapshotProfile === "7" ||
    snapshotProfile === "8" ||
    snapshotProfile === "9" ||
    snapshotProfile === "10" ||
    snapshotProfile === "12") &&
  !manimCommand
) {
  throw new Error(
    "The real editable Scene E2E requires POIETRA_MANIM_COMMAND, unless the snapshot producer is a JSON Python -m argv array.",
  );
}
if ((runtimeTraceProfile || snapshotProfile === "7") && !externalBaseUrl) {
  for (const command of ["latex", "dvisvgm"]) {
    if (spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0) {
      throw new Error(`The real editable Scene E2E requires ${command} on PATH for the full Manim render.`);
    }
  }
}

const dataRoot = join(process.cwd(), "test-results", `workspace-store-${process.pid}-real-preview-v${snapshotProfile}`);
const officialV8ProjectRoot = process.env.POIETRA_FAST_MANIM_V8_PROJECT_ROOT?.trim();
if (snapshotProfile === "8" && !externalBaseUrl && !officialV8ProjectRoot) {
  throw new Error("The real SquareToCircle V8 E2E requires POIETRA_FAST_MANIM_V8_PROJECT_ROOT.");
}
const mutableHarness =
  runtimeTraceProfile ||
  snapshotProfile === "4" ||
  snapshotProfile === "7" ||
  snapshotProfile === "8" ||
  snapshotProfile === "9" ||
  snapshotProfile === "10" ||
  snapshotProfile === "12";
const harnessRoot = mutableHarness
  ? mkdtempSync(join(tmpdir(), `${REAL_PREVIEW_HARNESS_PREFIX_V1}${snapshotProfile}-`))
  : join(process.cwd(), "fixtures", "real-preview-harness");
let setupHarnessCleanupArmed = mutableHarness;
if (mutableHarness) {
  process.once("exit", () => {
    if (!setupHarnessCleanupArmed) return;
    try {
      rmSync(harnessRoot, { force: true, recursive: true });
    } catch {
      // Best-effort only: an exit-time failure must not mask the original error.
    }
  });
  try {
    cpSync(join(process.cwd(), "fixtures", "real-preview-harness"), harnessRoot, { recursive: true });
  } catch (cause) {
    try {
      rmSync(harnessRoot, { force: true, recursive: true });
      setupHarnessCleanupArmed = false;
    } catch {
      // Keep the exit hook armed for one last best-effort attempt.
    }
    throw cause;
  }
}
// Playwright evaluates this config file in every worker process too, so each
// worker builds a harness copy of its own that backs nothing — the server only
// ever sees the runner's copy through the webServer env below. A worker must
// therefore not publish a namespace or retain its pristine copy as failure
// evidence; it only removes its own copy on exit. The runner process publishes
// this run's opaque namespace for the teardown reporter and keeps a best-effort
// exit reclamation for setup failures the reporter never sees.
if (process.env.TEST_WORKER_INDEX !== undefined) {
  publishRealPreviewRunStateEnvironmentV1(process.env, null);
} else {
  publishRealPreviewRunStateEnvironmentV1(process.env, {
    dataRoot,
    harnessRoot: mutableHarness ? harnessRoot : null,
  });
  const namespace = realPreviewRunStateFromEnvironmentV1(process.env, join(process.cwd(), "test-results"), tmpdir());
  if (!namespace) throw new Error("The real-preview runner did not publish its generated namespace.");
  process.once("exit", () => {
    try {
      reclaimRealPreviewRunStateV1({ ...namespace, now: Date.now(), outcome: "failed" });
    } catch {
      // Best-effort only: an exit-time failure must not mask the original error.
    }
  });
  setupHarnessCleanupArmed = false;
}
if (snapshotProfile === "8" && !externalBaseUrl) {
  if (!officialV8ProjectRoot) throw new Error("The official SquareToCircle V8 source root is unavailable.");
  const relativeSourcePath = join("example_scenes", "basic.py");
  const officialSource = readFileSync(join(officialV8ProjectRoot, relativeSourcePath));
  const mutableSource = readFileSync(join(harnessRoot, relativeSourcePath));
  const expectedSourceSha256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
  if (
    !officialSource.equals(mutableSource) ||
    createHash("sha256").update(officialSource).digest("hex") !== expectedSourceSha256
  ) {
    throw new Error("The mutable SquareToCircle V8 harness must begin from the byte-exact official fast-manim source.");
  }
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
      name: runtimeTraceProfile
        ? openingRuntimeTraceProfile
          ? "real-opening-manim-runtime-trace-preview-webgpu"
          : "real-runtime-trace-preview-webgpu"
        : snapshotProfile === "12"
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
      testMatch: runtimeTraceProfile
        ? openingRuntimeTraceProfile
          ? "**/real-opening-manim-runtime-trace-preview.webgpu.ts"
          : "**/real-runtime-trace-preview.webgpu.ts"
        : snapshotProfile === "12"
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
  reporter: [["line"], ["./e2e/real-preview-run-reporter.ts"]],
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
            ...(runtimeTraceProfile
              ? {
                  POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND: runtimeTraceCommand,
                  POIETRA_FAST_MANIM_RUNTIME_TRACE_DEV_OPT_IN: "1",
                }
              : {
                  POIETRA_FAST_MANIM_SNAPSHOT_COMMAND: producerCommand,
                  POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN: "1",
                  POIETRA_FAST_MANIM_SNAPSHOT_VERSION: snapshotProfile,
                }),
            ...(effectiveManimCommand ? { POIETRA_MANIM_COMMAND: effectiveManimCommand } : {}),
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

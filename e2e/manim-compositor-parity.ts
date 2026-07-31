import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { digestFastManimSnapshotBundleV1 } from "../server/fast-manim-snapshot-contract";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import { sceneIrSourceRevisionHash } from "../src/engine/scene-ir";
import {
  collectCommitIdentity,
  collectHostEnvironment,
  type GitRunner,
  hostEnvironmentSchema,
  readPinnedReferenceHostProfile,
  referenceHostProfileEvidenceSchema,
  requireReferenceHostPreflight,
  requireStableCommitIdentity,
  requireStableReferenceHostEnvironment,
} from "./benchmark-environment";
import { encodeRgbaPngV1 } from "./png-rgba";
import { compareVisualParityFramesV1, makeOpaqueVisualParityDiffV1 } from "./visual-parity-metrics";
import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./webgpu-launch";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COMMIT_SHA = z.string().regex(/^[0-9a-f]{40}$/);
const VIEWPORT = { heightPx: 468, widthPx: 832 } as const;
const REFERENCE_ROOT = "fixtures/manim-compositor-parity-v1";
const OUTPUT_ROOT = "test-results/manim-compositor-parity/real-preview-scene";
const THRESHOLDS = { maximumPixelFractionAboveThreshold: 0.005, minimumSsim: 0.995 } as const;
const snapshotProducerSchema = z.strictObject({
  clean: z.literal(true),
  fastManimCommit: COMMIT_SHA,
  manimVersion: z.string().min(1),
  pythonVersion: z.string().min(1),
});

export const manimCompositorReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    sampleTime: z.literal(0),
    viewport: z.strictObject({ heightPx: z.literal(468), widthPx: z.literal(832) }),
  }),
  png: z.strictObject({
    byteLength: z.number().int().positive(),
    channelOrder: z.literal("rgba"),
    path: z.literal("expected.png"),
    rgbaByteLength: z.literal(VIEWPORT.widthPx * VIEWPORT.heightPx * 4),
    rgbaSha256: SHA256,
    rowOrder: z.literal("top-to-bottom"),
    sha256: SHA256,
  }),
  producer: z.strictObject({
    cairoVersion: z.string().min(1),
    fastManimCommit: COMMIT_SHA,
    manimVersion: z.string().min(1),
    pillowVersion: z.string().min(1),
    pycairoVersion: z.string().min(1),
    pythonVersion: z.string().min(1),
    renderer: z.literal("cairo"),
  }),
  rendererConfig: z.strictObject({
    antialias: z.literal("default"),
    backgroundColor: z.literal("#000000"),
    backgroundOpacity: z.literal(1),
    cairoCompositor: z.literal(false),
    cairoCompositorFades: z.literal(false),
    cairoForkWorkers: z.literal(0),
    cairoStaticLayers: z.literal(false),
    disableCaching: z.literal(true),
    frameRate: z.literal(60),
    saveLastFrame: z.literal(true),
    transparent: z.literal(false),
    writeToMovie: z.literal(false),
  }),
  scene: z.strictObject({
    className: z.literal("RealPreviewScene"),
    sourcePath: z.literal("fixtures/real-preview-harness/scene.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.manim-compositor-reference"),
  version: z.literal(1),
});

export const manimCompositorParityReportV1Schema = z
  .strictObject({
    artifacts: z.strictObject({
      actual: z.strictObject({ path: z.literal("actual.png"), sha256: SHA256 }),
      diff: z.strictObject({ path: z.literal("diff.png"), sha256: SHA256 }),
      expected: z.strictObject({ path: z.literal("expected.png"), sha256: SHA256 }),
    }),
    browser: z.strictObject({
      channel: z.literal("msedge"),
      configuredArgs: z.tuple([]),
      pageAdapterHint: z.strictObject({ architecture: z.string().min(1), vendor: z.string().min(1) }),
      version: z.string().regex(/^\d+(?:\.\d+){3}$/),
    }),
    capture: z.strictObject({
      cssViewport: z.strictObject({ heightPx: z.literal(468), widthPx: z.literal(832) }),
      devicePixelRatio: z.literal(1),
      packetId: z.string().min(1),
      policy: z.literal("visible-locator-screenshot-with-studio-overlays-hidden-after-two-animation-frames"),
      rgbaNormalization: z.literal(
        "browser-png-decoded-to-srgb-rgba-unorm8-with-color-conversion-none-and-premultiply-alpha-none",
      ),
      pngByteLength: z.number().int().positive(),
      pngSha256: SHA256,
      rgbaByteLength: z.literal(VIEWPORT.widthPx * VIEWPORT.heightPx * 4),
      rgbaSha256: SHA256,
    }),
    environment: z.strictObject({
      host: hostEnvironmentSchema,
      referenceHostProfile: referenceHostProfileEvidenceSchema,
      serverCheckout: z.strictObject({
        commitSha: COMMIT_SHA,
        source: z.literal("git-tracked-checkout"),
        topology: z.enum(["local-web-server", "external-loopback-web-server"]),
        trackedTreeState: z.literal("clean"),
      }),
      servedWasm: z.strictObject({ byteLength: z.number().int().positive(), path: z.string().min(1), sha256: SHA256 }),
      snapshotProducer: snapshotProducerSchema,
    }),
    gate: z.strictObject({
      maximumPixelFractionAboveThreshold: z.literal(0.005),
      minimumSsim: z.literal(0.995),
      passed: z.boolean(),
    }),
    metrics: z.strictObject({
      pixelCount: z.literal(VIEWPORT.widthPx * VIEWPORT.heightPx),
      pixelCountAboveThreshold: z.number().int().nonnegative(),
      pixelFractionAboveThreshold: z.number().min(0).max(1),
      ssim: z.number().min(-1).max(1),
    }),
    reference: manimCompositorReferenceV1Schema,
    schema: z.literal("poietra.manim-compositor-parity-report"),
    studio: z.strictObject({
      assetsManifestDigest: SHA256,
      commitSha: COMMIT_SHA,
      engineRevisionHash: SHA256,
      packetId: z.string().min(1),
      runtimeConfigHash: SHA256,
      sampleTime: z.literal(0),
      sceneId: z.string().min(1),
      serverPublicationRevision: z.number().int().positive(),
      snapshotRequestId: z.string().min(1).max(256),
      snapshotHash: SHA256,
      snapshotVersion: z.literal(2),
      sourceHash: SHA256,
      viewport: z.strictObject({ heightPx: z.literal(468), widthPx: z.literal(832) }),
    }),
    version: z.literal(1),
  })
  .superRefine((report, context) => {
    const derivedFraction = report.metrics.pixelCountAboveThreshold / report.metrics.pixelCount;
    if (report.metrics.pixelFractionAboveThreshold !== derivedFraction) {
      context.addIssue({
        code: "custom",
        message: "pixelFractionAboveThreshold must be derived from the recorded pixel counts.",
        path: ["metrics", "pixelFractionAboveThreshold"],
      });
    }
    const derivedGate =
      report.metrics.ssim >= report.gate.minimumSsim &&
      report.metrics.pixelFractionAboveThreshold <= report.gate.maximumPixelFractionAboveThreshold;
    if (report.gate.passed !== derivedGate) {
      context.addIssue({
        code: "custom",
        message: "gate.passed must be derived from the recorded metrics and thresholds.",
        path: ["gate", "passed"],
      });
    }
    if (report.capture.packetId !== report.studio.packetId) {
      context.addIssue({
        code: "custom",
        message: "The captured frame and Studio evidence must identify the same packet.",
        path: ["capture", "packetId"],
      });
    }
    if (report.reference.scene.sourceSha256 !== report.studio.sourceHash) {
      context.addIssue({
        code: "custom",
        message: "The Cairo reference and Studio snapshot must identify the same source bytes.",
        path: ["studio", "sourceHash"],
      });
    }
    if (
      report.environment.snapshotProducer.fastManimCommit !== report.reference.producer.fastManimCommit ||
      report.environment.snapshotProducer.manimVersion !== report.reference.producer.manimVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "The snapshot producer and Cairo reference must use the same fast-manim and Manim revisions.",
        path: ["environment", "snapshotProducer"],
      });
    }
    if (report.studio.engineRevisionHash !== report.studio.snapshotHash) {
      context.addIssue({
        code: "custom",
        message: "The imported Scene engine revision must equal its sealed snapshot hash.",
        path: ["studio", "engineRevisionHash"],
      });
    }
    if (report.artifacts.actual.sha256 !== report.capture.pngSha256) {
      context.addIssue({
        code: "custom",
        message: "The actual artifact digest must equal the captured PNG digest.",
        path: ["artifacts", "actual", "sha256"],
      });
    }
    if (report.artifacts.expected.sha256 !== report.reference.png.sha256) {
      context.addIssue({
        code: "custom",
        message: "The expected artifact digest must equal the pinned Cairo reference digest.",
        path: ["artifacts", "expected", "sha256"],
      });
    }
    if (
      !("status" in report.environment.host.commitIdentity) &&
      report.studio.commitSha !== report.environment.host.commitIdentity.headCommit
    ) {
      context.addIssue({
        code: "custom",
        message: "The Studio commit must equal the measured checkout commit.",
        path: ["studio", "commitSha"],
      });
    }
    if (report.environment.serverCheckout.commitSha !== report.studio.commitSha) {
      context.addIssue({
        code: "custom",
        message: "The web server checkout must equal the measured Studio commit.",
        path: ["environment", "serverCheckout", "commitSha"],
      });
    }
  });

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireOpaqueRgba(bytes: Uint8Array, label: string) {
  for (let offset = 3; offset < bytes.byteLength; offset += 4) {
    if (bytes[offset] !== 255) {
      throw new Error(`${label} contains a non-opaque pixel at RGBA byte offset ${offset}.`);
    }
  }
}

function collectSnapshotProducerEvidence() {
  const configured = process.env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND?.trim();
  if (!configured) throw new Error("The compositor parity lane requires the explicit real snapshot producer command.");
  const command: unknown = JSON.parse(configured);
  if (
    !Array.isArray(command) ||
    command.length < 3 ||
    !command.every((argument) => typeof argument === "string") ||
    command.at(-2) !== "-m" ||
    command.at(-1) !== "manim.renderer.source_runtime_identity"
  ) {
    throw new Error(
      "The compositor parity lane requires JSON argv ending in [python-prefix..., -m, source_runtime_identity].",
    );
  }
  const probe = String.raw`
import json, pathlib, subprocess, sys
import manim
root = pathlib.Path(manim.__file__).resolve().parent.parent
def git(*args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout.strip()
print(json.dumps({
    "clean": git("status", "--porcelain") == "",
    "fastManimCommit": git("rev-parse", "HEAD"),
    "manimVersion": manim.__version__,
    "pythonVersion": ".".join(map(str, sys.version_info[:3])),
}))
`;
  return snapshotProducerSchema.parse(
    JSON.parse(execFileSync(command[0], [...command.slice(1, -2), "-c", probe], { encoding: "utf8" })),
  );
}

function collectServerCheckoutEvidence(expectedCommit: string) {
  const externalBaseUrl = process.env.POIETRA_E2E_EXTERNAL_BASE_URL?.trim();
  if (!externalBaseUrl) {
    return {
      evidence: {
        commitSha: expectedCommit,
        source: "git-tracked-checkout" as const,
        topology: "local-web-server" as const,
        trackedTreeState: "clean" as const,
      },
      git: null,
      identity: null,
    };
  }

  const repository = process.env.POIETRA_E2E_EXTERNAL_SERVER_REPOSITORY?.trim();
  if (!repository) {
    throw new Error("The external compositor parity server requires POIETRA_E2E_EXTERNAL_SERVER_REPOSITORY.");
  }
  const git: GitRunner = (arguments_) => {
    const command = arguments_[0] === "status" ? [...arguments_, "--untracked-files=no"] : [...arguments_];
    return execFileSync("git", ["-c", `safe.directory=${repository}`, "-C", repository, ...command], {
      encoding: "utf8",
    });
  };
  const identity = collectCommitIdentity(git);
  if ("status" in identity) throw new Error(`The external server checkout is unavailable: ${identity.reason}`);
  if (identity.treeState !== "clean" || identity.uncommittedPathCount !== 0) {
    throw new Error("The external server checkout contains uncommitted tracked files.");
  }
  if (identity.headCommit !== expectedCommit) {
    throw new Error(
      `The external server checkout is ${identity.headCommit}, while the measured Studio checkout is ${expectedCommit}.`,
    );
  }
  return {
    evidence: {
      commitSha: identity.headCommit,
      source: "git-tracked-checkout" as const,
      topology: "external-loopback-web-server" as const,
      trackedTreeState: "clean" as const,
    },
    git,
    identity,
  };
}

async function decodePng(page: Page, png: Uint8Array) {
  const rgba = await page.evaluate(async (base64) => {
    const encoded = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([encoded], { type: "image/png" }), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const canvas = Object.assign(document.createElement("canvas"), { height: bitmap.height, width: bitmap.width });
    const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    if (!context) throw new Error("The compositor parity PNG decoder could not create a 2D context.");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height, {
      colorSpace: "srgb",
      pixelFormat: "rgba-unorm8",
    });
    return {
      height: canvas.height,
      rgba: [...pixels.data],
      width: canvas.width,
    };
  }, Buffer.from(png).toString("base64"));
  expect({ height: rgba.height, width: rgba.width }).toEqual({ height: VIEWPORT.heightPx, width: VIEWPORT.widthPx });
  return Uint8Array.from(rgba.rgba);
}

async function twoAnimationFrames(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

type ProofInput = Readonly<{
  canvas: Locator;
  canvasRoot: Locator;
  engineRevisionHash: string;
  page: Page;
  serverPublicationRevision: number;
  snapshotRequestId: string;
  snapshot: SceneIrBundleV1;
}>;

export async function proveManimCompositorParityV1(input: ProofInput) {
  if (process.env.POIETRA_MANIM_COMPOSITOR_PARITY_REQUIRED !== "1") return;
  if (process.platform !== "win32") {
    throw new Error("The compositor parity evidence lane requires the pinned Windows D3D12 host.");
  }

  const referenceHost = readPinnedReferenceHostProfile();
  const host = collectHostEnvironment();
  const browserLaunch = { args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS], channel: WEBGPU_CHROMIUM_CHANNEL };
  requireReferenceHostPreflight({ browserLaunch, host, referenceHost });
  if ("status" in host.commitIdentity || host.commitIdentity.treeState !== "clean") {
    throw new Error("The compositor parity evidence requires a clean committed checkout.");
  }
  const serverCheckout = collectServerCheckoutEvidence(host.commitIdentity.headCommit);
  const browserVersion = input.page.context().browser()?.version();
  expect(browserVersion).toBe(referenceHost.profile.browser.version);

  const referenceBytes = new Uint8Array(await readFile(join(REFERENCE_ROOT, "reference.json")));
  const reference = manimCompositorReferenceV1Schema.parse(JSON.parse(new TextDecoder().decode(referenceBytes)));
  const snapshotProducer = collectSnapshotProducerEvidence();
  expect(snapshotProducer).toMatchObject({
    fastManimCommit: reference.producer.fastManimCommit,
    manimVersion: reference.producer.manimVersion,
  });
  const expectedPng = new Uint8Array(await readFile(join(REFERENCE_ROOT, reference.png.path)));
  expect(expectedPng.byteLength).toBe(reference.png.byteLength);
  expect(sha256(expectedPng)).toBe(reference.png.sha256);
  expect(sha256(new Uint8Array(await readFile(reference.scene.sourcePath)))).toBe(reference.scene.sourceSha256);

  const source = input.snapshot.scene.source;
  expect(source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotHash: input.engineRevisionHash,
    snapshotVersion: 2,
    sourceHash: reference.scene.sourceSha256,
  });
  if (source.kind !== "imported-manim-server-snapshot") throw new Error("The real preview source was not imported.");
  expect(digestFastManimSnapshotBundleV1(input.snapshot)).toBe(input.engineRevisionHash);
  expect(sceneIrSourceRevisionHash(input.snapshot.scene)).toBe(input.engineRevisionHash);

  const style = await input.page.addStyleTag({
    content: `
      [data-studio-canvas] {
        aspect-ratio: auto !important;
        border: 0 !important;
        flex: none !important;
        height: ${VIEWPORT.heightPx}px !important;
        max-width: none !important;
        padding: 0 !important;
        width: ${VIEWPORT.widthPx}px !important;
      }
      [data-studio-canvas] > :not([data-studio-preview-canvas]) { visibility: hidden !important; }
      #studio-magic-edit { visibility: hidden !important; }
    `,
  });
  let actualPng: Buffer | null = null;
  let capturedPacketId: string | null = null;
  try {
    await expect(input.canvasRoot).toHaveAttribute("data-preview-renderer", "presented");
    await expect(input.canvasRoot).toHaveAttribute("data-preview-revision", input.engineRevisionHash);
    await expect(input.canvasRoot).toHaveAttribute("data-preview-sample-time", "0");
    await expect(input.canvasRoot).toHaveAttribute("data-preview-viewport", "832x468");
    const dimensions = await input.canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      return { backingHeight: canvas.height, backingWidth: canvas.width, height: rect.height, width: rect.width };
    });
    expect(dimensions).toEqual({ backingHeight: 468, backingWidth: 832, height: 468, width: 832 });
    expect(await input.page.evaluate(() => devicePixelRatio)).toBe(1);
    capturedPacketId = await input.canvasRoot.getAttribute("data-preview-packet-id");
    if (!capturedPacketId) throw new Error("The visible compositor frame has no packet correlation.");
    await twoAnimationFrames(input.page);
    actualPng = await input.canvas.screenshot({ animations: "disabled", type: "png" });
    await expect(input.canvasRoot).toHaveAttribute("data-preview-packet-id", capturedPacketId);
    await expect(input.canvasRoot).toHaveAttribute("data-preview-revision", input.engineRevisionHash);
    await expect(input.canvasRoot).toHaveAttribute("data-preview-sample-time", "0");
    await expect(input.canvasRoot).toHaveAttribute("data-preview-viewport", "832x468");
  } finally {
    await style.evaluate((element) => element.remove());
  }
  if (!actualPng || !capturedPacketId) throw new Error("The visible compositor frame was not captured.");

  const [expectedRgba, actualRgba] = await Promise.all([
    decodePng(input.page, expectedPng),
    decodePng(input.page, actualPng),
  ]);
  expect(sha256(expectedRgba)).toBe(reference.png.rgbaSha256);
  requireOpaqueRgba(expectedRgba, "The Cairo reference");
  requireOpaqueRgba(actualRgba, "The visible Studio capture");
  const metrics = compareVisualParityFramesV1(expectedRgba, actualRgba, VIEWPORT, {
    alpha: "stored-premultiplied-rgba-four-channels-equal-weight",
    colorDomain: "srgb-u8",
    diffImage: "max-absolute-rgba-grayscale-opaque",
    pixelDifference: { classification: "any-rgba-channel-strictly-greater", thresholdU8: 8 },
    schema: "poietra.visual-parity-metric",
    ssim: {
      aggregation: "unweighted-arithmetic-mean-of-window-channel-scores",
      channels: ["red", "green", "blue", "alpha"],
      constants: { dynamicRange: 255, k1: 0.01, k2: 0.03 },
      variance: "population",
      window: { edge: "clip", edgeWindowWeight: "equal", heightPx: 8, kind: "uniform", stridePx: 8, widthPx: 8 },
    },
    version: 1,
  });
  const passed =
    metrics.ssim >= THRESHOLDS.minimumSsim &&
    metrics.pixelFractionAboveThreshold <= THRESHOLDS.maximumPixelFractionAboveThreshold;
  const pageAdapterHint = await input.page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("The compositor parity page could not select a WebGPU adapter.");
    return { architecture: adapter.info.architecture, vendor: adapter.info.vendor };
  });
  expect(pageAdapterHint).toEqual({
    architecture: referenceHost.profile.selectedWorkerAdapter.browserArchitecture,
    vendor: referenceHost.profile.selectedWorkerAdapter.browserVendor,
  });
  const wasmPath = "/engine-wasm/poietra_wasm_bg.wasm";
  const wasmResponse = await input.page.request.get(new URL(wasmPath, input.page.url()).href);
  expect(wasmResponse.ok()).toBe(true);
  const wasm = new Uint8Array(await wasmResponse.body());
  requireStableReferenceHostEnvironment(host, collectHostEnvironment());
  requireStableCommitIdentity(host.commitIdentity);
  if (serverCheckout.git && serverCheckout.identity) {
    requireStableCommitIdentity(serverCheckout.identity, serverCheckout.git);
  }
  const diffPng = encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(expectedRgba, actualRgba), 832, 468);

  const report = manimCompositorParityReportV1Schema.parse({
    artifacts: {
      actual: { path: "actual.png", sha256: sha256(actualPng) },
      diff: { path: "diff.png", sha256: sha256(diffPng) },
      expected: { path: "expected.png", sha256: sha256(expectedPng) },
    },
    browser: { channel: "msedge", configuredArgs: [], pageAdapterHint, version: browserVersion },
    capture: {
      cssViewport: VIEWPORT,
      devicePixelRatio: 1,
      packetId: capturedPacketId,
      policy: "visible-locator-screenshot-with-studio-overlays-hidden-after-two-animation-frames",
      rgbaNormalization:
        "browser-png-decoded-to-srgb-rgba-unorm8-with-color-conversion-none-and-premultiply-alpha-none",
      pngByteLength: actualPng.byteLength,
      pngSha256: sha256(actualPng),
      rgbaByteLength: actualRgba.byteLength,
      rgbaSha256: sha256(actualRgba),
    },
    environment: {
      host,
      referenceHostProfile: referenceHost.evidence,
      serverCheckout: serverCheckout.evidence,
      servedWasm: { byteLength: wasm.byteLength, path: wasmPath, sha256: sha256(wasm) },
      snapshotProducer,
    },
    gate: { ...THRESHOLDS, passed },
    metrics,
    reference,
    schema: "poietra.manim-compositor-parity-report",
    studio: {
      assetsManifestDigest: input.snapshot.assets.manifestDigest,
      commitSha: host.commitIdentity.headCommit,
      engineRevisionHash: input.engineRevisionHash,
      packetId: capturedPacketId,
      runtimeConfigHash: source.runtimeConfigHash,
      sampleTime: 0,
      sceneId: input.snapshot.scene.sceneId,
      serverPublicationRevision: input.serverPublicationRevision,
      snapshotRequestId: input.snapshotRequestId,
      snapshotHash: source.snapshotHash,
      snapshotVersion: source.snapshotVersion,
      sourceHash: source.sourceHash,
      viewport: VIEWPORT,
    },
    version: 1,
  });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await Promise.all([
    writeFile(join(OUTPUT_ROOT, "expected.png"), expectedPng),
    writeFile(join(OUTPUT_ROOT, "actual.png"), actualPng),
    writeFile(join(OUTPUT_ROOT, "diff.png"), diffPng),
    writeFile(join(OUTPUT_ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  expect(metrics.ssim, join(OUTPUT_ROOT, "report.json")).toBeGreaterThanOrEqual(THRESHOLDS.minimumSsim);
  expect(metrics.pixelFractionAboveThreshold, join(OUTPUT_ROOT, "report.json")).toBeLessThanOrEqual(
    THRESHOLDS.maximumPixelFractionAboveThreshold,
  );
}

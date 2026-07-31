import { expect, type Page, type Response, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";
import { proveManimCompositorParityV1 } from "./manim-compositor-parity";

const SERVER_QUERY = "?previewRenderer=server";
const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const DYNAMIC_BINDING_ID = "source-binding:03b26136c2567ae10a842328e2aa564bf41847aadcb07fdc5d2942b3ac441398";
const DYNAMIC_CLIP_BOUNDS = [-0.17578125, -0.3125, 0.17578125, 0.3125] as const;
const DYNAMIC_SCENE_ID = "scene:6b288d59a3a8c97d32ce60dd8518133ad740f2bc5172eb71d571309156713094";
const DYNAMIC_RUNTIME_ENTITY_ID = `${DYNAMIC_SCENE_ID}/entity:0`;
const DYNAMIC_SOURCE_HASH = "4cb935a058980b3131ab26b756c71cb08ce6a72524c51bbc05b282343bd93702";
const DYNAMIC_VIEWPORT = "832x468";
const AFFINE_SCENE_ID = "scene:e9afb093122a4e056a92bd23fca4e32d63bb7170f5634e455672aa0bce468949";
const AFFINE_SOURCE_HASH = "783ce0d0fbf5f3d4f2866e66b5ed6d02120ef66e721940daa5476632f4cde3ec";
const AFFINE_ENTITY_IDS = Array.from({ length: 7 }, (_, index) => `${AFFINE_SCENE_ID}/entity:${index}`);
const AFFINE_BINDINGS = [
  ["sentinel", "source-binding:f24244a5c6e4c3105d4a8c64cdeba64645681f2ccdbe00b83156e59124acab35", 16],
  ["translation", "source-binding:69d960aa08a853c1d9cffc849f83a78ac17b89389bfb710619403683e060b8e1", 19],
  ["rotation", "source-binding:51aa3c4be4149b430b0073dc296cce70dcca267f2e6ae3f52bcb7635a2687005", 16],
  ["scale", "source-binding:27dc9759d2bf1a976beddbdb8c65421f278e2fa35d53e3b7b99bd7253496ef44", 13],
  ["stretch", "source-binding:62fb2839f5fbb4edba0aa5993fa8b8d7d4405b417b97cb5aecc869dcffc73c6a", 15],
  ["shear", "source-binding:d1b6ea5b81c0e1aa7a757287b8ae2c55a20d780dc650f0f02d37b15b5f191d2d", 13],
  ["reflection", "source-binding:0fcb61b906cff5fbfc5e0f50864e4fefa1c55e0e51f355f26d5ce6963ce843cf", 18],
] as const;
const AFFINE_BOUNDS_AT_FIVE = [
  [-0.75234375, 0.6625, -0.65390625, 0.8375],
  [-0.61875, -0.5625, -0.50625, -0.4375],
  [-0.45, -0.625, -0.39375, -0.375],
  [-0.214453125, -0.63125, -0.066796875, -0.36875],
  [0.09140625, -0.63125, 0.18984375, -0.36875],
  [0.348046875, -0.5625, 0.495703125, -0.4375],
  [0.225, 0.175, 0.3375, 0.325],
] as const;
const PATH_TRIM_SCENE_ID = "scene:ea184a9813e80bb4c96d33144c5b39e24985e5bb7807c38effccd9a7f66ef068";
const PATH_TRIM_SOURCE_HASH = "1d2598220595420e633c50ecb3340208bcc1b147e9662f343fb5b2bbd2c7c8af";
const PATH_TRIM_ENTITY_IDS = Array.from({ length: 5 }, (_, index) => `${PATH_TRIM_SCENE_ID}/entity:${index}`);
const PATH_TRIM_BINDINGS = [
  ["sentinel", "source-binding:879e2710e193eb6c0c2191aa0f48d926cc865fbf9ac33ef061b9c136e36b5128", 16],
  ["circle", "source-binding:1d2fdad09d2a38c14265a16a4157e96b0cc713971be9bb04b6199a7c232b02ae", 14],
  ["rectangle", "source-binding:c36069db9dffdab3cef103f1d8ddd00e1136fe482b8eb80bd4b1e87206445a1d", 17],
  ["line", "source-binding:83dae5ad5f81cc8a65fd752f1d72286103d2672d9476847161e6a24ab088aa3d", 12],
  ["immediate_circle", "source-binding:6ec5fefa194850eb55dc1e5668cc3abf66b117f0590691ed3ec68a4ad123b3b5", 24],
] as const;
const PATH_TRIM_VIEWPORT = "832x468";
const PATH_MORPH_SCENE_ID = "scene:6977ca337b82c7845dcfb7254f63e7eb9055aefaf877107f123c4b8efb80db13";
const PATH_MORPH_SOURCE_HASH = "5f911a03b7d2426805c343ad294ca98fe2769805f2e452e46c3f64095ce30d88";
const PATH_MORPH_ENTITY_IDS = Array.from({ length: 3 }, (_, index) => `${PATH_MORPH_SCENE_ID}/entity:${index}`);
const MOTION_PATH_SCENE_ID = "scene:6c6dc9de3aebd24f13920ab2e2e597ef5cc7da8e780b6072ee94319434e92ca4";
const MOTION_PATH_SOURCE_HASH = "3833b7cad5f4654bd5a27e71f158500f235ecc022b8332a6cfc30e1b7d45b8fa";
const MOTION_PATH_ENTITY_IDS = Array.from({ length: 3 }, (_, index) => `${MOTION_PATH_SCENE_ID}/entity:${index}`);

type RgbaPixel = readonly [number, number, number, number];

type SnapshotRunBody = {
  failure?: { code?: string };
  projectId?: string;
  requestId?: string;
  revision?: number;
  sceneName?: string;
  snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
  sourcePath?: string;
  sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
  status?: string;
};

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance = 4) {
  for (const [index, component] of actual.entries()) {
    expect(Math.abs(component - expected[index])).toBeLessThanOrEqual(tolerance);
  }
}

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function openRealWorkspace(page: Page) {
  await page.goto(`/${SERVER_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: "scene.py · RealPreviewScene" });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function selectScene(page: Page, name: string, sourcePath = "scene.py") {
  // Keep producer outcomes in separate fixture files so a failed or
  // unsupported request has one unambiguous source-level cause.
  const response = snapshotResponse(page);
  await page.getByLabel("Active imported Scene").selectOption({ label: `${sourcePath} · ${name}` });
  return response;
}

function isExternalResponseBodyEviction(error: unknown) {
  return (
    Boolean(process.env.POIETRA_E2E_EXTERNAL_BASE_URL?.trim()) &&
    error instanceof Error &&
    error.message.includes("Protocol error (Network.getResponseBody): No data found for resource with given identifier")
  );
}

async function readSnapshotRunBody(response: Response, expectedStatus: string): Promise<SnapshotRunBody> {
  try {
    return (await response.json()) as SnapshotRunBody;
  } catch (error) {
    if (expectedStatus !== "verified" || !isExternalResponseBodyEviction(error)) throw error;

    const requestBody = response.request().postDataJSON() as unknown;
    if (
      typeof requestBody !== "object" ||
      requestBody === null ||
      !("projectId" in requestBody) ||
      typeof requestBody.projectId !== "string" ||
      !("requestId" in requestBody) ||
      typeof requestBody.requestId !== "string" ||
      !("sceneName" in requestBody) ||
      typeof requestBody.sceneName !== "string" ||
      !("sourcePath" in requestBody) ||
      typeof requestBody.sourcePath !== "string"
    ) {
      throw new Error("The external Scene snapshot request did not expose its lookup identity.");
    }

    const lookupUrl = new URL(response.url());
    lookupUrl.search = new URLSearchParams({
      sceneName: requestBody.sceneName,
      sourcePath: requestBody.sourcePath,
    }).toString();
    const published = await response
      .request()
      .frame()
      .page()
      .evaluate(async (url) => {
        const lookup = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!lookup.ok) throw new Error(`Scene snapshot lookup failed with HTTP ${lookup.status}.`);
        return lookup.json() as Promise<unknown>;
      }, lookupUrl.href);
    const body = published as SnapshotRunBody;
    if (
      body.projectId !== requestBody.projectId ||
      body.requestId !== requestBody.requestId ||
      body.sceneName !== requestBody.sceneName ||
      body.sourcePath !== requestBody.sourcePath
    ) {
      throw new Error("The external Scene snapshot lookup returned a different publication identity.");
    }
    return body;
  }
}

async function expectRunStatus(responsePromise: Promise<Response>, status: string) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = await readSnapshotRunBody(response, status);
  expect(body.status).toBe(status);
  return body;
}

async function expectVerifiedRun(responsePromise: Promise<Response>) {
  const body = await expectRunStatus(responsePromise, "verified");
  expect(typeof body.revision).toBe("number");
  if (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw new Error("The Scene snapshot response did not expose a positive integer publication revision.");
  }
  return { ...body, revision: body.revision };
}

async function expectPresented(page: Page, revision: number) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(`verified server snapshot r${revision}`);
  await expect(page.locator("[data-studio-preview-status]")).toContainText("editing preview only");
}

/**
 * Complementary renderer proof: render the server-sealed bundle in an
 * independent worker and read exact GPU texture pixels. The locator screenshot
 * remains an issue #78 real-GPU gate because this headless environment does
 * not compositor-capture even a fenced main-thread WebGPU clear.
 */
async function readBackIndependentRendererPixels(
  page: Page,
  input: Readonly<{ revision: string; sampleTime: number; snapshot: SceneIrBundleV1; viewport: string }>,
) {
  return page.evaluate(async ({ revision, sampleTime, snapshot, viewport }) => {
    const [widthPx, heightPx] = viewport.split("x").map(Number);
    const canvas = Object.assign(document.createElement("canvas"), { height: heightPx, width: widthPx });
    const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
    const evidenceModuleUrl = "/src/engine/canvas-worker-evidence.ts";
    const { PoietraCanvasWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/canvas-worker-client");
    const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
      evidenceModuleUrl
    )) as typeof import("../src/engine/canvas-worker-evidence");
    const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
    try {
      await client.installScene({ canvas, revision, snapshot });
      const frame = await client.render({ revision, sampleTime, viewport: { heightPx, widthPx } });
      const evidence = await client.captureFrameEvidence({
        revision,
        samples: [
          { fractionX: 0.03, fractionY: 0.05 },
          { fractionX: 0.5 - 27 / 128, fractionY: 0.5 },
          { fractionX: 0.5 + 18 / 128, fractionY: 0.5 },
          { fractionX: 0.5, fractionY: 0.25 },
        ],
      });
      return { evidence, frame };
    } finally {
      client.dispose();
    }
  }, input);
}

async function readBackDynamicRendererSamples(
  page: Page,
  input: Readonly<{
    entityIds: readonly string[];
    evidenceSamples?: readonly Readonly<{ fractionX: number; fractionY: number }>[];
    revision: string;
    samples: readonly Readonly<{ id: string; sampleTime: number }>[];
    snapshot: SceneIrBundleV1;
    viewport: string;
  }>,
) {
  return page.evaluate(async ({ entityIds, evidenceSamples, revision, samples, snapshot, viewport }) => {
    const [widthPx, heightPx] = viewport.split("x").map(Number);
    const canvas = Object.assign(document.createElement("canvas"), { height: heightPx, width: widthPx });
    const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
    const evidenceModuleUrl = "/src/engine/canvas-worker-evidence.ts";
    const { PoietraCanvasWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/canvas-worker-client");
    const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
      evidenceModuleUrl
    )) as typeof import("../src/engine/canvas-worker-evidence");
    const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
    try {
      await client.installScene({ canvas, revision, snapshot });
      const results = [];
      for (const sample of samples) {
        const frame = await client.render({
          interactionEntityIds: entityIds,
          revision,
          sampleTime: sample.sampleTime,
          viewport: { heightPx, widthPx },
        });
        const evidence = await client.captureFrameEvidence({
          revision,
          samples: evidenceSamples ?? [
            { fractionX: 0.5, fractionY: 0.5 },
            { fractionX: 0.03, fractionY: 0.05 },
          ],
        });
        results.push({ evidence, frame, id: sample.id });
      }
      return results;
    } finally {
      client.dispose();
    }
  }, input);
}

async function expectWholeSceneFallback(page: Page, status: "failed" | "unsupported") {
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute("data-preview-fallback-reason", "snapshot-unavailable");
  await expect(canvasRoot).not.toHaveAttribute("data-preview-packet-id", /.+/);
  await expect(page.locator("[data-studio-preview-status]")).toHaveAttribute("title", new RegExp(`\\(${status}\\)`));
  const semanticPaint = page.locator("[data-studio-semantic-paint]");
  await expect(semanticPaint).toHaveCount(1);
  await expect(semanticPaint).toHaveAttribute("data-studio-semantic-paint", "painted");
  await expect(semanticPaint).toBeVisible();
}

test("correlates a real fast-manim Scene with the retained host and verifies GPU texture output", async ({ page }) => {
  const run = await expectVerifiedRun(await openRealWorkspace(page));
  expect(run.snapshot?.bundle?.scene?.entities).toHaveLength(3);
  expect(run.snapshot?.bundle?.scene.duration).toBe(1);
  await expectPresented(page, run.revision);
  const bundle = run.snapshot?.bundle;
  const snapshotHash = run.snapshot?.snapshotHash;
  const snapshotRequestId = run.requestId;
  if (!bundle || !snapshotHash || !snapshotRequestId) {
    throw new Error("The verified server snapshot did not expose complete WebGPU proof inputs.");
  }
  const canvas = page.locator("[data-studio-preview-canvas]");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await proveManimCompositorParityV1({
    canvas,
    canvasRoot,
    engineRevisionHash: snapshotHash,
    page,
    serverPublicationRevision: run.revision,
    snapshotRequestId,
    snapshot: bundle,
  });

  for (const name of ["circle", "rectangle", "line"]) {
    await expect(page.getByRole("button", { name: `Move ${name}`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Inspector" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Timeline playhead" })).toBeVisible();
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toHaveAttribute("aria-pressed", "false");

  await canvas.evaluate((element) => {
    element.dataset.realProducerCanvas = "retained";
  });
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", snapshotHash);

  await page.getByRole("button", { name: "Set position" }).click();
  const circleButton = page.getByRole("button", { name: "Move circle", exact: true });
  await page.getByRole("checkbox", { name: "Select circle" }).check();
  await expect(circleButton).toHaveAttribute("aria-pressed", "true");
  const resizeHandle = page.getByRole("button", { name: "Resize circle from bottom-right corner" });
  await expect(resizeHandle).toBeVisible();
  await resizeHandle.press("ArrowRight");
  await expect(canvasRoot).toHaveAttribute("data-preview-fallback-reason", "snapshot-uncorrelated");
  await expect(page.locator("[data-studio-semantic-paint]").first()).toHaveAttribute(
    "data-studio-semantic-paint",
    "painted",
  );
  await page.getByRole("button", { name: "Discard" }).click();
  await expectPresented(page, run.revision);
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", snapshotHash);

  const firstPacket = await canvasRoot.getAttribute("data-preview-packet-id");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  if (!viewport) {
    throw new Error("The verified server snapshot did not expose complete WebGPU proof inputs.");
  }
  const proof = await readBackIndependentRendererPixels(page, {
    revision: snapshotHash,
    sampleTime: 0,
    snapshot: bundle,
    viewport,
  });
  expect(proof.frame).toMatchObject({ kind: "frame-presented", revision: snapshotHash, sampleTime: 0 });
  expect(proof.evidence).toMatchObject({
    packetId: proof.frame.packetId,
    revision: snapshotHash,
    sampleTime: 0,
  });
  expect(`${proof.evidence.viewport.widthPx}x${proof.evidence.viewport.heightPx}`).toBe(viewport);
  const [background, circlePixel, rectangle, line] = proof.evidence.samples;
  expectPixelNear(background, [0, 0, 0, 255]);
  expectPixelNear(circlePixel, [252, 98, 85, 255]);
  expectPixelNear(rectangle, [88, 196, 221, 255]);
  expectPixelNear(line, [131, 193, 103, 255]);

  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(scenePlayhead).toHaveAttribute("max", "1");
  await scenePlayhead.fill("0.6");
  await expectPresented(page, run.revision);
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.6");
  await expect(canvas).toHaveAttribute("data-real-producer-canvas", "retained");
  const seekPacket = await canvasRoot.getAttribute("data-preview-packet-id");
  expect(seekPacket).not.toBe(firstPacket);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(async () => Number(await scenePlayhead.inputValue())).toBeGreaterThan(0.6);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expectPresented(page, run.revision);
  await expect(canvas).toHaveAttribute("data-real-producer-canvas", "retained");
  expect(await canvasRoot.getAttribute("data-preview-packet-id")).not.toBe(seekPacket);
  const sliderStep = Number(await scenePlayhead.getAttribute("step"));
  expect(
    Math.abs(
      Number(await canvasRoot.getAttribute("data-preview-sample-time")) - Number(await scenePlayhead.inputValue()),
    ),
  ).toBeLessThanOrEqual(sliderStep / 2);
});

test("preserves real V2 opacity and lifetime boundaries across non-monotonic WebGPU seeks", async ({ page }) => {
  await expectVerifiedRun(await openRealWorkspace(page));
  const run = await expectVerifiedRun(await selectScene(page, "DynamicOpacityLifetimeScene", "scene_dynamic.py"));
  const bundle = run.snapshot?.bundle;
  const revision = run.snapshot?.snapshotHash;
  if (!bundle || !revision) throw new Error("The dynamic Scene did not publish a complete verified snapshot.");
  expect(bundle.scene).toMatchObject({
    duration: 7,
    requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
    source: { kind: "imported-manim-server-snapshot", snapshotVersion: 2 },
  });
  expect(bundle.scene.entities).toHaveLength(1);
  expect(bundle.scene.entities[0]?.lifetimes).toEqual([{ end: 6, start: 1 }]);
  expect(bundle.scene.animationChannels).toMatchObject([
    {
      entityId: bundle.scene.entities[0]?.id,
      keyframes: [
        { at: 1, value: 0 },
        { at: 3, value: 1 },
        { at: 4, value: 1 },
        { at: 6, value: 0 },
      ],
      kind: "opacity",
    },
  ]);
  expect(run.sourceRuntimeIdentity).toMatchObject({
    mappings: [
      {
        binding: {
          id: DYNAMIC_BINDING_ID,
          name: "circle",
          ordinal: 1,
          span: { endColumn: 14, endLine: 6, startColumn: 8, startLine: 6 },
        },
        entityId: DYNAMIC_RUNTIME_ENTITY_ID,
        familyPath: [],
        provenanceId: `${DYNAMIC_SCENE_ID}/provenance:entity:0`,
      },
    ],
    sceneId: DYNAMIC_SCENE_ID,
    snapshotHash: revision,
    sourceHash: DYNAMIC_SOURCE_HASH,
  });
  await expectPresented(page, run.revision);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  const entityId = bundle.scene.entities[0]?.id;
  if (!viewport || !entityId) throw new Error("The dynamic WebGPU proof inputs were incomplete.");
  expect(entityId).toBe(DYNAMIC_RUNTIME_ENTITY_ID);
  expect(viewport).toBe(DYNAMIC_VIEWPORT);
  const samplePlan = [
    { id: "before-start", sampleTime: 59 / 60 },
    { id: "at-start", sampleTime: 1 },
    { id: "after-start", sampleTime: 61 / 60 },
    { id: "a-first", sampleTime: 2 },
    { id: "b", sampleTime: 3 },
    { id: "a-repeat", sampleTime: 2 },
    { id: "before-end", sampleTime: 359 / 60 },
    { id: "at-end", sampleTime: 6 },
    { id: "after-end", sampleTime: 361 / 60 },
    { id: "a-final-rewind", sampleTime: 2 },
  ] as const;
  const samples = await readBackDynamicRendererSamples(page, {
    entityIds: [entityId],
    revision,
    samples: samplePlan,
    snapshot: bundle,
    viewport,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const inactiveSamples = new Set(["before-start", "at-end", "after-end"]);

  for (const planned of samplePlan) {
    const sample = byId.get(planned.id);
    expect(sample?.frame).toMatchObject({
      kind: "frame-presented",
      revision,
      sampleTime: planned.sampleTime,
    });
    expect(sample?.evidence).toMatchObject({
      packetId: sample?.frame.packetId,
      revision,
      sampleTime: planned.sampleTime,
      viewport: sample?.frame.viewport,
    });
    expect(sample?.frame.interaction).toEqual({
      entries: inactiveSamples.has(planned.id)
        ? [{ status: "inactive" }]
        : [{ bounds: DYNAMIC_CLIP_BOUNDS, status: "present" }],
      space: "clip-v1",
      status: "available",
    });
  }

  const center = (id: string) => byId.get(id)?.evidence.samples[0] as RgbaPixel;
  const background = (id: string) => byId.get(id)?.evidence.samples[1] as RgbaPixel;
  for (const id of ["before-start", "at-start", "at-end", "after-end"]) {
    expect(center(id)).toEqual(background(id));
  }
  expect(center("after-start")).not.toEqual(background("after-start"));
  expect(center("before-end")).toEqual(center("after-start"));
  expectPixelNear(center("a-first"), [185, 70, 60, 255]);
  expectPixelNear(center("b"), [252, 98, 85, 255]);
  expect(center("a-repeat")).toEqual(center("a-first"));
  expect(center("a-final-rewind")).toEqual(center("a-first"));

  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(scenePlayhead).toHaveAttribute("max", "7");
  const circle = page.getByRole("button", { name: "Move circle", exact: true });
  const studioId = await circle.getAttribute("data-studio-entity");
  if (!studioId) throw new Error("The dynamic Scene did not expose its source-owned Studio circle.");
  const wrapper = page.locator(`[data-studio-entity-wrapper="${studioId}"]`);
  const hostPackets = new Set<string>();
  for (const sampleTime of [2, 3, 2]) {
    await scenePlayhead.fill(String(sampleTime));
    await expectPresented(page, run.revision);
    await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", DYNAMIC_BINDING_ID);
    await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", DYNAMIC_RUNTIME_ENTITY_ID);
    await expect(wrapper).toHaveAttribute("data-studio-entity-height", "2.5000");
    await expect(wrapper).toHaveAttribute("data-studio-entity-width", "2.5000");
    const circleBox = await circle.boundingBox();
    const canvasBox = await canvasRoot.boundingBox();
    if (!circleBox || !canvasBox) throw new Error("The dynamic runtime hit target was not visible.");
    const centerX = (circleBox.x + circleBox.width / 2 - canvasBox.x) / canvasBox.width;
    const centerY = (circleBox.y + circleBox.height / 2 - canvasBox.y) / canvasBox.height;
    expect(Math.abs(centerX - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(centerY - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(circleBox.width / canvasBox.width - 0.17578125)).toBeLessThan(0.01);
    expect(Math.abs(circleBox.height / canvasBox.height - 0.3125)).toBeLessThan(0.01);
    hostPackets.add((await canvasRoot.getAttribute("data-preview-packet-id")) ?? "");
  }
  expect(hostPackets.size).toBe(3);
});

test("preserves real V2 affine methods and isolates a singular reflection sample", async ({ page }) => {
  await expectVerifiedRun(await openRealWorkspace(page));
  const run = await expectVerifiedRun(await selectScene(page, "DynamicAffineScene", "scene_affine.py"));
  const bundle = run.snapshot?.bundle;
  const revision = run.snapshot?.snapshotHash;
  const identity = run.sourceRuntimeIdentity;
  if (!bundle || !revision || !identity) {
    throw new Error("The affine Scene did not publish a complete verified snapshot and identity map.");
  }

  expect(bundle.scene).toMatchObject({
    duration: 7,
    requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry"],
    sceneId: AFFINE_SCENE_ID,
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotVersion: 2,
      sourceHash: AFFINE_SOURCE_HASH,
    },
  });
  expect(bundle.scene.entities).toHaveLength(7);
  expect(bundle.scene.entities.map((entity) => entity.id)).toEqual(AFFINE_ENTITY_IDS);
  expect(bundle.scene.entities.every((entity) => entity.lifetimes.length === 1)).toBe(true);
  expect(bundle.scene.entities.map((entity) => entity.lifetimes[0])).toEqual(
    Array.from({ length: 7 }, () => ({ end: 7, start: 0 })),
  );

  const channels = bundle.scene.animationChannels;
  expect(channels).toHaveLength(6);
  const expectedEndpoints = [
    [1, 0, 0, 1, 1, 0],
    [0, -1, 1, 0, -5, 1],
    [1.5, 0, 0, 1.5, 0.5, 1],
    [1, 0, 0, 1.5, 0, 1],
    [1, 0.5, 0, 1, 1, 0],
    [-1, 0, 0, 1, 6, 0],
  ] as const;
  for (const [index, channel] of channels.entries()) {
    expect(channel.kind).toBe("affine-transform");
    if (channel.kind !== "affine-transform") throw new Error("Expected only affine-transform channels.");
    const sceneOrder = index + 1;
    expect(channel).toMatchObject({
      entityId: AFFINE_ENTITY_IDS[sceneOrder],
      id: `${AFFINE_SCENE_ID}/channel:affine-transform:${sceneOrder}`,
      keyframes: [
        {
          at: index,
          easingToNext: { kind: "linear" },
          value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
        },
        { at: index + 1, easingToNext: null },
      ],
      provenanceId: `${AFFINE_SCENE_ID}/provenance:channel:affine-transform:${sceneOrder}`,
    });
    const endpoint = channel.keyframes[1]?.value;
    if (!endpoint) throw new Error("An affine producer channel omitted its endpoint.");
    for (const [componentIndex, component] of [
      endpoint.m11,
      endpoint.m12,
      endpoint.m21,
      endpoint.m22,
      endpoint.tx,
      endpoint.ty,
    ].entries()) {
      expect(component).toBeCloseTo(expectedEndpoints[index]![componentIndex]!, 12);
    }
  }

  expect(identity).toMatchObject({
    sceneId: AFFINE_SCENE_ID,
    snapshotHash: revision,
    sourceHash: AFFINE_SOURCE_HASH,
  });
  expect(identity.mappings).toHaveLength(7);
  expect(identity.mappings).toEqual(
    AFFINE_BINDINGS.map(([name, id, endColumn], index) => ({
      binding: {
        id,
        name,
        ordinal: index + 1,
        span: { endColumn, endLine: index + 6, startColumn: 8, startLine: index + 6 },
      },
      entityId: AFFINE_ENTITY_IDS[index],
      familyPath: [],
      provenanceId: `${AFFINE_SCENE_ID}/provenance:entity:${index}`,
    })),
  );
  await expectPresented(page, run.revision);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The affine WebGPU proof did not expose a viewport.");
  const samplePlan = [
    { id: "a-first", sampleTime: 5 },
    { id: "singular", sampleTime: 5.5 },
    { id: "b", sampleTime: 6 },
    { id: "a-repeat", sampleTime: 5 },
  ] as const;
  const samples = await readBackDynamicRendererSamples(page, {
    entityIds: AFFINE_ENTITY_IDS,
    evidenceSamples: [
      { fractionX: 0.1484375, fractionY: 0.125 },
      { fractionX: 0.640625, fractionY: 0.375 },
      { fractionX: 0.78125, fractionY: 0.375 },
      { fractionX: 0.03, fractionY: 0.05 },
    ],
    revision,
    samples: samplePlan,
    snapshot: bundle,
    viewport,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const expectBoundsNear = (actual: readonly number[] | undefined, expected: readonly number[]) => {
    expect(actual).toHaveLength(4);
    for (const [index, component] of (actual ?? []).entries()) {
      expect(component).toBeCloseTo(expected[index]!, 6);
    }
  };

  for (const planned of samplePlan) {
    const sample = byId.get(planned.id);
    expect(sample?.frame).toMatchObject({ kind: "frame-presented", revision, sampleTime: planned.sampleTime });
    expect(sample?.evidence).toMatchObject({
      packetId: sample?.frame.packetId,
      revision,
      sampleTime: planned.sampleTime,
      viewport: sample?.frame.viewport,
    });
    expect(sample?.frame.interaction).toMatchObject({ space: "clip-v1", status: "available" });
    const entries = sample?.frame.interaction.entries;
    expect(entries).toHaveLength(7);
    for (const [index, expectedBounds] of AFFINE_BOUNDS_AT_FIVE.entries()) {
      const entry = entries?.[index];
      if (planned.id === "singular" && index === 6) {
        expect(entry).toEqual({ status: "empty" });
      } else {
        expect(entry?.status).toBe("present");
        if (entry?.status !== "present") throw new Error("Expected a present affine interaction entry.");
        expectBoundsNear(
          entry.bounds,
          planned.id === "b" && index === 6 ? [0.50625, 0.175, 0.61875, 0.325] : expectedBounds,
        );
      }
    }
  }
  expect(byId.get("a-repeat")?.frame.interaction).toEqual(byId.get("a-first")?.frame.interaction);

  const pixels = (id: string) => byId.get(id)?.evidence.samples as readonly RgbaPixel[];
  expectPixelNear(pixels("a-first")[0]!, [255, 255, 255, 255]);
  expectPixelNear(pixels("a-first")[1]!, [252, 98, 85, 255]);
  expectPixelNear(pixels("a-first")[2]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("singular")[0]!, [255, 255, 255, 255]);
  expectPixelNear(pixels("singular")[1]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("singular")[2]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("b")[1]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("b")[2]!, [252, 98, 85, 255]);
  expect(pixels("a-repeat")).toEqual(pixels("a-first"));
  for (const sample of samples) expectPixelNear(sample.evidence.samples[3] as RgbaPixel, [0, 0, 0, 255]);

  await expect(page.getByRole("slider", { name: "Scene playhead" })).toHaveAttribute("max", "7");
});

test("preserves real V2 Create and Uncreate trims across shuffled WebGPU seeks", async ({ page }) => {
  await expectVerifiedRun(await openRealWorkspace(page));
  const run = await expectVerifiedRun(await selectScene(page, "DynamicPathTrimScene", "scene_path_trim.py"));
  const bundle = run.snapshot?.bundle;
  const revision = run.snapshot?.snapshotHash;
  const identity = run.sourceRuntimeIdentity;
  if (!bundle || !revision || !identity) {
    throw new Error("The path-trim Scene did not publish a complete verified snapshot and identity map.");
  }

  expect(bundle.scene).toMatchObject({
    duration: 8,
    requiredCapabilities: ["cubic-path-geometry", "path-trim-animation"],
    sceneId: PATH_TRIM_SCENE_ID,
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotVersion: 2,
      sourceHash: PATH_TRIM_SOURCE_HASH,
    },
  });
  expect(bundle.scene.entities.map((entity) => entity.id)).toEqual(PATH_TRIM_ENTITY_IDS);
  expect(bundle.scene.entities.map((entity) => entity.lifetimes)).toEqual([
    [{ end: 8, start: 0 }],
    [{ end: 8, start: 0 }],
    [{ end: 2, start: 1 }],
    [{ end: 5, start: 2 }],
    [{ end: 7, start: 5 }],
  ]);
  expect(
    bundle.scene.entities.map((entity) =>
      entity.geometry.kind === "cubic-path" ? entity.geometry.path.subpaths[0]?.segments.length : null,
    ),
  ).toEqual([8, 8, 4, 1, 8]);
  expect(bundle.scene.entities[0]?.appearance).toMatchObject({ fill: { color: { alpha: 1 } }, stroke: null });
  for (const entity of bundle.scene.entities.slice(1)) {
    expect(entity.appearance).toMatchObject({ fill: null, stroke: { cap: "butt", join: "miter" } });
  }

  const expectedChannels = [
    { at: [0, 1], entityIndex: 1, values: [0, 1] },
    { at: [1, 2], entityIndex: 2, values: [1, 0] },
    { at: [2, 3, 4, 5], entityIndex: 3, values: [0, 1, 1, 0] },
    { at: [5, 6, 7], entityIndex: 4, values: [0, 1, 0] },
  ] as const;
  expect(bundle.scene.animationChannels).toHaveLength(expectedChannels.length);
  for (const [channelIndex, expectedChannel] of expectedChannels.entries()) {
    const channel = bundle.scene.animationChannels[channelIndex];
    expect(channel).toMatchObject({
      entityId: PATH_TRIM_ENTITY_IDS[expectedChannel.entityIndex],
      id: `${PATH_TRIM_SCENE_ID}/channel:path-trim:${expectedChannel.entityIndex}`,
      kind: "path-trim",
      parameterization: "uniform-cubic-parameter-v1",
      provenanceId: `${PATH_TRIM_SCENE_ID}/provenance:channel:path-trim:${expectedChannel.entityIndex}`,
    });
    if (channel?.kind !== "path-trim") throw new Error("Expected only path-trim producer channels.");
    expect(channel.keyframes.map((keyframe) => keyframe.at)).toEqual(expectedChannel.at);
    expect(channel.keyframes.map((keyframe) => keyframe.value)).toEqual(expectedChannel.values);
    expect(channel.keyframes.map((keyframe) => keyframe.easingToNext)).toEqual([
      ...expectedChannel.at.slice(0, -1).map(() => ({ kind: "linear" as const })),
      null,
    ]);
  }

  expect(identity).toMatchObject({
    sceneId: PATH_TRIM_SCENE_ID,
    snapshotHash: revision,
    sourceHash: PATH_TRIM_SOURCE_HASH,
  });
  expect(identity.mappings).toEqual(
    PATH_TRIM_BINDINGS.map(([name, id, endColumn], index) => ({
      binding: {
        id,
        name,
        ordinal: index + 1,
        span: { endColumn, endLine: index + 6, startColumn: 8, startLine: index + 6 },
      },
      entityId: PATH_TRIM_ENTITY_IDS[index],
      familyPath: [],
      provenanceId: `${PATH_TRIM_SCENE_ID}/provenance:entity:${index}`,
    })),
  );
  await expectPresented(page, run.revision);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The path-trim WebGPU proof did not expose a viewport.");
  expect(viewport).toBe(PATH_TRIM_VIEWPORT);
  const monotonicTimes = [0, 1.5, 2, 2.5, 3.5, 4.5, 5, 5.5, 6, 6.5, 7] as const;
  const shuffledTimes = [4.5, 0, 6.5, 2, 5.5, 1.5, 7, 3.5, 5, 2.5, 6] as const;
  const samples = await readBackDynamicRendererSamples(page, {
    entityIds: PATH_TRIM_ENTITY_IDS,
    evidenceSamples: [
      { fractionX: 0.1484375, fractionY: 0.125 },
      { fractionX: 0.341796875, fractionY: 0.5 },
      { fractionX: 0.4296875, fractionY: 0.4375 },
      { fractionX: 0.640625, fractionY: 0.5 },
      { fractionX: 0.826953125, fractionY: 0.5 },
      { fractionX: 0.03, fractionY: 0.05 },
    ],
    revision,
    samples: [
      ...monotonicTimes.map((sampleTime) => ({ id: `monotonic:${sampleTime}`, sampleTime })),
      ...shuffledTimes.map((sampleTime) => ({ id: `shuffled:${sampleTime}`, sampleTime })),
    ],
    snapshot: bundle,
    viewport,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  for (const sampleTime of monotonicTimes) {
    const monotonic = byId.get(`monotonic:${sampleTime}`);
    const shuffled = byId.get(`shuffled:${sampleTime}`);
    expect(monotonic?.frame).toMatchObject({ kind: "frame-presented", revision, sampleTime });
    expect(monotonic?.evidence).toMatchObject({
      packetId: monotonic?.frame.packetId,
      revision,
      sampleTime,
      viewport: monotonic?.frame.viewport,
    });
    expect(shuffled?.frame.interaction).toEqual(monotonic?.frame.interaction);
    expect(shuffled?.evidence.samples).toEqual(monotonic?.evidence.samples);
  }

  const interactionEntries = (sampleTime: (typeof monotonicTimes)[number]) =>
    byId.get(`monotonic:${sampleTime}`)?.frame.interaction.entries;
  const pixels = (sampleTime: (typeof monotonicTimes)[number]) =>
    byId.get(`monotonic:${sampleTime}`)?.evidence.samples as readonly RgbaPixel[];
  const expectBoundsNear = (actual: readonly number[] | undefined, expected: readonly number[]) => {
    expect(actual).toHaveLength(4);
    for (const [index, component] of (actual ?? []).entries()) {
      expect(component).toBeCloseTo(expected[index]!, 6);
    }
  };

  expect(interactionEntries(0)).toEqual([
    { bounds: [-0.7523438, 0.6625, -0.6539062, 0.8375], status: "present" },
    { status: "empty" },
    { status: "inactive" },
    { status: "inactive" },
    { status: "inactive" },
  ]);
  expectPixelNear(pixels(0)[0]!, [255, 255, 255, 255]);
  for (const pixel of pixels(0).slice(1)) expectPixelNear(pixel, [0, 0, 0, 255]);

  const rectangleHalf = interactionEntries(1.5)?.[2];
  expect(rectangleHalf?.status).toBe("present");
  if (rectangleHalf?.status === "present") {
    expectBoundsNear(rectangleHalf.bounds, [-0.27421874, -0.125, -0.03515625, 0.175]);
  }
  expectPixelNear(pixels(1.5)[1]!, [252, 98, 85, 255]);
  expectPixelNear(pixels(1.5)[2]!, [88, 196, 221, 255]);

  expect(interactionEntries(2)?.[2]).toEqual({ status: "inactive" });
  expect(interactionEntries(2)?.[3]).toEqual({ status: "empty" });
  expectPixelNear(pixels(2)[0]!, [255, 255, 255, 255]);
  expectPixelNear(pixels(2)[1]!, [252, 98, 85, 255]);
  expectPixelNear(pixels(2)[3]!, [0, 0, 0, 255]);

  const lineCreateHalf = interactionEntries(2.5)?.[3];
  expect(lineCreateHalf?.status).toBe("present");
  if (lineCreateHalf?.status === "present") {
    expectBoundsNear(lineCreateHalf.bounds, [0.12804712, -0.16972136, 0.2938279, 0.044721358]);
  }
  expectPixelNear(pixels(3.5)[3]!, [131, 193, 103, 255]);
  expect(interactionEntries(4.5)?.[3]).toEqual(lineCreateHalf);

  expect(interactionEntries(5)?.[3]).toEqual({ status: "inactive" });
  expect(interactionEntries(5)?.[4]).toEqual({ status: "empty" });
  const immediateCreateHalf = interactionEntries(5.5)?.[4];
  expect(immediateCreateHalf?.status).toBe("present");
  if (immediateCreateHalf?.status === "present") {
    expectBoundsNear(immediateCreateHalf.bounds, [0.44310543, -0.0049230703, 0.6818946, 0.21274413]);
  }
  expectPixelNear(pixels(6)[4]!, [247, 217, 111, 255]);
  expect(interactionEntries(6.5)?.[4]).toEqual(immediateCreateHalf);

  expect(interactionEntries(7)?.[4]).toEqual({ status: "inactive" });
  expect(interactionEntries(7)?.[0]?.status).toBe("present");
  expectPixelNear(pixels(7)[0]!, [255, 255, 255, 255]);
  expectPixelNear(pixels(7)[1]!, [252, 98, 85, 255]);
  expectPixelNear(pixels(7)[4]!, [0, 0, 0, 255]);
  await expect(page.getByRole("slider", { name: "Scene playhead" })).toHaveAttribute("max", "8");
});

test("renders real compatible path morphs deterministically through retained WebGPU", async ({ page }) => {
  await expectVerifiedRun(await openRealWorkspace(page));
  const run = await expectVerifiedRun(await selectScene(page, "DynamicPathMorphScene", "scene_path_morph.py"));
  const bundle = run.snapshot?.bundle;
  const revision = run.snapshot?.snapshotHash;
  const identity = run.sourceRuntimeIdentity;
  if (!bundle || !revision || !identity) {
    throw new Error("The path-morph Scene did not publish a complete verified snapshot and identity map.");
  }

  expect(bundle.scene).toMatchObject({
    duration: 5,
    requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
    sceneId: PATH_MORPH_SCENE_ID,
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotVersion: 2,
      sourceHash: PATH_MORPH_SOURCE_HASH,
    },
  });
  expect(bundle.scene.entities.map((entity) => entity.id)).toEqual(PATH_MORPH_ENTITY_IDS);
  expect(bundle.scene.entities.map((entity) => entity.lifetimes)).toEqual(
    Array.from({ length: 3 }, () => [{ end: 5, start: 0 }]),
  );
  expect(
    bundle.scene.entities.map((entity) =>
      entity.geometry.kind === "cubic-path" ? entity.geometry.path.subpaths[0]?.segments.length : null,
    ),
  ).toEqual([8, 8, 1]);

  const [shapeMorph, lineMorph] = bundle.scene.animationChannels;
  expect(bundle.scene.animationChannels).toHaveLength(2);
  if (shapeMorph?.kind !== "path-morph" || lineMorph?.kind !== "path-morph") {
    throw new Error("Expected only path-morph producer channels.");
  }
  expect(shapeMorph).toMatchObject({
    entityId: PATH_MORPH_ENTITY_IDS[1],
    id: `${PATH_MORPH_SCENE_ID}/channel:path-morph:1`,
    provenanceId: `${PATH_MORPH_SCENE_ID}/provenance:channel:path-morph:1`,
  });
  expect(shapeMorph.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 1, 2, 3]);
  expect(shapeMorph.keyframes[0]?.value).toEqual(bundle.scene.entities[1]?.geometry.path);
  expect(shapeMorph.keyframes[0]?.value).toEqual(shapeMorph.keyframes[3]?.value);
  expect(shapeMorph.keyframes[0]?.value).not.toEqual(shapeMorph.keyframes[1]?.value);
  expect(shapeMorph.keyframes[1]?.value).toEqual(shapeMorph.keyframes[2]?.value);
  expect(lineMorph).toMatchObject({
    entityId: PATH_MORPH_ENTITY_IDS[2],
    id: `${PATH_MORPH_SCENE_ID}/channel:path-morph:2`,
    provenanceId: `${PATH_MORPH_SCENE_ID}/provenance:channel:path-morph:2`,
  });
  expect(lineMorph.keyframes.map((keyframe) => keyframe.at)).toEqual([3, 4]);
  expect(lineMorph.keyframes[0]?.value).not.toEqual(lineMorph.keyframes[1]?.value);
  expect(identity.mappings.map((mapping) => [mapping.binding.name, mapping.entityId])).toEqual([
    ["sentinel", PATH_MORPH_ENTITY_IDS[0]],
    ["shape", PATH_MORPH_ENTITY_IDS[1]],
    ["line", PATH_MORPH_ENTITY_IDS[2]],
  ]);
  await expectPresented(page, run.revision);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The path-morph WebGPU proof did not expose a viewport.");
  expect(viewport).toBe(PATH_TRIM_VIEWPORT);
  const checkpoints = [
    { id: "initial", sampleTime: 0 },
    { id: "warped", sampleTime: 1 },
    { id: "hold", sampleTime: 1.5 },
    { id: "returning", sampleTime: 2.5 },
    { id: "restored", sampleTime: 3 },
    { id: "line-half", sampleTime: 3.5 },
    { id: "line-target", sampleTime: 4 },
  ] as const;
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const shuffledCheckpointIds = [
    "hold",
    "line-target",
    "initial",
    "returning",
    "warped",
    "line-half",
    "restored",
  ] as const;
  const samplePlan = [
    ...checkpoints.map((checkpoint) => ({ id: `monotonic:${checkpoint.id}`, sampleTime: checkpoint.sampleTime })),
    ...shuffledCheckpointIds.map((id) => ({
      id: `shuffled:${id}`,
      sampleTime: checkpointById.get(id)!.sampleTime,
    })),
  ];
  const samples = await readBackDynamicRendererSamples(page, {
    entityIds: PATH_MORPH_ENTITY_IDS,
    evidenceSamples: [
      { fractionX: 0.1484375, fractionY: 0.125 },
      { fractionX: 0.39453125, fractionY: 0.5 },
      { fractionX: 0.33125, fractionY: 0.5 },
      { fractionX: 0.39453125, fractionY: 0.7714285714285715 },
      { fractionX: 0.482421875, fractionY: 0.8375 },
      { fractionX: 0.03, fractionY: 0.05 },
    ],
    revision,
    samples: samplePlan,
    snapshot: bundle,
    viewport,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  type CheckpointId = (typeof checkpoints)[number]["id"];
  const result = (order: "monotonic" | "shuffled", id: CheckpointId) => {
    const sample = byId.get(`${order}:${id}`);
    if (!sample) throw new Error(`Missing ${order} WebGPU evidence for ${id}.`);
    return sample;
  };
  const entries = (id: CheckpointId) => result("monotonic", id).frame.interaction.entries;
  const pixels = (id: CheckpointId) => result("monotonic", id).evidence.samples as readonly RgbaPixel[];
  for (const checkpoint of checkpoints) {
    const monotonic = result("monotonic", checkpoint.id);
    const shuffled = result("shuffled", checkpoint.id);
    expect(monotonic.frame).toMatchObject({
      kind: "frame-presented",
      revision,
      sampleTime: checkpoint.sampleTime,
    });
    expect(monotonic.frame.interaction.entries.every((entry) => entry.status === "present")).toBe(true);
    expect(shuffled.frame).toMatchObject({
      kind: "frame-presented",
      revision,
      sampleTime: checkpoint.sampleTime,
    });
    expect(shuffled.frame.interaction.entries).toEqual(monotonic.frame.interaction.entries);
    expect(shuffled.evidence.samples).toEqual(monotonic.evidence.samples);
    expectPixelNear(pixels(checkpoint.id)[0]!, [255, 255, 255, 255]);
    expectPixelNear(pixels(checkpoint.id)[1]!, [88, 196, 221, 255]);
    expectPixelNear(pixels(checkpoint.id)[5]!, [0, 0, 0, 255]);
  }
  expect(entries("hold")?.[1]).toEqual(entries("warped")?.[1]);
  expect(entries("warped")?.[1]).not.toEqual(entries("initial")?.[1]);
  expect(entries("returning")?.[1]).not.toEqual(entries("warped")?.[1]);
  expect(entries("returning")?.[1]).not.toEqual(entries("restored")?.[1]);
  expect(entries("restored")?.[1]).toEqual(entries("initial")?.[1]);
  expect(entries("line-half")?.[2]).not.toEqual(entries("restored")?.[2]);
  expect(entries("line-half")?.[2]).not.toEqual(entries("line-target")?.[2]);
  expect(entries("line-target")?.[2]).not.toEqual(entries("restored")?.[2]);
  expectPixelNear(pixels("initial")[2]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("warped")[2]!, [88, 196, 221, 255]);
  expectPixelNear(pixels("hold")[2]!, [88, 196, 221, 255]);
  expectPixelNear(pixels("returning")[2]!, [88, 196, 221, 255]);
  expectPixelNear(pixels("restored")[2]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("restored")[3]!, [252, 98, 85, 255]);
  expectPixelNear(pixels("line-target")[3]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("line-target")[4]!, [252, 98, 85, 255]);
  await expect(page.getByRole("slider", { name: "Scene playhead" })).toHaveAttribute("max", "5");
});

test("renders real Manim MoveAlongPath sampling across shuffled retained WebGPU seeks", async ({ page }) => {
  await expectVerifiedRun(await openRealWorkspace(page));
  const run = await expectVerifiedRun(await selectScene(page, "DynamicMotionPathScene", "scene_motion_path.py"));
  const bundle = run.snapshot?.bundle;
  const revision = run.snapshot?.snapshotHash;
  const identity = run.sourceRuntimeIdentity;
  if (!bundle || !revision || !identity) {
    throw new Error("The motion-path Scene did not publish a complete verified snapshot and identity map.");
  }

  expect(bundle.scene).toMatchObject({
    duration: 3,
    requiredCapabilities: ["cubic-path-geometry", "motion-path-animation"],
    sceneId: MOTION_PATH_SCENE_ID,
    source: { snapshotVersion: 2, sourceHash: MOTION_PATH_SOURCE_HASH },
  });
  expect(bundle.scene.entities.map((entity) => entity.id)).toEqual(MOTION_PATH_ENTITY_IDS);
  expect(
    bundle.scene.entities.map((entity) =>
      entity.geometry.kind === "cubic-path" ? entity.geometry.path.subpaths[0]?.segments.length : null,
    ),
  ).toEqual([8, 4, 8]);
  expect(identity.mappings.map((mapping) => [mapping.binding.name, mapping.entityId])).toEqual([
    ["sentinel", MOTION_PATH_ENTITY_IDS[0]],
    ["rectangle", MOTION_PATH_ENTITY_IDS[1]],
    ["circle", MOTION_PATH_ENTITY_IDS[2]],
  ]);

  const [openMotion, closedMotion] = bundle.scene.animationChannels;
  if (openMotion?.kind !== "motion-path" || closedMotion?.kind !== "motion-path") {
    throw new Error("Expected only motion-path producer channels.");
  }
  for (const [channel, entityIndex, times] of [
    [openMotion, 1, [0, 1]],
    [closedMotion, 2, [1, 2]],
  ] as const) {
    expect(channel).toMatchObject({
      entityId: MOTION_PATH_ENTITY_IDS[entityIndex],
      id: `${MOTION_PATH_SCENE_ID}/channel:motion-path:${entityIndex}`,
      orientToPath: false,
      parameterization: "manim-point-from-proportion-v1",
      provenanceId: `${MOTION_PATH_SCENE_ID}/provenance:channel:motion-path:${entityIndex}`,
    });
    expect(channel.keyframes.map((keyframe) => keyframe.at)).toEqual(times);
  }
  expect(openMotion.path.subpaths[0]).toMatchObject({ closed: false, start: { x: -4, y: -1 } });
  expect(openMotion.path.subpaths[0]?.segments).toHaveLength(1);
  const closedSubpath = closedMotion.path.subpaths[0]!;
  expect(closedSubpath.closed).toBe(true);
  expect(closedSubpath.segments).toHaveLength(8);
  expect(closedSubpath.segments.at(-1)?.end).not.toEqual(closedSubpath.start);

  await expectPresented(page, run.revision);
  const viewport = await page.locator("[data-studio-canvas]").getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The motion-path WebGPU proof did not expose a viewport.");
  expect(viewport).toBe(PATH_TRIM_VIEWPORT);
  const checkpoints = [
    { circle: null, id: "initial", rectangle: [-0.58359375, -0.275, -0.54140625, -0.225], sampleTime: 0 },
    {
      circle: null,
      id: "curve-quarter",
      rectangle: [-0.45505371, 0.066796875, -0.41286621, 0.116796875],
      sampleTime: 0.25,
    },
    { circle: null, id: "curve-half", rectangle: [-0.29355469, 0.021875, -0.25136719, 0.071875], sampleTime: 0.5 },
    {
      circle: null,
      id: "curve-three-quarter",
      rectangle: [-0.11887207, -0.046484375, -0.07668457, 0.003515625],
      sampleTime: 0.75,
    },
    {
      circle: [0.5484375, -0.075, 0.6328125, 0.075],
      id: "orbit-start",
      rectangle: [0.04921875, 0.225, 0.09140625, 0.275],
      sampleTime: 1,
    },
    {
      circle: [0.2109375, -0.075, 0.2953125, 0.075],
      id: "orbit-half",
      rectangle: [0.04921875, 0.225, 0.09140625, 0.275],
      sampleTime: 1.5,
    },
    {
      circle: [0.5484375, -0.075, 0.6328125, 0.075],
      id: "orbit-end",
      rectangle: [0.04921875, 0.225, 0.09140625, 0.275],
      sampleTime: 2,
    },
  ] as const;
  const shuffled = [
    "orbit-half",
    "initial",
    "orbit-end",
    "curve-quarter",
    "orbit-start",
    "curve-half",
    "curve-three-quarter",
  ];
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const samples = await readBackDynamicRendererSamples(page, {
    entityIds: MOTION_PATH_ENTITY_IDS,
    evidenceSamples: [
      { fractionX: 0.1484375, fractionY: 0.125 },
      { fractionX: 0.28302001953125, fractionY: 0.4541015625 },
      { fractionX: 0.53515625, fractionY: 0.375 },
      { fractionX: 0.7953125, fractionY: 0.5 },
      { fractionX: 0.6265625, fractionY: 0.5 },
      { fractionX: 0.2679854142423624, fractionY: 0.4676737818992146 },
      { fractionX: 0.03, fractionY: 0.05 },
    ],
    revision,
    samples: [
      ...checkpoints.map(({ id, sampleTime }) => ({ id: `monotonic:${id}`, sampleTime })),
      ...shuffled.map((id) => ({ id: `shuffled:${id}`, sampleTime: checkpointById.get(id)!.sampleTime })),
    ],
    snapshot: bundle,
    viewport,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const expectBoundsNear = (actual: readonly number[] | undefined, expected: readonly number[]) => {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 6));
  };
  for (const checkpoint of checkpoints) {
    const monotonic = byId.get(`monotonic:${checkpoint.id}`)!;
    const shuffledSample = byId.get(`shuffled:${checkpoint.id}`)!;
    expect(shuffledSample.frame.interaction).toEqual(monotonic.frame.interaction);
    expect(shuffledSample.evidence.samples).toEqual(monotonic.evidence.samples);
    expectBoundsNear(monotonic.frame.interaction.entries[1]?.bounds, checkpoint.rectangle);
    if (checkpoint.circle === null) expect(monotonic.frame.interaction.entries[2]).toEqual({ status: "inactive" });
    else expectBoundsNear(monotonic.frame.interaction.entries[2]?.bounds, checkpoint.circle);
    expectPixelNear(monotonic.evidence.samples[0] as RgbaPixel, [255, 255, 255, 255]);
    expectPixelNear(monotonic.evidence.samples[6] as RgbaPixel, [0, 0, 0, 255]);
  }
  const pixels = (id: string) => byId.get(`monotonic:${id}`)!.evidence.samples as readonly RgbaPixel[];
  expectPixelNear(pixels("curve-quarter")[1]!, [88, 196, 221, 255]);
  expectPixelNear(pixels("curve-quarter")[5]!, [0, 0, 0, 255]);
  expectPixelNear(pixels("orbit-start")[2]!, [88, 196, 221, 255]);
  expectPixelNear(pixels("orbit-start")[3]!, [252, 98, 85, 255]);
  expectPixelNear(pixels("orbit-half")[4]!, [252, 98, 85, 255]);
  expectPixelNear(pixels("orbit-end")[3]!, [252, 98, 85, 255]);

  const legacy = structuredClone(bundle);
  const legacyOpenMotion = legacy.scene.animationChannels[0];
  if (legacyOpenMotion?.kind !== "motion-path") throw new Error("Expected the cloned open motion-path channel.");
  legacyOpenMotion.parameterization = "arc-length-v1";
  const [legacyQuarter] = await readBackDynamicRendererSamples(page, {
    entityIds: MOTION_PATH_ENTITY_IDS,
    evidenceSamples: [
      { fractionX: 0.28302001953125, fractionY: 0.4541015625 },
      { fractionX: 0.2679854142423624, fractionY: 0.4676737818992146 },
    ],
    revision,
    samples: [{ id: "legacy-quarter", sampleTime: 0.25 }],
    snapshot: legacy,
    viewport,
  });
  expect(legacyQuarter?.frame.interaction.entries[1]).not.toEqual(
    byId.get("monotonic:curve-quarter")?.frame.interaction.entries[1],
  );
  expectPixelNear(legacyQuarter?.evidence.samples[0] as RgbaPixel, [0, 0, 0, 255]);
  expectPixelNear(legacyQuarter?.evidence.samples[1] as RgbaPixel, [88, 196, 221, 255]);
  await expect(page.getByRole("slider", { name: "Scene playhead" })).toHaveAttribute("max", "3");
});

test("falls back the whole Scene for real producer unsupported and exit results", async ({ page }) => {
  await expectRunStatus(await openRealWorkspace(page), "verified");

  const unsupported = await expectRunStatus(
    await selectScene(page, "UnsupportedPreviewScene", "scene_unsupported.py"),
    "unsupported",
  );
  expect(unsupported.failure).toBeUndefined();
  await expectWholeSceneFallback(page, "unsupported");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();

  const failed = await expectRunStatus(await selectScene(page, "FailedPreviewScene", "scene_failed.py"), "failed");
  expect(failed.failure?.code).toBe("producer-exit");
  await expectWholeSceneFallback(page, "failed");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";
import { withGeneratedRuntimeTraceCairoReferenceV1 } from "./runtime-trace-cairo-reference-runner";
import { captureRetainedWebGpuFramesV1 } from "./runtime-trace-webgpu-readback";
import {
  compareSquareToCircleCairoWebGpuFramesV1,
  type SquareToCircleWebGpuFrameV1,
} from "./square-to-circle-cairo-parity";
import { SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1 } from "./square-to-circle-cairo-reference";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_LABEL = `${SOURCE_PATH} · SquareToCircle`;
const OFFICIAL_SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME = 1.5119159473817447;
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
const FORWARD_SAMPLE_TIMES = [0, 0.5, 1, 1.5, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME, 2, 2.5, 3] as const;
const RANDOM_SAMPLE_TIMES = [
  2.5,
  0.5,
  CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
  1,
  2,
  0,
  1.5,
  3,
  CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
] as const;
const CAIRO_PARITY_REQUIRED = process.env.POIETRA_SQUARE_TO_CIRCLE_CAIRO_PARITY_REQUIRED === "1";
const CAIRO_READBACK_SAMPLES = SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1.map(([id, sampleTime]) => ({
  id,
  packetId: `square-to-circle:full-rgba:${id}`,
  sampleTime,
}));

type SnapshotRunBody = Readonly<{
  revision?: number;
  sceneName?: string;
  snapshot?: Readonly<{ bundle?: SceneIrBundleV1; snapshotHash?: string }>;
  sourcePath?: string;
  sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
  status?: string;
}>;

type SceneEntityV1 = SceneIrBundleV1["scene"]["entities"][number];
type CubicPathV1 = Extract<SceneEntityV1["geometry"], { kind: "cubic-path" }>["path"];

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function openOfficialSquareToCircle(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function verifiedSnapshot(page: Page) {
  const response = await openOfficialSquareToCircle(page);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as SnapshotRunBody;
  expect(body).toMatchObject({ sceneName: "SquareToCircle", sourcePath: SOURCE_PATH, status: "verified" });
  if (
    !body.snapshot?.bundle ||
    !body.snapshot.snapshotHash ||
    !body.sourceRuntimeIdentity ||
    typeof body.revision !== "number"
  ) {
    throw new Error("The verified official SquareToCircle V8 snapshot is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

async function waitForNewPresentedFrame(page: Page, previousRevision: string, previousPacket: string) {
  const canvas = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const [phase, revision, packet, reason] = await Promise.all([
          canvas.getAttribute("data-preview-renderer"),
          canvas.getAttribute("data-preview-revision"),
          canvas.getAttribute("data-preview-packet-id"),
          canvas.getAttribute("data-preview-fallback-reason"),
        ]);
        return phase === "presented" && revision && revision !== previousRevision && packet && packet !== previousPacket
          ? "presented"
          : JSON.stringify({ packet, phase, reason, revision });
      },
      { timeout: 30_000 },
    )
    .toBe("presented");
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The SquareToCircle edit target is not visible.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y);
  await page.mouse.up();
}

async function exportedSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported SquareToCircle candidate source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

async function renderCommitAndFreshSnapshot(page: Page) {
  const render = page.getByRole("button", { name: "Render program" });
  await expect(render).toBeEnabled();
  await render.click();
  const commit = page.getByRole("button", { name: "Commit to source" });
  await expect(commit).toBeVisible({ timeout: 180_000 });
  await expect(commit).toBeEnabled();
  await expect(page.getByLabel("Rendered Manim preview of SquareToCircle")).toBeVisible();
  await commit.click();
  const dialog = page.getByRole("alertdialog", { name: "Commit rendered program?" });
  await expect(dialog).toBeVisible();
  const mutationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/api/manim/renders/") &&
      new URL(response.url()).pathname.endsWith("/commit"),
  );
  const editedSnapshotResponse = snapshotResponse(page);
  await dialog.getByRole("button", { name: "Commit source" }).click();
  const mutation = await mutationResponse;
  expect(mutation.ok(), `Commit returned HTTP ${mutation.status()}.`).toBe(true);
  const response = await editedSnapshotResponse;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as SnapshotRunBody;
  expect(body).toMatchObject({ sceneName: "SquareToCircle", sourcePath: SOURCE_PATH, status: "verified" });
  if (
    !body.snapshot?.bundle ||
    !body.snapshot.snapshotHash ||
    !body.sourceRuntimeIdentity ||
    typeof body.revision !== "number"
  ) {
    throw new Error("The committed SquareToCircle source did not publish a complete edited V8 snapshot.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

function expectPointTranslation(
  before: Readonly<{ x: number; y: number }>,
  after: Readonly<{ x: number; y: number }>,
  translation: Readonly<{ x: number; y: number }>,
) {
  expect(after.x - before.x).toBeCloseTo(translation.x, 10);
  expect(after.y - before.y).toBeCloseTo(translation.y, 10);
}

function expectPathTranslation(
  before: CubicPathV1,
  after: CubicPathV1,
  translation: Readonly<{ x: number; y: number }>,
) {
  expect(after.subpaths).toHaveLength(before.subpaths.length);
  for (const [subpathIndex, beforeSubpath] of before.subpaths.entries()) {
    const afterSubpath = after.subpaths[subpathIndex];
    if (!afterSubpath) throw new Error(`The edited V8 path lost subpath ${subpathIndex}.`);
    expect(afterSubpath.closed).toBe(beforeSubpath.closed);
    expect(afterSubpath.segments).toHaveLength(beforeSubpath.segments.length);
    expectPointTranslation(beforeSubpath.start, afterSubpath.start, translation);
    for (const [segmentIndex, beforeSegment] of beforeSubpath.segments.entries()) {
      const afterSegment = afterSubpath.segments[segmentIndex];
      if (!afterSegment) throw new Error(`The edited V8 path lost segment ${subpathIndex}:${segmentIndex}.`);
      expectPointTranslation(beforeSegment.control1, afterSegment.control1, translation);
      expectPointTranslation(beforeSegment.control2, afterSegment.control2, translation);
      expectPointTranslation(beforeSegment.end, afterSegment.end, translation);
    }
  }
}

function expectFreshV8Translation(
  before: SceneIrBundleV1,
  after: SceneIrBundleV1,
  translation: Readonly<{ x: number; y: number }>,
) {
  expect(after.assets).toEqual(before.assets);
  expect(after.scene).toMatchObject({
    camera: before.scene.camera,
    coordinateSpace: before.scene.coordinateSpace,
    duration: before.scene.duration,
    fidelity: before.scene.fidelity,
    requiredCapabilities: before.scene.requiredCapabilities,
    sceneId: before.scene.sceneId,
  });
  expect(after.scene.entities).toHaveLength(1);
  const beforeEntity = before.scene.entities[0];
  const afterEntity = after.scene.entities[0];
  if (beforeEntity?.geometry.kind !== "cubic-path" || afterEntity?.geometry.kind !== "cubic-path") {
    throw new Error("The official and edited V8 entities must both retain cubic geometry.");
  }
  expect(afterEntity).toMatchObject({
    appearance: beforeEntity.appearance,
    id: beforeEntity.id,
    lifetimes: beforeEntity.lifetimes,
    parentId: beforeEntity.parentId,
    provenanceId: beforeEntity.provenanceId,
    sceneOrder: beforeEntity.sceneOrder,
    sourceZIndex: beforeEntity.sourceZIndex,
    transform: beforeEntity.transform,
  });
  expectPathTranslation(beforeEntity.geometry.path, afterEntity.geometry.path, translation);

  expect(after.scene.animationChannels).toHaveLength(before.scene.animationChannels.length);
  for (const [index, beforeChannel] of before.scene.animationChannels.entries()) {
    const afterChannel = after.scene.animationChannels[index];
    if (!afterChannel || beforeChannel.kind !== afterChannel.kind) {
      throw new Error(`The edited V8 channel ${index} changed kind or disappeared.`);
    }
    expect(afterChannel).toMatchObject({
      entityId: beforeChannel.entityId,
      id: beforeChannel.id,
      kind: beforeChannel.kind,
      provenanceId: beforeChannel.provenanceId,
    });
    if (beforeChannel.kind === "path-morph" && afterChannel.kind === "path-morph") {
      expect(afterChannel.keyframes).toHaveLength(beforeChannel.keyframes.length);
      for (const [keyframeIndex, beforeKeyframe] of beforeChannel.keyframes.entries()) {
        const afterKeyframe = afterChannel.keyframes[keyframeIndex];
        if (!afterKeyframe) throw new Error(`The edited V8 morph lost keyframe ${keyframeIndex}.`);
        expect(afterKeyframe.at).toBe(beforeKeyframe.at);
        expect(afterKeyframe.easingToNext).toEqual(beforeKeyframe.easingToNext);
        expectPathTranslation(beforeKeyframe.value, afterKeyframe.value, translation);
      }
    } else {
      expect(afterChannel).toEqual(beforeChannel);
    }
  }
  expect(after.scene.provenance.map(({ id, origin }) => ({ id, origin }))).toEqual(
    before.scene.provenance.map(({ id, origin }) => ({ id, origin })),
  );
}

function presentBounds(sample: Awaited<ReturnType<typeof retainedWebGpuSamples>>[number] | undefined) {
  const entry = sample?.frame.interaction.entries[0];
  if (entry?.status !== "present") throw new Error("The V8 comparison sample has no presented interaction bounds.");
  return entry.bounds;
}

async function retainedWebGpuSamples(
  page: Page,
  input: Readonly<{
    entityId: string;
    revision: string;
    samples: readonly Readonly<{ id: string; sampleTime: number }>[];
    snapshot: SceneIrBundleV1;
  }>,
) {
  return page.evaluate(
    async ({ entityId, revision, samples, snapshot, viewport }) => {
      const canvas = Object.assign(document.createElement("canvas"), {
        height: viewport.heightPx,
        width: viewport.widthPx,
      });
      const { PoietraCanvasWorkerClient } = (await import(
        "/src/engine/canvas-worker-client.ts"
      )) as typeof import("../src/engine/canvas-worker-client");
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        "/src/engine/canvas-worker-evidence.ts"
      )) as typeof import("../src/engine/canvas-worker-evidence");
      const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
      try {
        await client.installScene({ canvas, revision, snapshot });
        const { center, frameHeight, frameWidth } = snapshot.scene.camera.view;
        const evidencePoints = [
          { x: 0, y: 0 },
          { x: -Math.SQRT2, y: 0 },
          { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
          { x: 0, y: Math.SQRT2 },
          { x: Math.SQRT1_2, y: Math.SQRT1_2 },
          { x: Math.SQRT2, y: 0 },
          { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
          { x: 0, y: -Math.SQRT2 },
          { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: -1, y: 0 },
          { x: 0, y: -1 },
          { x: 0.5, y: 0 },
          { x: 0, y: 0.5 },
          { x: 5, y: 3 },
        ].map(({ x, y }) => ({
          fractionX: 0.5 + (x - center.x) / frameWidth,
          fractionY: 0.5 - (y - center.y) / frameHeight,
        }));
        const results = [];
        for (const sample of samples) {
          const frame = await client.render({
            interactionEntityIds: [entityId],
            revision,
            sampleTime: sample.sampleTime,
            viewport,
          });
          const evidence = await client.captureFrameEvidence({ revision, samples: evidencePoints });
          results.push({ evidence, frame, id: sample.id });
        }
        return results;
      } finally {
        client.dispose();
      }
    },
    { ...input, viewport: VIEWPORT },
  );
}

function isOpaqueBlack(pixel: readonly number[]) {
  return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
}

function hasVisiblePixel(samples: readonly (readonly number[])[]) {
  return samples.some(([red = 0, green = 0, blue = 0]) => Math.max(red, green, blue) > 8);
}

async function compareWithIndependentCairo(
  frames: readonly SquareToCircleWebGpuFrameV1[],
  candidate?: Readonly<{ sourceHash: string; sourceText: string }>,
) {
  const outputRoot =
    process.env.POIETRA_SQUARE_TO_CIRCLE_CAIRO_PARITY_OUTPUT_DIR ?? "test-results/square-to-circle-cairo-parity";
  return withGeneratedRuntimeTraceCairoReferenceV1({
    generatorPath: "scripts/generate-square-to-circle-cairo-reference.py",
    read: (referenceRoot) =>
      compareSquareToCircleCairoWebGpuFramesV1({
        cairoReferenceRoot: referenceRoot,
        expectedSourceSha256: candidate?.sourceHash ?? OFFICIAL_SOURCE_SHA256,
        frames,
        outputRoot: `${outputRoot}/${candidate ? "candidate" : "official"}`,
      }),
    ...(candidate ? { sourceText: candidate.sourceText } : {}),
    temporaryPrefix: "poietra-square-to-circle-cairo-parity-",
  });
}

async function expectIndependentCairoParity(
  page: Page,
  input: Readonly<{
    bundle: SceneIrBundleV1;
    candidate?: Readonly<{ sourceHash: string; sourceText: string }>;
    revision: string;
  }>,
) {
  const capture = await captureRetainedWebGpuFramesV1(page, {
    bundle: input.bundle,
    revision: input.revision,
    samples: CAIRO_READBACK_SAMPLES,
    viewport: VIEWPORT,
  });
  expect(capture.capture).toEqual({
    installCount: 1,
    policy: "one-retained-engine",
    renderSubmissionCounts: CAIRO_READBACK_SAMPLES.map(() => 1),
  });
  const frames = capture.frames.map((frame) => ({
    id: frame.id as SquareToCircleWebGpuFrameV1["id"],
    rgba: frame.rgba,
    sampleTime: frame.requestSampleTime,
  }));
  const comparisons = await compareWithIndependentCairo(frames, input.candidate);
  expect(
    comparisons.filter(({ passed }) => !passed),
    JSON.stringify(comparisons, null, 2),
  ).toEqual([]);
}

test("round-trips an official SquareToCircle V8 position edit through real Manim and retained WebGPU", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const run = await verifiedSnapshot(page);
  expect(run.bundle.scene).toMatchObject({
    duration: 3,
    requiredCapabilities: [
      "cubic-path-geometry",
      "opacity-animation",
      "path-morph-animation",
      "path-trim-animation",
      "vector-appearance-animation",
    ],
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotHash: run.snapshotHash,
      snapshotVersion: 8,
      sourceHash: OFFICIAL_SOURCE_SHA256,
    },
  });
  expect(run.bundle.scene.entities).toHaveLength(1);
  expect(run.bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual([
    "opacity",
    "path-morph",
    "vector-appearance",
    "path-trim",
  ]);
  expect(run.identity.mappings).toHaveLength(1);
  expect(run.identity.mappings[0]).toMatchObject({
    binding: { name: "square", ordinal: 2 },
    entityId: run.bundle.scene.entities[0]?.id,
    familyPath: [],
  });
  const entityId = run.identity.mappings[0]?.entityId;
  if (!entityId) throw new Error("The official V8 identity did not map the stable Square entity.");

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${run.publicationRevision}`,
  );
  const square = page.getByRole("button", { name: "Move square", exact: true });
  await expect(square).toBeVisible();
  await expect(square).toBeEnabled();
  const studioEntityId = await square.getAttribute("data-studio-entity");
  if (!studioEntityId) throw new Error("The source Square did not retain a Studio entity identity.");
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "3");
  // At t=0 Create has no prepared geometry, so the wrapper cannot expose a
  // frame-correlated runtime hit target until the first visible sample.
  await playhead.fill("1");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "1");
  await expect(page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`)).toHaveAttribute(
    "data-studio-runtime-entity",
    entityId,
  );

  const samplePlan = [
    ...FORWARD_SAMPLE_TIMES.map((sampleTime) => ({ id: `forward:${sampleTime}`, sampleTime })),
    ...RANDOM_SAMPLE_TIMES.map((sampleTime, index) => ({ id: `random:${index}:${sampleTime}`, sampleTime })),
  ];
  const samples = await retainedWebGpuSamples(page, {
    entityId,
    revision: run.snapshotHash,
    samples: samplePlan,
    snapshot: run.bundle,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const forward = new Map(
    FORWARD_SAMPLE_TIMES.map((sampleTime) => {
      const sample = byId.get(`forward:${sampleTime}`);
      if (!sample) throw new Error(`Missing forward WebGPU sample ${sampleTime}.`);
      return [sampleTime, sample] as const;
    }),
  );

  for (const [index, sampleTime] of RANDOM_SAMPLE_TIMES.entries()) {
    const expected = forward.get(sampleTime);
    const actual = byId.get(`random:${index}:${sampleTime}`);
    if (!expected || !actual) throw new Error(`Missing random WebGPU sample ${sampleTime}.`);
    expect(actual.frame).toMatchObject({
      interaction: expected.frame.interaction,
      kind: "frame-presented",
      revision: run.snapshotHash,
      sampleTime,
      viewport: VIEWPORT,
    });
    expect(actual.evidence).toMatchObject({
      packetId: actual.frame.packetId,
      revision: run.snapshotHash,
      sampleTime,
      viewport: VIEWPORT,
    });
    expect(actual.evidence.samples).toEqual(expected.evidence.samples);
    expect(actual.evidence.surfaceFormat).toBe(expected.evidence.surfaceFormat);
  }

  for (const sampleTime of FORWARD_SAMPLE_TIMES) {
    const sample = forward.get(sampleTime);
    if (!sample) throw new Error(`Missing retained WebGPU sample ${sampleTime}.`);
    expect(sample.frame).toMatchObject({
      interaction: { entries: [expect.any(Object)], space: "clip-v1", status: "available" },
      kind: "frame-presented",
      revision: run.snapshotHash,
      sampleTime,
      viewport: VIEWPORT,
    });
    expect(sample.evidence).toMatchObject({
      packetId: sample.frame.packetId,
      revision: run.snapshotHash,
      sampleTime,
      viewport: VIEWPORT,
    });
  }

  expect(forward.get(0)?.frame.interaction.entries).toEqual([{ status: "empty" }]);
  expect(forward.get(3)?.frame.interaction.entries).toEqual([{ status: "inactive" }]);
  expect(forward.get(0)?.evidence.samples.every(isOpaqueBlack)).toBe(true);
  expect(forward.get(3)?.evidence.samples.every(isOpaqueBlack)).toBe(true);
  for (const sampleTime of [0.5, 1, 1.5, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME, 2, 2.5]) {
    const sample = forward.get(sampleTime);
    expect(sample?.frame.interaction.entries).toEqual([expect.objectContaining({ status: "present" })]);
    expect(hasVisiblePixel(sample?.evidence.samples ?? [])).toBe(true);
  }
  const root = forward.get(CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME);
  expect(root?.evidence.samples[0], "the winding-root frame must remain visibly rendered").not.toEqual([0, 0, 0, 255]);

  if (CAIRO_PARITY_REQUIRED) {
    await expectIndependentCairoParity(page, { bundle: run.bundle, revision: run.snapshotHash });
  }

  for (const sampleTime of RANDOM_SAMPLE_TIMES) {
    // The user-facing range input intentionally snaps to 10 ms. Exact root
    // sampling is proven above through the retained engine API.
    const snappedSampleTime = Math.round(sampleTime * 100) / 100;
    await playhead.fill(String(snappedSampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(snappedSampleTime));
  }

  await playhead.fill("0.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "0.5");
  const pristineSquareBounds = await square.boundingBox();
  if (!pristineSquareBounds) throw new Error("The pristine Square has no visible browser bounds.");

  // Imported source edits are anchored at t=0. The semantic wrapper remains
  // editable while Create has not yet exposed runtime hit geometry.
  await playhead.fill("0");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "0");
  const pristineRevision = await canvas.getAttribute("data-preview-revision");
  const pristinePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!pristineRevision || !pristinePacket) throw new Error("The pristine V8 frame has no retained identity.");

  await page.getByRole("button", { name: "Set position" }).click();
  await page.getByRole("checkbox", { name: "Select square" }).check();
  await dragBy(page, square, { x: 32, y: -18 });
  const draft = page.getByRole("heading", { name: "Draft program" });
  await expect(draft).toBeVisible();
  await waitForNewPresentedFrame(page, pristineRevision, pristinePacket);
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);

  for (const sampleTime of [0.5, 1.5, 2.5]) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`)).toHaveAttribute(
      "data-studio-runtime-entity",
      entityId,
    );
    if (sampleTime === 0.5) {
      const editedSquareBounds = await square.boundingBox();
      if (!editedSquareBounds) throw new Error("The edited Square has no visible browser bounds.");
      const pristineCenter = {
        x: pristineSquareBounds.x + pristineSquareBounds.width / 2,
        y: pristineSquareBounds.y + pristineSquareBounds.height / 2,
      };
      const editedCenter = {
        x: editedSquareBounds.x + editedSquareBounds.width / 2,
        y: editedSquareBounds.y + editedSquareBounds.height / 2,
      };
      // Prepared trim bounds are quantized to the browser canvas; keep the
      // interaction-center proof within two CSS pixels of the pointer delta.
      expect(Math.abs(editedCenter.x - pristineCenter.x - 32)).toBeLessThan(2);
      expect(Math.abs(editedCenter.y - pristineCenter.y + 18)).toBeLessThan(2);
    }
  }

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(draft).toBeHidden();

  const candidateSource = await exportedSource(page);
  const candidateSourceHash = createHash("sha256").update(candidateSource, "utf8").digest("hex");
  expect(candidateSourceHash).not.toBe(OFFICIAL_SOURCE_SHA256);
  expect(candidateSource).not.toContain("# poietra:");
  const canonicalMovePattern =
    /^ {8}(square|circle)\.move_to\(\((-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?), (-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?), 0\)\)$/gmu;
  const moves = [...candidateSource.matchAll(canonicalMovePattern)];
  expect(moves.map((match) => match[1])).toEqual(["square", "circle"]);
  const squareMove = moves[0];
  const circleMove = moves[1];
  if (!squareMove || !circleMove || squareMove[2] !== circleMove[2] || squareMove[3] !== circleMove[3]) {
    throw new Error("The SquareToCircle candidate must contain two equal canonical move_to targets.");
  }
  const translation = { x: Number(squareMove[2]), y: Number(squareMove[3]) };
  expect(Math.hypot(translation.x, translation.y)).toBeGreaterThan(0.01);
  expect(candidateSource.indexOf(squareMove[0])).toBeLessThan(candidateSource.indexOf(circleMove[0]));
  expect(candidateSource.indexOf(circleMove[0])).toBeLessThan(
    candidateSource.indexOf("        self.play(Create(square))"),
  );
  const recoveredSource = candidateSource
    .split("\n")
    .filter((line) => line !== squareMove[0] && line !== circleMove[0])
    .join("\n");
  expect(createHash("sha256").update(recoveredSource, "utf8").digest("hex")).toBe(OFFICIAL_SOURCE_SHA256);
  const officialRoot = process.env.POIETRA_FAST_MANIM_V8_PROJECT_ROOT;
  if (!officialRoot) throw new Error("The official V8 project root is unavailable to the browser proof.");
  expect(recoveredSource).toBe(await readFile(join(officialRoot, SOURCE_PATH), "utf8"));

  const edited = await renderCommitAndFreshSnapshot(page);
  expect(edited.publicationRevision).toBeGreaterThan(run.publicationRevision);
  expect(edited.snapshotHash).not.toBe(run.snapshotHash);
  expect(edited.bundle.scene.source).toEqual({
    kind: "imported-manim-server-snapshot",
    runtimeConfigHash: run.bundle.scene.source.runtimeConfigHash,
    snapshotHash: edited.snapshotHash,
    snapshotVersion: 8,
    sourceHash: candidateSourceHash,
  });
  expect(edited.identity.mappings).toHaveLength(1);
  expect(edited.identity.mappings[0]).toMatchObject({
    binding: {
      name: run.identity.mappings[0]?.binding.name,
      ordinal: run.identity.mappings[0]?.binding.ordinal,
      span: run.identity.mappings[0]?.binding.span,
    },
    entityId,
    familyPath: [],
  });
  expect(edited.identity.mappings[0]?.binding.id).not.toBe(run.identity.mappings[0]?.binding.id);
  expectFreshV8Translation(run.bundle, edited.bundle, translation);
  expect(await exportedSource(page)).toBe(candidateSource);

  await expect(canvas).toHaveAttribute("data-preview-revision", edited.snapshotHash, { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  const editedEntityId = edited.identity.mappings[0]?.entityId;
  if (!editedEntityId) throw new Error("The edited V8 identity did not retain the stable Square entity.");
  const editedSamplePlan = [
    ...FORWARD_SAMPLE_TIMES.map((sampleTime) => ({ id: `edited:forward:${sampleTime}`, sampleTime })),
    ...RANDOM_SAMPLE_TIMES.map((sampleTime, index) => ({ id: `edited:random:${index}:${sampleTime}`, sampleTime })),
  ];
  const editedSamples = await retainedWebGpuSamples(page, {
    entityId: editedEntityId,
    revision: edited.snapshotHash,
    samples: editedSamplePlan,
    snapshot: edited.bundle,
  });
  const editedById = new Map(editedSamples.map((sample) => [sample.id, sample]));
  for (const [index, sampleTime] of RANDOM_SAMPLE_TIMES.entries()) {
    const expected = editedById.get(`edited:forward:${sampleTime}`);
    const actual = editedById.get(`edited:random:${index}:${sampleTime}`);
    if (!expected || !actual) throw new Error(`Missing edited random WebGPU sample ${sampleTime}.`);
    expect(actual.frame.interaction).toEqual(expected.frame.interaction);
    expect(actual.evidence.samples).toEqual(expected.evidence.samples);
    expect(actual.evidence.surfaceFormat).toBe(expected.evidence.surfaceFormat);
  }
  expect(editedById.get("edited:forward:0")?.frame.interaction.entries).toEqual([{ status: "empty" }]);
  expect(editedById.get("edited:forward:3")?.frame.interaction.entries).toEqual([{ status: "inactive" }]);
  const clipTranslation = {
    x: (2 * translation.x) / run.bundle.scene.camera.view.frameWidth,
    y: (2 * translation.y) / run.bundle.scene.camera.view.frameHeight,
  };
  for (const sampleTime of [0.5, 1, 1.5, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME, 2, 2.5] as const) {
    const before = presentBounds(forward.get(sampleTime));
    const after = presentBounds(editedById.get(`edited:forward:${sampleTime}`));
    expect(after[0] - before[0]).toBeCloseTo(clipTranslation.x, 6);
    expect(after[1] - before[1]).toBeCloseTo(clipTranslation.y, 6);
    expect(after[2] - before[2]).toBeCloseTo(clipTranslation.x, 6);
    expect(after[3] - before[3]).toBeCloseTo(clipTranslation.y, 6);
  }

  if (CAIRO_PARITY_REQUIRED) {
    await expectIndependentCairoParity(page, {
      bundle: edited.bundle,
      candidate: { sourceHash: candidateSourceHash, sourceText: candidateSource },
      revision: edited.snapshotHash,
    });
  }
});

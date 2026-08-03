import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

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

type SnapshotRunBody = Readonly<{
  revision?: number;
  sceneName?: string;
  snapshot?: Readonly<{ bundle?: SceneIrBundleV1; snapshotHash?: string }>;
  sourcePath?: string;
  sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
  status?: string;
}>;

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function openOfficialSquareToCircle(page: Page) {
  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
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

test("renders official SquareToCircle V8 through retained browser WebGPU across random seeks", async ({ page }) => {
  test.setTimeout(300_000);
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

  for (const sampleTime of RANDOM_SAMPLE_TIMES) {
    // The user-facing range input intentionally snaps to 10 ms. Exact root
    // sampling is proven above through the retained engine API.
    const snappedSampleTime = Math.round(sampleTime * 100) / 100;
    await playhead.fill(String(snappedSampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(snappedSampleTime));
  }
});

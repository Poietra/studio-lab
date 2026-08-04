import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_LABEL = `${SOURCE_PATH} · WarpSquare`;
const OFFICIAL_SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
const FORWARD_SAMPLE_TIMES = [0, 0.25, 0.75, 1.5, 2.75, 3, 3.5, 4] as const;
const NON_MONOTONIC_SAMPLE_TIMES = [3.5, 0.25, 3, 0.75, 0, 2.75, 1.5, 4, 0.25] as const;

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

async function verifiedWarpSquareSnapshot(page: Page) {
  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const responsePromise = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as SnapshotRunBody;
  expect(body).toMatchObject({ sceneName: "WarpSquare", sourcePath: SOURCE_PATH, status: "verified" });
  if (
    !body.snapshot?.bundle ||
    !body.snapshot.snapshotHash ||
    !body.sourceRuntimeIdentity ||
    typeof body.revision !== "number"
  ) {
    throw new Error("The verified official WarpSquare V9 snapshot response is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

async function renderRetainedSamples(
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
      const [{ PoietraCanvasWorkerClient }, { createCanvasWorkerClientEvidenceAdapterV1 }, { applyEngineEasingV1 }] =
        await Promise.all([
          import("/src/engine/canvas-worker-client.ts") as Promise<typeof import("../src/engine/canvas-worker-client")>,
          import("/src/engine/canvas-worker-evidence.ts") as Promise<
            typeof import("../src/engine/canvas-worker-evidence")
          >,
          import("/src/engine/easing.ts") as Promise<typeof import("../src/engine/easing")>,
        ]);
      const channel = snapshot.scene.animationChannels[0];
      if (channel?.kind !== "path-morph") throw new Error("WarpSquare V9 has no path-morph channel.");
      const from = channel.keyframes[0]?.value.subpaths[0]?.start;
      const to = channel.keyframes[1]?.value.subpaths[0]?.start;
      if (!from || !to) throw new Error("WarpSquare V9 has incomplete morph endpoints.");
      const { center, frameHeight, frameWidth } = snapshot.scene.camera.view;
      const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
      try {
        await client.installScene({ canvas, revision, snapshot });
        const results = [];
        for (const sample of samples) {
          const frame = await client.render({
            interactionEntityIds: [entityId],
            revision,
            sampleTime: sample.sampleTime,
            viewport,
          });
          const progress =
            sample.sampleTime >= 3 ? 1 : applyEngineEasingV1({ kind: "manim-smooth" }, sample.sampleTime / 3);
          const point = {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
          };
          const centerFraction = {
            x: 0.5 + (point.x - center.x) / frameWidth,
            y: 0.5 - (point.y - center.y) / frameHeight,
          };
          const evidence = await client.captureFrameEvidence({
            revision,
            samples: [-1, 0, 1].flatMap((dy) =>
              [-1, 0, 1].map((dx) => ({
                fractionX: centerFraction.x + dx / viewport.widthPx,
                fractionY: centerFraction.y + dy / viewport.heightPx,
              })),
            ),
          });
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

function hasVisiblePixel(samples: readonly (readonly number[])[]) {
  return samples.some(([red = 0, green = 0, blue = 0]) => Math.max(red, green, blue) > 8);
}

function isOpaqueBlack(pixel: readonly number[]) {
  return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
}

test("renders official WarpSquare V9 through verified Studio and retained browser WebGPU", async ({ page }) => {
  test.setTimeout(300_000);
  const run = await verifiedWarpSquareSnapshot(page);
  expect(run.bundle.scene).toMatchObject({
    duration: 4,
    requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotHash: run.snapshotHash,
      snapshotVersion: 9,
      sourceHash: OFFICIAL_SOURCE_SHA256,
    },
  });
  expect(run.bundle.scene.entities).toHaveLength(1);
  expect(run.bundle.scene.animationChannels).toEqual([
    expect.objectContaining({
      entityId: run.bundle.scene.entities[0]?.id,
      keyframes: [
        expect.objectContaining({ at: 0, easingToNext: { kind: "manim-smooth" } }),
        expect.objectContaining({ at: 3, easingToNext: null }),
      ],
      kind: "path-morph",
    }),
  ]);
  expect(run.identity.mappings).toEqual([
    expect.objectContaining({
      binding: expect.objectContaining({ name: "square", ordinal: 1 }),
      entityId: run.bundle.scene.entities[0]?.id,
      familyPath: [],
    }),
  ]);
  const entityId = run.identity.mappings[0]?.entityId;
  if (!entityId) throw new Error("The official WarpSquare V9 identity map is incomplete.");

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "display-only");
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${run.publicationRevision}`,
  );
  await expect(page.getByRole("button", { name: "Move square", exact: true })).toHaveCount(0);
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "4");

  const samplePlan = [
    ...FORWARD_SAMPLE_TIMES.map((sampleTime) => ({ id: `forward:${sampleTime}`, sampleTime })),
    ...NON_MONOTONIC_SAMPLE_TIMES.map((sampleTime, index) => ({ id: `seek:${index}:${sampleTime}`, sampleTime })),
  ];
  const samples = await renderRetainedSamples(page, {
    entityId,
    revision: run.snapshotHash,
    samples: samplePlan,
    snapshot: run.bundle,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));

  for (const sampleTime of FORWARD_SAMPLE_TIMES) {
    const sample = byId.get(`forward:${sampleTime}`);
    if (!sample) throw new Error(`Missing forward WarpSquare WebGPU sample ${sampleTime}.`);
    expect(sample.frame).toMatchObject({
      interaction: {
        entries: [{ status: sampleTime < 4 ? "present" : "inactive" }],
        space: "clip-v1",
        status: "available",
      },
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
    if (sampleTime < 4) expect(hasVisiblePixel(sample.evidence.samples)).toBe(true);
    else expect(sample.evidence.samples.every(isOpaqueBlack)).toBe(true);
  }

  for (const [index, sampleTime] of NON_MONOTONIC_SAMPLE_TIMES.entries()) {
    const expected = byId.get(`forward:${sampleTime}`);
    const actual = byId.get(`seek:${index}:${sampleTime}`);
    if (!expected || !actual) throw new Error(`Missing non-monotonic WarpSquare WebGPU sample ${sampleTime}.`);
    expect(actual.frame.interaction).toEqual(expected.frame.interaction);
    expect(actual.evidence.samples).toEqual(expected.evidence.samples);
    expect(actual.evidence.surfaceFormat).toBe(expected.evidence.surfaceFormat);
  }

  for (const sampleTime of NON_MONOTONIC_SAMPLE_TIMES) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-interaction", "display-only");
    await expect(page.getByRole("button", { name: "Move square", exact: true })).toHaveCount(0);
  }
});

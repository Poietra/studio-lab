import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SCENE_LABEL = "scene_mixed_dynamic.py · MixedMathDemo";

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function openMixedWorkspace(page: Page) {
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

async function verifiedMixedSnapshot(responsePromise: ReturnType<typeof snapshotResponse>) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
    sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
    status?: string;
  };
  expect(body.status).toBe("verified");
  if (!body.snapshot?.bundle || !body.snapshot.snapshotHash || !body.revision || !body.sourceRuntimeIdentity) {
    throw new Error("The verified mixed V7 snapshot is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    revision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

async function expectPresented(page: Page, revision: number) {
  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(page.locator("[data-studio-preview-status]")).toContainText(`verified server snapshot r${revision}`);
  const viewport = await canvas.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The mixed V7 preview did not expose its WebGPU viewport.");
  return viewport;
}

async function renderCheckpoints(
  page: Page,
  input: Readonly<{
    entityIds: readonly string[];
    revision: string;
    snapshot: SceneIrBundleV1;
    viewport: string;
  }>,
) {
  return page.evaluate(async ({ entityIds, revision, snapshot, viewport }) => {
    const [widthPx, heightPx] = viewport.split("x").map(Number);
    const canvas = Object.assign(document.createElement("canvas"), { height: heightPx, width: widthPx });
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
      const asEvidencePoint = ({ x, y }: Readonly<{ x: number; y: number }>) => ({
        fractionX: 0.5 + (x - center.x) / frameWidth,
        fractionY: 0.5 - (y - center.y) / frameHeight,
      });
      const equation = snapshot.scene.entities.find(({ id }) => id === entityIds[0]);
      const ring = snapshot.scene.entities.find(({ id }) => id === entityIds[1]);
      if (equation?.geometry.kind !== "cubic-path" || ring?.geometry.kind !== "cubic-path") {
        throw new Error("The mixed V7 pixel proof requires cubic equation and ring geometry.");
      }
      const equationSamples = equation.geometry.path.subpaths.slice(0, 4).map((subpath) => {
        const points = [subpath.start, ...subpath.segments.map(({ end }) => end)];
        return asEvidencePoint({
          x: points.reduce((sum, { x }) => sum + x, 0) / points.length,
          y: points.reduce((sum, { y }) => sum + y, 0) / points.length,
        });
      });
      const ringPoints = [
        ring.geometry.path.subpaths[0]?.start,
        ...(ring.geometry.path.subpaths[0]?.segments ?? []).map(({ end }) => end),
      ]
        .filter((point): point is { x: number; y: number } => point !== undefined)
        .filter((_, index) => index % 2 === 0)
        .slice(0, 6)
        .map(asEvidencePoint);
      const evidenceSamples = [
        ...equationSamples,
        ...ringPoints,
        asEvidencePoint({ x: 1, y: -1 }),
        asEvidencePoint({ x: 2.5, y: 0 }),
        asEvidencePoint({ x: 4, y: 1 }),
        { fractionX: 0.03, fractionY: 0.05 },
      ].slice(0, 16);
      const samples = [];
      for (const sampleTime of [0, 0.5, 1, 2, 3, 3.999, 4]) {
        const frame = await client.render({
          interactionEntityIds: entityIds,
          revision,
          sampleTime,
          viewport: { heightPx, widthPx },
        });
        const evidence = await client.captureFrameEvidence({ revision, samples: evidenceSamples });
        samples.push({ evidence, frame });
      }
      return samples;
    } finally {
      client.dispose();
    }
  }, input);
}

test("renders one identity-mapped MathTex and animated shapes from a real Manim Scene through mixed V7", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const run = await verifiedMixedSnapshot(openMixedWorkspace(page));
  const { scene } = run.bundle;
  expect(scene).toMatchObject({
    duration: 4,
    source: { kind: "imported-manim-server-snapshot", snapshotVersion: 7 },
  });
  expect(scene.entities).toHaveLength(3);
  expect(scene.animationChannels).toHaveLength(2);
  expect(scene.animationChannels.map(({ kind }) => kind)).toEqual(["path-trim", "motion-path"]);
  expect(run.identity.mappings).toHaveLength(3);

  const entityIdByName = new Map(run.identity.mappings.map(({ binding, entityId }) => [binding.name, entityId]));
  const equationId = entityIdByName.get("equation");
  const ringId = entityIdByName.get("ring");
  const particleId = entityIdByName.get("particle");
  if (!equationId || !ringId || !particleId) {
    throw new Error("The mixed V7 identity map did not cover equation, ring, and particle.");
  }
  expect(scene.animationChannels).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ entityId: ringId, kind: "path-trim" }),
      expect.objectContaining({ entityId: particleId, kind: "motion-path" }),
    ]),
  );

  const viewport = await expectPresented(page, run.revision);
  const samples = await renderCheckpoints(page, {
    entityIds: [equationId, ringId, particleId],
    revision: run.snapshotHash,
    snapshot: run.bundle,
    viewport,
  });
  for (const [index, sampleTime] of [0, 0.5, 1, 2, 3, 3.999, 4].entries()) {
    expect(samples[index]?.frame).toMatchObject({
      interaction: { space: "clip-v1", status: "available" },
      kind: "frame-presented",
      revision: run.snapshotHash,
      sampleTime,
    });
    expect(samples[index]?.evidence).toMatchObject({
      packetId: samples[index]?.frame.packetId,
      revision: run.snapshotHash,
      sampleTime,
      viewport: samples[index]?.frame.viewport,
    });
  }

  const entries = samples.map(({ frame }) => frame.interaction.entries);
  expect(entries.slice(0, -1).every(([equation]) => equation?.status === "present")).toBe(true);
  expect(entries[0]?.[1]?.status).not.toBe("present");
  expect(entries[1]?.[1]?.status).toBe("present");
  expect(entries[2]?.[1]?.status).toBe("present");
  expect(entries[0]?.[2]).toEqual({ status: "inactive" });
  expect(entries[2]?.[2]?.status).toBe("present");
  expect(entries[3]?.[2]?.status).toBe("present");
  expect(entries[2]?.[2]).not.toEqual(entries[3]?.[2]);
  expect(entries[4]?.[2]).toEqual(entries[5]?.[2]);
  expect(entries[6]).toEqual([{ status: "inactive" }, { status: "inactive" }, { status: "inactive" }]);

  const isVisiblePixel = ([red, green, blue]: readonly number[]) => red > 8 || green > 8 || blue > 8;
  const hasVisiblePixel = (sample: (typeof samples)[number]) => sample.evidence.samples.some(isVisiblePixel);
  expect(samples.slice(0, -1).every(hasVisiblePixel)).toBe(true);
  expect(samples[0]?.evidence.samples.slice(5, 8).every((pixel) => !isVisiblePixel(pixel))).toBe(true);
  expect(samples[1]?.evidence.samples.slice(5, 8).some(isVisiblePixel)).toBe(true);
  expect(isVisiblePixel(samples[2]?.evidence.samples[9] ?? [])).toBe(true);
  expect(isVisiblePixel(samples[3]?.evidence.samples[10] ?? [])).toBe(true);
  expect(isVisiblePixel(samples[4]?.evidence.samples[11] ?? [])).toBe(true);
  expect(
    samples[6]?.evidence.samples.every(
      ([red, green, blue, alpha]) => red === 0 && green === 0 && blue === 0 && alpha === 255,
    ),
  ).toBe(true);
  await expect(page.getByRole("slider", { name: "Scene playhead" })).toHaveAttribute("max", "4");
});

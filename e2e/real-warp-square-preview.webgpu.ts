import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";
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

async function exportedSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported WarpSquare source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The WarpSquare edit target is not visible.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y);
  await page.mouse.up();
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
  const revision = await canvas.getAttribute("data-preview-revision");
  const packet = await canvas.getAttribute("data-preview-packet-id");
  if (!revision || !packet) throw new Error("The edited WarpSquare frame has no retained-frame identity.");
  return { packet, revision };
}

async function verifiedWarpSquareSnapshot(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
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
      const fromPath = channel.keyframes[0]?.value;
      const toPath = channel.keyframes[1]?.value;
      const entity = snapshot.scene.entities.find(({ id }) => id === entityId);
      if (!fromPath || !toPath || !entity) throw new Error("WarpSquare V9 has incomplete morph endpoints.");
      const pathEndpoints = (path: typeof fromPath) =>
        path.subpaths.flatMap((subpath) => [subpath.start, ...subpath.segments.map(({ end }) => end)]);
      const fromPoints = pathEndpoints(fromPath);
      const toPoints = pathEndpoints(toPath);
      if (fromPoints.length === 0 || fromPoints.length !== toPoints.length) {
        throw new Error("WarpSquare V9 morph endpoints are not correlated.");
      }
      const { center, frameHeight, frameWidth } = snapshot.scene.camera.view;
      const { m11, m12, m21, m22, tx, ty } = entity.transform;
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
          const visibleCenters = fromPoints.flatMap((from, index) => {
            const to = toPoints[index]!;
            const local = {
              x: from.x + (to.x - from.x) * progress,
              y: from.y + (to.y - from.y) * progress,
            };
            const world = {
              x: m11 * local.x + m12 * local.y + tx,
              y: m21 * local.x + m22 * local.y + ty,
            };
            const fraction = {
              x: 0.5 + (world.x - center.x) / frameWidth,
              y: 0.5 - (world.y - center.y) / frameHeight,
            };
            return fraction.x >= 0 && fraction.x <= 1 && fraction.y >= 0 && fraction.y <= 1 ? [fraction] : [];
          });
          const stride = Math.max(1, Math.floor(visibleCenters.length / 3));
          const evidenceCenters = [0, stride, stride * 2]
            .flatMap((index) => (visibleCenters[index] ? [visibleCenters[index]] : []))
            .slice(0, 3);
          const evidencePoints = evidenceCenters.flatMap((point) =>
            [
              { x: 0, y: 0 },
              { x: -1, y: 0 },
              { x: 1, y: 0 },
              { x: 0, y: -1 },
              { x: 0, y: 1 },
            ].map(({ x, y }) => ({
              fractionX: Math.min(1, Math.max(0, point.x + x / viewport.widthPx)),
              fractionY: Math.min(1, Math.max(0, point.y + y / viewport.heightPx)),
            })),
          );
          const evidence = await client.captureFrameEvidence({
            revision,
            samples: evidencePoints.length > 0 ? evidencePoints : [{ fractionX: 0.5, fractionY: 0.5 }],
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

function sourceGeometryBounds(bundle: SceneIrBundleV1) {
  const entity = bundle.scene.entities[0];
  if (!entity || entity.geometry.kind !== "cubic-path") {
    throw new Error("WarpSquare V9 has no cubic source geometry.");
  }
  const points = entity.geometry.path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
  ]);
  if (points.length === 0) throw new Error("WarpSquare V9 has empty source geometry.");
  const left = Math.min(...points.map(({ x }) => x));
  const right = Math.max(...points.map(({ x }) => x));
  const bottom = Math.min(...points.map(({ y }) => y));
  const top = Math.max(...points.map(({ y }) => y));
  return {
    center: { x: (left + right) / 2, y: (bottom + top) / 2 },
    height: top - bottom,
    width: right - left,
  };
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
  await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${run.publicationRevision}`,
  );
  const square = page.getByRole("button", { name: "Move square", exact: true });
  await expect(square).toBeVisible();
  await expect(square).toBeEnabled();
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
    await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  }

  await playhead.fill("0");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "0");
  const pristineRevision = await canvas.getAttribute("data-preview-revision");
  const pristinePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!pristineRevision || !pristinePacket) throw new Error("The pristine V9 frame has no retained identity.");

  await page.getByRole("button", { name: "Set position" }).click();
  await page.getByRole("checkbox", { name: "Select square" }).check();
  await dragBy(page, square, { x: 32, y: -18 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await waitForNewPresentedFrame(page, pristineRevision, pristinePacket);
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeHidden();

  // The exponential endpoint is not affine-equivariant. Before producer
  // reimport, only t=0 is truthful; all animated samples must fail closed.
  await playhead.fill("0.5");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvas).toHaveAttribute("data-preview-fallback-reason", "snapshot-uncorrelated");
  await playhead.fill("0");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  const appliedMoveRevision = await canvas.getAttribute("data-preview-revision");
  const appliedMovePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!appliedMoveRevision || !appliedMovePacket) {
    throw new Error("The applied WarpSquare move has no retained-frame identity.");
  }

  const scale = page.getByRole("spinbutton", { name: "Scale square" });
  await expect(scale).toBeVisible();
  await scale.fill("1.25");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await waitForNewPresentedFrame(page, appliedMoveRevision, appliedMovePacket);
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeHidden();

  const loweredSource = await exportedSource(page);
  const warpSquareClass = loweredSource.indexOf("class WarpSquare");
  const squareCreation = loweredSource.indexOf("        square = Square()", warpSquareClass);
  const moveCall = loweredSource.indexOf("        square.move_to((", squareCreation);
  const firstPlay = loweredSource.indexOf("        self.play(", squareCreation);
  expect(warpSquareClass).toBeGreaterThanOrEqual(0);
  expect(squareCreation).toBeGreaterThanOrEqual(0);
  expect(moveCall).toBeGreaterThan(squareCreation);
  expect(firstPlay).toBeGreaterThan(moveCall);
  expect(loweredSource.match(/square\.move_to\(/g)).toHaveLength(1);
  expect(loweredSource.match(/square\.scale\(/g)).toHaveLength(1);
  expect(loweredSource).toContain("        square.scale(1.25)");
  expect(loweredSource.indexOf("        square.scale(1.25)")).toBeGreaterThan(moveCall);
  expect(loweredSource.indexOf("        square.scale(1.25)")).toBeLessThan(firstPlay);
  expect(loweredSource).not.toContain("# poietra:");
  const loweredMove = loweredSource.match(
    /square\.move_to\(\((-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?), (-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?), 0\)\)/,
  );
  if (!loweredMove) throw new Error("The WarpSquare move_to statement is not canonical.");
  const loweredCenter = { x: Number(loweredMove[1]), y: Number(loweredMove[2]) };
  expect(Math.abs(loweredCenter.x)).toBeGreaterThan(0.01);
  expect(Math.abs(loweredCenter.y)).toBeGreaterThan(0.01);

  await page.getByRole("button", { name: "Render program" }).click();
  const commit = page.getByRole("button", { name: "Commit to source" });
  await expect(commit).toBeVisible({ timeout: 180_000 });
  await expect(commit).toBeEnabled();

  const editedSnapshotPromise = snapshotResponse(page);
  await commit.click();
  await expect(page.getByRole("alertdialog", { name: "Commit rendered program?" })).toBeVisible();
  await page.getByRole("button", { name: "Commit source" }).click();
  const editedResponse = await editedSnapshotPromise;
  expect(editedResponse.ok()).toBe(true);
  const edited = (await editedResponse.json()) as SnapshotRunBody;
  expect(edited).toMatchObject({ sceneName: "WarpSquare", sourcePath: SOURCE_PATH, status: "verified" });
  if (!edited.snapshot?.bundle || !edited.snapshot.snapshotHash || !edited.sourceRuntimeIdentity) {
    throw new Error("The committed WarpSquare source did not publish a complete edited V9 snapshot.");
  }
  expect(edited.snapshot.bundle.scene.source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotHash: edited.snapshot.snapshotHash,
    snapshotVersion: 9,
  });
  expect(edited.snapshot.bundle.scene.source.sourceHash).not.toBe(OFFICIAL_SOURCE_SHA256);
  expect(edited.sourceRuntimeIdentity.mappings).toEqual([
    expect.objectContaining({
      binding: expect.objectContaining({ name: "square", ordinal: 1 }),
      entityId: edited.snapshot.bundle.scene.entities[0]?.id,
      familyPath: [],
    }),
  ]);
  const beforeBounds = sourceGeometryBounds(run.bundle);
  const editedBounds = sourceGeometryBounds(edited.snapshot.bundle);
  expect(editedBounds.width / beforeBounds.width).toBeCloseTo(1.25, 10);
  expect(editedBounds.height / beforeBounds.height).toBeCloseTo(1.25, 10);
  expect(editedBounds.center.x).toBeCloseTo(loweredCenter.x, 10);
  expect(editedBounds.center.y).toBeCloseTo(loweredCenter.y, 10);
  expect(edited.snapshot.bundle.scene.animationChannels).toEqual([
    expect.objectContaining({
      entityId: edited.snapshot.bundle.scene.entities[0]?.id,
      keyframes: [
        expect.objectContaining({ at: 0, easingToNext: { kind: "manim-smooth" } }),
        expect.objectContaining({ at: 3, easingToNext: null }),
      ],
      kind: "path-morph",
    }),
  ]);
  await expect(canvas).toHaveAttribute("data-preview-revision", edited.snapshot.snapshotHash, { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "display-only");
  await expect(square).toHaveCount(0);

  expect(await exportedSource(page)).toBe(loweredSource);

  const editedEntityId = edited.sourceRuntimeIdentity.mappings[0]?.entityId;
  if (!editedEntityId) throw new Error("The edited WarpSquare identity map is incomplete.");
  const editedSamples = await renderRetainedSamples(page, {
    entityId: editedEntityId,
    revision: edited.snapshot.snapshotHash,
    samples: [
      { id: "edited:target", sampleTime: 3 },
      { id: "edited:source", sampleTime: 0 },
      { id: "edited:hold", sampleTime: 3.5 },
      { id: "edited:midpoint", sampleTime: 1.5 },
      { id: "edited:end", sampleTime: 4 },
      { id: "edited:source-again", sampleTime: 0 },
    ],
    snapshot: edited.snapshot.bundle,
  });
  const editedById = new Map(editedSamples.map((sample) => [sample.id, sample]));
  expect(editedById.get("edited:source-again")?.evidence.samples).toEqual(
    editedById.get("edited:source")?.evidence.samples,
  );
  expect(editedById.get("edited:hold")?.evidence.samples).toEqual(editedById.get("edited:target")?.evidence.samples);
  expect(editedById.get("edited:source")?.frame.interaction).not.toEqual(
    editedById.get("edited:midpoint")?.frame.interaction,
  );
  expect(editedById.get("edited:midpoint")?.frame.interaction).not.toEqual(
    editedById.get("edited:target")?.frame.interaction,
  );
  for (const id of ["edited:source", "edited:midpoint", "edited:target", "edited:hold"]) {
    expect(hasVisiblePixel(editedById.get(id)?.evidence.samples ?? [])).toBe(true);
  }
  expect(editedById.get("edited:end")?.frame.interaction).toEqual({
    entries: [{ status: "inactive" }],
    space: "clip-v1",
    status: "available",
  });
});

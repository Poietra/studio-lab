import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, type Response, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const FIXTURE_PATH = "fixtures/engine-v1/real-line-joints-v10.json";
const EXPECTED_JOINS = ["miter", "round", "bevel"] as const;
const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_LABEL = `${SOURCE_PATH} · LineJoints`;
const OFFICIAL_SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";

type LineJointsFixtureV10 = Readonly<{
  assets: SceneIrBundleV1["assets"];
  id: string;
  samples: readonly Readonly<{
    packetId: string;
    sampleTime: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>[];
  scene: SceneIrBundleV1["scene"];
}>;

type SnapshotRunBody = Readonly<{
  revision?: number;
  sceneName?: string;
  snapshot?: Readonly<{ bundle?: SceneIrBundleV1; snapshotHash?: string }>;
  sourcePath?: string;
  sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
  status?: string;
}>;

async function renderLineJoints(page: Page, fixture: LineJointsFixtureV10, entityIds: readonly string[]) {
  await page.goto("/");
  return page.evaluate(
    async ({ assets, entityIds, sample, scene }) => {
      const canvas = Object.assign(document.createElement("canvas"), {
        height: sample.viewport.heightPx,
        width: sample.viewport.widthPx,
      });
      const [{ PoietraCanvasWorkerClient }, { createCanvasWorkerClientEvidenceAdapterV1 }] = await Promise.all([
        import("/src/engine/canvas-worker-client.ts") as Promise<typeof import("../src/engine/canvas-worker-client")>,
        import("/src/engine/canvas-worker-evidence.ts") as Promise<
          typeof import("../src/engine/canvas-worker-evidence")
        >,
      ]);
      const revision = scene.source.kind === "imported-manim-server-snapshot" ? scene.source.snapshotHash : "";
      if (!revision) throw new Error("LineJoints V10 must retain its sealed snapshot revision.");
      const asFraction = ({ x, y }: Readonly<{ x: number; y: number }>) => ({
        fractionX: 0.5 + (x - scene.camera.view.center.x) / scene.camera.view.frameWidth,
        fractionY: 0.5 - (y - scene.camera.view.center.y) / scene.camera.view.frameHeight,
      });
      const leafSamples = scene.entities.slice(1).map((entity) => {
        if (entity.geometry.kind !== "cubic-path") throw new Error("Every LineJoints leaf must be a cubic path.");
        const subpath = entity.geometry.path.subpaths[0];
        const bottom = subpath?.segments[1];
        if (!subpath || !bottom) throw new Error("Every LineJoints leaf must retain its triangular outline.");
        return asFraction({
          x: (subpath.segments[0]!.end.x + bottom.end.x) / 2,
          y: (subpath.segments[0]!.end.y + bottom.end.y) / 2,
        });
      });
      const leafInteriors = scene.entities.slice(1).map((entity) => {
        if (entity.geometry.kind !== "cubic-path") throw new Error("Every LineJoints leaf must be a cubic path.");
        const subpath = entity.geometry.path.subpaths[0];
        if (!subpath) throw new Error("Every LineJoints leaf must retain one closed subpath.");
        const vertices = [subpath.start, ...subpath.segments.map(({ end }) => end)];
        return asFraction({
          x: vertices.reduce((sum, { x }) => sum + x, 0) / vertices.length,
          y: vertices.reduce((sum, { y }) => sum + y, 0) / vertices.length,
        });
      });
      const evidencePoints = [
        ...leafSamples,
        ...leafInteriors,
        { fractionX: 0.02, fractionY: 0.02 },
        { fractionX: 0.98, fractionY: 0.98 },
      ];
      const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
      try {
        await client.installScene({ canvas, revision, snapshot: { assets, scene } });
        const frame = await client.render({
          interactionEntityIds: entityIds,
          revision,
          sampleTime: sample.sampleTime,
          viewport: sample.viewport,
        });
        const evidence = await client.captureFrameEvidence({ revision, samples: evidencePoints });
        return { evidence, frame };
      } finally {
        client.dispose();
      }
    },
    { assets: fixture.assets, entityIds, sample: fixture.samples[0]!, scene: fixture.scene },
  );
}

function isOpaqueBlack(pixel: readonly number[]) {
  return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
}

function isVisibleStroke(pixel: readonly number[]) {
  return Math.max(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0) > 8 && pixel[3] === 255;
}

test("renders official LineJoints V10 through retained WASM browser WebGPU", async ({ page }) => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as LineJointsFixtureV10;
  const [sample] = fixture.samples;
  expect(sample).toBeDefined();
  expect(fixture.id).toBe("eng-v1-real-line-joints-v10");
  expect(fixture.scene.source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotVersion: 10,
  });
  expect(fixture.scene.entities).toHaveLength(4);

  const [group, ...leaves] = fixture.scene.entities;
  if (!group || leaves.length !== 3) throw new Error("LineJoints V10 must retain one group and three leaves.");
  expect(group).toMatchObject({ appearance: { kind: "group" }, geometry: { kind: "group" }, parentId: null });
  expect(
    leaves.map((entity) => ({
      join: entity.appearance.kind === "vector" ? entity.appearance.stroke?.join : null,
      parentId: entity.parentId,
    })),
  ).toEqual(EXPECTED_JOINS.map((join) => ({ join, parentId: group.id })));

  const entityIds = fixture.scene.entities.map(({ id }) => id);
  const { evidence, frame } = await renderLineJoints(page, fixture, entityIds);
  expect(frame).toMatchObject({
    interaction: { space: "clip-v1", status: "available" },
    kind: "frame-presented",
    revision: fixture.scene.source.kind === "imported-manim-server-snapshot" ? fixture.scene.source.snapshotHash : "",
    sampleTime: sample!.sampleTime,
    viewport: sample!.viewport,
  });
  expect(evidence).toMatchObject({
    packetId: frame.packetId,
    revision: frame.revision,
    sampleTime: sample!.sampleTime,
    viewport: sample!.viewport,
  });
  expect(evidence.surfaceFormat).toMatch(/^(bgra|rgba)8unorm$/);

  expect(frame.interaction.entries).toHaveLength(4);
  expect(frame.interaction.entries[0]).toEqual({ status: "empty" });
  const leafBounds = frame.interaction.entries.slice(1).map((entry) => {
    expect(entry.status).toBe("present");
    if (entry.status !== "present") throw new Error("Every LineJoints leaf must expose browser interaction bounds.");
    expect(entry.bounds).toHaveLength(4);
    return entry.bounds;
  });
  expect(leafBounds[0]![2]).toBeLessThan(leafBounds[1]![0]);
  expect(leafBounds[1]![2]).toBeLessThan(leafBounds[2]![0]);

  expect(evidence.samples.slice(0, 3).every(isVisibleStroke)).toBe(true);
  expect(evidence.samples.slice(3, 6).every(isOpaqueBlack)).toBe(true);
  expect(evidence.samples.slice(6).every(isOpaqueBlack)).toBe(true);
});

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function verifiedLineJointsSnapshot(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as SnapshotRunBody;
  expect(body).toMatchObject({ sceneName: "LineJoints", sourcePath: SOURCE_PATH, status: "verified" });
  if (
    !body.snapshot?.bundle ||
    !body.snapshot.snapshotHash ||
    !body.sourceRuntimeIdentity ||
    typeof body.revision !== "number"
  ) {
    throw new Error("The verified official LineJoints V10 snapshot response is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

async function openOfficialLineJoints(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return verifiedLineJointsSnapshot(response);
}

async function exportedSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported LineJoints source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The LineJoints edit target is not visible.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y);
  await page.mouse.up();
}

async function waitForNewPresentedFrame(page: Page, previous: Readonly<{ packet: string; revision: string }>) {
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
        return phase === "presented" &&
          revision &&
          revision !== previous.revision &&
          packet &&
          packet !== previous.packet
          ? "presented"
          : JSON.stringify({ packet, phase, reason, revision });
      },
      { timeout: 30_000 },
    )
    .toBe("presented");
  const revision = await canvas.getAttribute("data-preview-revision");
  const packet = await canvas.getAttribute("data-preview-packet-id");
  if (!revision || !packet) throw new Error("The edited LineJoints frame has no retained-frame identity.");
  return { packet, revision };
}

async function applyDraft(page: Page, previous: Readonly<{ packet: string; revision: string }>) {
  const draft = page.getByRole("heading", { name: "Draft program" });
  await expect(draft).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(draft).toHaveCount(0);
  return waitForNewPresentedFrame(page, previous);
}

async function renderCommitAndReimport(page: Page) {
  const render = page.getByRole("button", { name: "Render program" });
  await expect(render).toBeVisible();
  await render.click();
  const commit = page.getByRole("button", { name: "Commit to source" });
  await expect(commit).toBeVisible({ timeout: 180_000 });
  await expect(commit).toBeEnabled();
  await commit.click();
  const dialog = page.getByRole("alertdialog", { name: "Commit rendered program?" });
  await expect(dialog).toBeVisible();
  const response = snapshotResponse(page);
  await dialog.getByRole("button", { name: "Commit source" }).click();
  return verifiedLineJointsSnapshot(response);
}

function cubicWorldBounds(bundle: SceneIrBundleV1, entityId: string) {
  const entity = bundle.scene.entities.find(({ id }) => id === entityId);
  if (!entity || entity.geometry.kind !== "cubic-path") {
    throw new Error(`LineJoints entity ${entityId} has no cubic geometry.`);
  }
  const { m11, m12, m21, m22, tx, ty } = entity.transform;
  const points = entity.geometry.path.subpaths
    .flatMap((subpath) => [
      subpath.start,
      ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
    ])
    .map(({ x, y }) => ({ x: m11 * x + m12 * y + tx, y: m21 * x + m22 * y + ty }));
  if (points.length === 0) throw new Error(`LineJoints entity ${entityId} has empty cubic geometry.`);
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

function mappedFamily(identity: VerifiedSourceRuntimeIdentityMapV1) {
  return identity.mappings.map(({ binding, entityId, familyPath }) => ({
    entityId,
    familyPath,
    name: binding.name,
  }));
}

test("edits only runtime-proven t2 and round-trips the real LineJoints source through Manim", async ({ page }) => {
  test.setTimeout(300_000);
  const run = await openOfficialLineJoints(page);
  const { scene } = run.bundle;
  expect(scene).toMatchObject({
    duration: 1,
    requiredCapabilities: ["cubic-path-geometry", "logical-group"],
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotHash: run.snapshotHash,
      snapshotVersion: 10,
      sourceHash: OFFICIAL_SOURCE_SHA256,
    },
  });
  expect(scene.entities).toHaveLength(4);
  expect(mappedFamily(run.identity)).toEqual(
    [
      ["grp", []],
      ["t1", [0]],
      ["t2", [1]],
      ["t3", [2]],
    ].map(([name, familyPath], index) => ({
      entityId: scene.entities[index]?.id,
      familyPath,
      name,
    })),
  );

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${run.publicationRevision}`,
  );
  const t1 = page.getByRole("button", { name: "Move t1", exact: true });
  const t2 = page.getByRole("button", { name: "Move t2", exact: true });
  const t3 = page.getByRole("button", { name: "Move t3", exact: true });
  await expect(t1).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  await expect(t2).toBeEnabled();
  await expect(t3).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  await expect(page.getByRole("button", { name: "Move grp", exact: true })).toHaveCount(0);

  const pristineRevision = await canvas.getAttribute("data-preview-revision");
  const pristinePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!pristineRevision || !pristinePacket) throw new Error("The pristine V10 frame has no retained identity.");
  await page.getByRole("button", { name: "Set position" }).click();
  await page.getByRole("checkbox", { name: "Select t2" }).check();
  const surface = await t2.evaluate((element) => {
    const rect = element.closest<HTMLElement>("[data-scene-phase]")?.getBoundingClientRect();
    return rect ? { height: rect.height, width: rect.width } : null;
  });
  if (!surface) throw new Error("The LineJoints edit target has no Studio surface.");
  await dragBy(page, t2, {
    x: (1.25 * surface.width) / scene.camera.view.frameWidth,
    y: (0.5 * surface.height) / scene.camera.view.frameHeight,
  });
  const movedFrame = await applyDraft(page, { packet: pristinePacket, revision: pristineRevision });
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);

  const scale = page.getByRole("spinbutton", { name: "Scale t2" });
  await expect(scale).toBeVisible();
  await scale.fill("0.5");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  const scaledFrame = await applyDraft(page, movedFrame);
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);

  const loweredSource = await exportedSource(page);
  const groupLayout = loweredSource.indexOf("        grp.set(width=config.frame_width - 1)");
  const moveCall = loweredSource.indexOf("        t2.move_to((1.25, -0.5, 0))");
  const scaleCall = loweredSource.indexOf("        t2.scale(0.5)");
  const addition = loweredSource.indexOf("        self.add(grp)");
  expect(groupLayout).toBeGreaterThanOrEqual(0);
  expect(moveCall).toBeGreaterThan(groupLayout);
  expect(scaleCall).toBeGreaterThan(moveCall);
  expect(addition).toBeGreaterThan(scaleCall);
  expect(loweredSource.match(/t2\.move_to\(/g)).toHaveLength(1);
  expect(loweredSource.match(/t2\.scale\(/g)).toHaveLength(1);

  const originalT2Id = run.identity.mappings.find(({ binding }) => binding.name === "t2")?.entityId;
  if (!originalT2Id) throw new Error("The official LineJoints identity map has no t2 binding.");
  const before = cubicWorldBounds(run.bundle, originalT2Id);
  const edited = await renderCommitAndReimport(page);
  expect(edited.snapshotHash).not.toBe(run.snapshotHash);
  expect(edited.bundle.scene.source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotHash: edited.snapshotHash,
    snapshotVersion: 10,
  });
  expect(edited.bundle.scene.source.sourceHash).not.toBe(OFFICIAL_SOURCE_SHA256);
  expect(edited.bundle.scene.entities).toHaveLength(4);
  expect(mappedFamily(edited.identity)).toEqual(
    [
      ["grp", []],
      ["t1", [0]],
      ["t2", [1]],
      ["t3", [2]],
    ].map(([name, familyPath], index) => ({
      entityId: edited.bundle.scene.entities[index]?.id,
      familyPath,
      name,
    })),
  );
  expect(
    edited.bundle.scene.entities
      .slice(1)
      .map((entity) => (entity.appearance.kind === "vector" ? entity.appearance.stroke?.join : null)),
  ).toEqual(EXPECTED_JOINS);
  const editedT2Id = edited.identity.mappings.find(({ binding }) => binding.name === "t2")?.entityId;
  if (!editedT2Id) throw new Error("The edited LineJoints identity map has no t2 binding.");
  const after = cubicWorldBounds(edited.bundle, editedT2Id);
  expect(after.center.x).toBeCloseTo(1.25, 10);
  expect(after.center.y).toBeCloseTo(-0.5, 10);
  expect(after.width / before.width).toBeCloseTo(0.5, 10);
  expect(after.height / before.height).toBeCloseTo(0.5, 10);

  await expect(canvas).toHaveAttribute("data-preview-revision", edited.snapshotHash, { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("selection only");
  const editedT2 = page.getByRole("button", { name: "Move t2", exact: true });
  await expect(editedT2).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  const studioEntityId = await editedT2.getAttribute("data-studio-entity");
  if (!studioEntityId) throw new Error("The edited t2 has no Studio identity.");
  const editedWrapper = page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`);
  await expect(editedWrapper).toHaveAttribute("data-studio-runtime-entity", editedT2Id);
  await expect(editedWrapper).toHaveAttribute("data-studio-runtime-binding", /.+/);
  await expect(editedWrapper).toHaveAttribute("data-studio-entity-scale", "0.5000");
  const [canvasBox, editedT2Box] = await Promise.all([canvas.boundingBox(), editedT2.boundingBox()]);
  if (!canvasBox || !editedT2Box) throw new Error("The edited LineJoints display bounds are unavailable.");
  expect((editedT2Box.x + editedT2Box.width / 2 - canvasBox.x) / canvasBox.width).toBeCloseTo(
    0.5 + 1.25 / scene.camera.view.frameWidth,
    2,
  );
  expect((editedT2Box.y + editedT2Box.height / 2 - canvasBox.y) / canvasBox.height).toBeCloseTo(
    0.5 + 0.5 / scene.camera.view.frameHeight,
    2,
  );

  await editedT2.click();
  await expect(editedT2).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Resize t2 from bottom-right corner" })).toHaveCount(0);
  await dragBy(page, editedT2, { x: 24, y: -12 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  expect(scaledFrame.revision).not.toBe(pristineRevision);
});

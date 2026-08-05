import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SOURCE_PATH = "example_scenes/basic.py";
const TRACKED_SOURCE_PATH = new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url);
const SCENE_LABEL = `${SOURCE_PATH} · WriteStuff`;
const OFFICIAL_SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const ROOTS = [
  { familyPath: [0], label: "example text", name: "example_text", sceneOrder: 1 },
  { familyPath: [1], label: "example tex", name: "example_tex", sceneOrder: 32 },
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
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === SNAPSHOT_PATH,
  );
}

async function openOfficialWriteStuff(page: Page) {
  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const responsePromise = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  // The V12 response is intentionally large enough for Chromium to evict it
  // from the DevTools response-body cache. Read the exact published revision
  // through the same-origin API instead of relying on Network.getResponseBody.
  return latestWriteStuffSnapshot(page);
}

function moveTarget(page: Page, label: string) {
  return page.getByRole("button", { exact: true, name: `Move ${label}` });
}

async function runtimeBox(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The source-bound WriteStuff root has no descendant interaction bounds.");
  return box;
}

async function exportedSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported WriteStuff source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The WriteStuff edit target is not visible.");
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
  if (!revision || !packet) throw new Error("The edited WriteStuff frame has no retained-frame identity.");
  return { packet, revision };
}

async function applyDraft(page: Page, previous: Readonly<{ packet: string; revision: string }>) {
  const draft = page.getByRole("heading", { name: "Draft program" });
  await expect(draft).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(draft).toHaveCount(0);
  return waitForNewPresentedFrame(page, previous);
}

async function latestWriteStuffSnapshot(page: Page) {
  const published = await page.evaluate(
    async ({ path, sceneName, sourcePath }) => {
      const query = new URLSearchParams({ sceneName, sourcePath });
      const latest = await fetch(`${path}?${query}`, { headers: { accept: "application/json" } });
      return { body: await latest.json(), status: latest.status };
    },
    { path: SNAPSHOT_PATH, sceneName: "WriteStuff", sourcePath: SOURCE_PATH },
  );
  expect(published.status).toBe(200);
  const body = published.body as SnapshotRunBody;
  expect(body).toMatchObject({ sceneName: "WriteStuff", sourcePath: SOURCE_PATH, status: "verified" });
  if (
    !body.snapshot?.bundle ||
    !body.snapshot.snapshotHash ||
    !body.sourceRuntimeIdentity ||
    typeof body.revision !== "number"
  ) {
    throw new Error("The verified WriteStuff V12 snapshot response is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

async function renderCommitAndReimport(page: Page) {
  const render = page.getByRole("button", { name: "Render program" });
  await expect(render).toBeVisible();
  await render.click();
  const commit = page.getByRole("button", { name: "Commit to source" });
  await expect(commit).toBeVisible({ timeout: 180_000 });
  await expect(commit).toBeEnabled();
  const video = page.getByLabel("Rendered Manim preview of WriteStuff");
  await expect(video).toBeVisible();
  await expect
    .poll(
      () =>
        video.evaluate((element: HTMLVideoElement) => ({
          durationMillis: Number.isFinite(element.duration) ? Math.round(element.duration * 1_000) : 0,
          height: element.videoHeight,
          width: element.videoWidth,
        })),
      { timeout: 30_000 },
    )
    .toEqual({ durationMillis: 4_000, height: 480, width: 854 });
  await commit.click();
  const dialog = page.getByRole("alertdialog", { name: "Commit rendered program?" });
  await expect(dialog).toBeVisible();
  const mutationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/api/manim/renders/") &&
      new URL(response.url()).pathname.endsWith("/commit"),
  );
  const response = snapshotResponse(page);
  await dialog.getByRole("button", { name: "Commit source" }).click();
  const mutation = await mutationResponse;
  expect(mutation.ok(), `Commit returned HTTP ${mutation.status()}.`).toBe(true);
  expect((await response).ok()).toBe(true);
  return latestWriteStuffSnapshot(page);
}

function mappedFamily(identity: VerifiedSourceRuntimeIdentityMapV1) {
  return identity.mappings.map(({ binding, entityId, familyPath }) => ({
    entityId,
    familyPath,
    name: binding.name,
  }));
}

function cubicFamilyWorldBounds(bundle: SceneIrBundleV1, rootId: string) {
  const byId = new Map(bundle.scene.entities.map((entity) => [entity.id, entity]));
  const belongsToRoot = (entityId: string) => {
    const seen = new Set<string>();
    let entity = byId.get(entityId);
    while (entity) {
      if (entity.id === rootId) return true;
      if (seen.has(entity.id) || entity.parentId === null) return false;
      seen.add(entity.id);
      entity = byId.get(entity.parentId);
    }
    return false;
  };
  const worldPoint = (entityId: string, point: Readonly<{ x: number; y: number }>) => {
    const transforms = [];
    const seen = new Set<string>();
    let entity = byId.get(entityId);
    while (entity) {
      if (seen.has(entity.id)) throw new Error("WriteStuff hierarchy contains a cycle.");
      seen.add(entity.id);
      transforms.push(entity.transform);
      entity = entity.parentId === null ? undefined : byId.get(entity.parentId);
    }
    return transforms.reduce(
      (current, transform) => ({
        x: transform.m11 * current.x + transform.m12 * current.y + transform.tx,
        y: transform.m21 * current.x + transform.m22 * current.y + transform.ty,
      }),
      point,
    );
  };
  const points = bundle.scene.entities.flatMap((entity) => {
    if (!belongsToRoot(entity.id) || entity.geometry.kind !== "cubic-path") return [];
    return entity.geometry.path.subpaths.flatMap((subpath) =>
      [subpath.start, ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end])].map(
        (point) => worldPoint(entity.id, point),
      ),
    );
  });
  if (points.length === 0) throw new Error(`WriteStuff entity ${rootId} has no cubic descendants.`);
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

test("opens official WriteStuff V12 with one bounded editable MathTex root", async ({ page }) => {
  test.setTimeout(180_000);
  const run = await openOfficialWriteStuff(page);
  const { scene } = run.bundle;
  expect(scene).toMatchObject({
    duration: 4,
    requiredCapabilities: [
      "cubic-path-geometry",
      "logical-group",
      "path-trim-animation",
      "vector-appearance-animation",
    ],
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotHash: run.snapshotHash,
      snapshotVersion: 12,
      sourceHash: OFFICIAL_SOURCE_SHA256,
    },
  });
  expect(scene.entities).toHaveLength(61);
  expect(scene.animationChannels).toHaveLength(58);
  expect(scene.animationChannels.filter(({ kind }) => kind === "path-trim")).toHaveLength(29);
  expect(scene.animationChannels.filter(({ kind }) => kind === "vector-appearance")).toHaveLength(29);

  const mappings = run.identity.mappings.map(({ binding, entityId, familyPath }) => ({
    entityId,
    familyPath,
    name: binding.name,
  }));
  expect(mappings).toEqual([
    { entityId: scene.entities[0]?.id, familyPath: [], name: "group" },
    ...ROOTS.map(({ familyPath, name, sceneOrder }) => ({
      entityId: scene.entities[sceneOrder]?.id,
      familyPath: [...familyPath],
      name,
    })),
  ]);

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${run.publicationRevision}`,
  );
  await expect(page.locator("[data-studio-preview-status]")).toContainText("editing preview only");
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();

  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "4");
  await playhead.fill("3.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "3.5");
  await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(2);
  await expect(moveTarget(page, "group")).toHaveCount(0);

  const runtimeEntityByName = new Map(mappings.map(({ entityId, name }) => [name, entityId]));
  const targets = ROOTS.map(({ label, name }) => ({ label, name, target: moveTarget(page, label) }));
  for (const { name, target } of targets) {
    await expect(target).toBeVisible();
    if (name === "example_text") {
      await expect(target).toHaveAttribute(
        "title",
        "This verified object can be selected, but source rewriting is unavailable.",
      );
    } else {
      await expect(target).not.toHaveAttribute("title", /source rewriting is unavailable/);
    }
    const studioEntityId = await target.getAttribute("data-studio-entity");
    if (!studioEntityId) throw new Error(`The ${name} root has no Studio identity.`);
    const wrapper = page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`);
    await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", runtimeEntityByName.get(name) ?? "");
    await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", /.+/);
    expect(Number(await wrapper.getAttribute("data-studio-entity-width"))).toBeGreaterThan(0);
    expect(Number(await wrapper.getAttribute("data-studio-entity-height"))).toBeGreaterThan(0);
  }

  const textBox = await runtimeBox(targets[0].target);
  const mathBox = await runtimeBox(targets[1].target);
  expect(textBox.y + textBox.height).toBeLessThan(mathBox.y);

  // Real pointer selection proves that each nested logical group receives its
  // own descendant union instead of a Scene-wide or empty logical-group box.
  await targets[0].target.click();
  await expect(targets[0].target).toHaveAttribute("aria-pressed", "true");
  await expect(targets[1].target).toHaveAttribute("aria-pressed", "false");
  await targets[1].target.click();
  await expect(targets[0].target).toHaveAttribute("aria-pressed", "false");
  await expect(targets[1].target).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Resize example tex from bottom-right corner" })).toBeVisible();

  const beforeDrag = await runtimeBox(targets[0].target);
  await targets[0].target.dragTo(canvas, { targetPosition: { x: 50, y: 50 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  const afterDrag = await runtimeBox(targets[0].target);
  expect(afterDrag).toEqual(beforeDrag);

  const packetIds = new Set<string>();
  for (const sampleTime of [0.25, 1, 2.5, 3.5]) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const packetId = await canvas.getAttribute("data-preview-packet-id");
    if (!packetId) throw new Error(`WriteStuff sample ${sampleTime} has no retained packet identity.`);
    packetIds.add(packetId);
  }
  expect(packetIds.size).toBe(4);

  await playhead.fill("2.5");
  await page.getByRole("button", { exact: true, name: "Play" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThan(2.5);
  await page.getByRole("button", { exact: true, name: "Pause" }).click();
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

  await playhead.fill("4");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "4");
  await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(1);
  await expect(targets[0].target).toHaveCount(0);
  await expect(targets[1].target).toBeVisible();
  await expect(page.getByRole("button", { name: /Resize example/ })).toHaveCount(0);
});

test("moves and uniformly scales only example_tex through GUI, Python, Manim, and reimport", async ({ page }) => {
  test.setTimeout(300_000);
  const trackedSourceBefore = await readFile(TRACKED_SOURCE_PATH, "utf8");
  const run = await openOfficialWriteStuff(page);
  const { scene } = run.bundle;
  const originalMathRootId = run.identity.mappings.find(({ binding }) => binding.name === "example_tex")?.entityId;
  if (!originalMathRootId) throw new Error("The official WriteStuff identity map has no example_tex binding.");
  const before = cubicFamilyWorldBounds(run.bundle, originalMathRootId);

  const canvas = page.locator("[data-studio-canvas]");
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "interactive");
  await playhead.fill("3.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "3.5");

  const exampleText = moveTarget(page, "example text");
  const exampleTex = moveTarget(page, "example tex");
  await expect(exampleText).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  await expect(exampleTex).toBeEnabled();
  const pristineRevision = await canvas.getAttribute("data-preview-revision");
  const pristinePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!pristineRevision || !pristinePacket) throw new Error("The pristine V12 frame has no retained identity.");

  await page.getByRole("button", { name: "Set position" }).click();
  await page.getByRole("checkbox", { exact: true, name: "Select example tex" }).check();
  const surface = await exampleTex.evaluate((element) => {
    const rect = element.closest<HTMLElement>("[data-scene-phase]")?.getBoundingClientRect();
    return rect ? { height: rect.height, width: rect.width } : null;
  });
  if (!surface) throw new Error("The WriteStuff edit target has no Studio surface.");
  await dragBy(page, exampleTex, {
    x: ((1.25 - before.center.x) * surface.width) / scene.camera.view.frameWidth,
    y: -((-0.5 - before.center.y) * surface.height) / scene.camera.view.frameHeight,
  });
  const dragDraft = page.getByRole("heading", { name: "Draft program" });
  await expect(dragDraft).toBeVisible();

  // Pointer coordinates are intentionally approximate. Use the same bounded
  // position GUI to refine that same draft to the exact canonical target.
  await expect(page.getByRole("spinbutton", { name: "X draft position of example tex" })).toBeVisible();
  const positionBase = {
    packet: (await canvas.getAttribute("data-preview-packet-id")) ?? pristinePacket,
    revision: (await canvas.getAttribute("data-preview-revision")) ?? pristineRevision,
  };
  await page.getByRole("spinbutton", { name: "X draft position of example tex" }).fill("376.25");
  await page.getByRole("spinbutton", { name: "Y draft position of example tex" }).fill("202.5");
  await page.getByRole("button", { exact: true, name: "Update draft position" }).click();
  const movedFrame = await applyDraft(page, positionBase);
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);

  await playhead.fill("3.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "3.5");
  const resizeHandle = page.getByRole("button", { name: "Resize example tex from bottom-right corner" });
  await expect(resizeHandle).toBeVisible();
  await dragBy(page, resizeHandle, { x: -24, y: -12 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Discard" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await playhead.fill("3.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "3.5");

  const scale = page.getByRole("spinbutton", { name: "Scale example tex" });
  await expect(scale).toBeEnabled();
  await scale.fill("0.5");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  const scaledFrame = await applyDraft(page, movedFrame);
  await expect(canvas).not.toHaveAttribute("data-preview-fallback-reason", /.+/);

  const loweredSource = await exportedSource(page);
  const groupLayout = loweredSource.indexOf('        group.width = config["frame_width"] - 2 * LARGE_BUFF');
  const moveCall = loweredSource.indexOf("        example_tex.move_to((1.25, -0.5, 0))");
  const scaleCall = loweredSource.indexOf("        example_tex.scale(0.5)");
  const firstWrite = loweredSource.indexOf("        self.play(Write(example_text))");
  expect(groupLayout).toBeGreaterThanOrEqual(0);
  expect(moveCall).toBeGreaterThan(groupLayout);
  expect(scaleCall).toBeGreaterThan(moveCall);
  expect(firstWrite).toBeGreaterThan(scaleCall);
  expect(loweredSource.match(/example_tex\.move_to\(/g)).toHaveLength(1);
  expect(loweredSource.match(/example_tex\.scale\(/g)).toHaveLength(1);

  const edited = await renderCommitAndReimport(page);
  expect(edited.snapshotHash).not.toBe(run.snapshotHash);
  expect(edited.bundle.scene.source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotHash: edited.snapshotHash,
    snapshotVersion: 12,
  });
  expect(edited.bundle.scene.source.sourceHash).not.toBe(OFFICIAL_SOURCE_SHA256);
  expect(edited.bundle.scene.entities).toHaveLength(61);
  expect(mappedFamily(edited.identity)).toEqual(
    [
      ["group", []],
      ["example_text", [0]],
      ["example_tex", [1]],
    ].map(([name, familyPath], index) => ({
      entityId: edited.bundle.scene.entities[index === 2 ? 32 : index]?.id,
      familyPath,
      name,
    })),
  );
  const editedMathRootId = edited.identity.mappings.find(({ binding }) => binding.name === "example_tex")?.entityId;
  if (!editedMathRootId) throw new Error("The edited WriteStuff identity map has no example_tex binding.");
  const after = cubicFamilyWorldBounds(edited.bundle, editedMathRootId);
  expect(after.center.x).toBeCloseTo(1.25, 10);
  expect(after.center.y).toBeCloseTo(-0.5, 10);
  expect(after.width / before.width).toBeCloseTo(0.5, 10);
  expect(after.height / before.height).toBeCloseTo(0.5, 10);

  await expect(canvas).toHaveAttribute("data-preview-revision", edited.snapshotHash, { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("selection only");
  await playhead.fill("3.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "3.5");
  const editedExampleTex = moveTarget(page, "example tex");
  await expect(editedExampleTex).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  const studioEntityId = await editedExampleTex.getAttribute("data-studio-entity");
  if (!studioEntityId) throw new Error("The edited example_tex has no Studio identity.");
  const editedWrapper = page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`);
  await expect(editedWrapper).toHaveAttribute("data-studio-runtime-entity", editedMathRootId);
  await expect(editedWrapper).toHaveAttribute("data-studio-runtime-binding", /.+/);
  await editedExampleTex.click();
  await expect(page.getByRole("button", { name: "Resize example tex from bottom-right corner" })).toHaveCount(0);
  await dragBy(page, editedExampleTex, { x: 24, y: -12 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  expect(scaledFrame.revision).not.toBe(pristineRevision);
  expect(await readFile(TRACKED_SOURCE_PATH, "utf8")).toBe(trackedSourceBefore);
});

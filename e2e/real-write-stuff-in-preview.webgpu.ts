import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SOURCE_PATH = "example_scenes/basic.py";
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
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
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
    throw new Error("The verified official WriteStuff V12 snapshot response is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

function moveTarget(page: Page, label: string) {
  return page.getByRole("button", { exact: true, name: `Move ${label}` });
}

async function runtimeBox(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The source-bound WriteStuff root has no descendant interaction bounds.");
  return box;
}

test("opens official WriteStuff V12 in Studio with retained WebGPU and nested selection-only bounds", async ({
  page,
}) => {
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
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${run.publicationRevision}`,
  );
  await expect(page.locator("[data-studio-preview-status]")).toContainText("selection only");
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
    await expect(target).toHaveAttribute(
      "title",
      "This verified object can be selected, but source rewriting is unavailable.",
    );
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
  await expect(page.getByRole("button", { name: /Resize example/ })).toHaveCount(0);

  const beforeDrag = await runtimeBox(targets[1].target);
  await targets[1].target.dragTo(canvas, { targetPosition: { x: 50, y: 50 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  const afterDrag = await runtimeBox(targets[1].target);
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
  await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(2);
  for (const { target } of targets) await expect(target).toBeVisible();
  await targets[0].target.click();
  await expect(targets[0].target).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Resize example/ })).toHaveCount(0);
});

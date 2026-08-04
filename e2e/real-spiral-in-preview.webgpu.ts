import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_LABEL = `${SOURCE_PATH} · SpiralInExample`;
const OFFICIAL_SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const LEAVES = [
  ["triangle", [0]],
  ["square", [1]],
  ["circle", [2]],
  ["pentagon", [3]],
  ["pi", [4]],
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

async function openOfficialSpiralIn(page: Page) {
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
  expect(body).toMatchObject({ sceneName: "SpiralInExample", sourcePath: SOURCE_PATH, status: "verified" });
  if (
    !body.snapshot?.bundle ||
    !body.snapshot.snapshotHash ||
    !body.sourceRuntimeIdentity ||
    typeof body.revision !== "number"
  ) {
    throw new Error("The verified official SpiralIn V11 snapshot response is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    identity: body.sourceRuntimeIdentity,
    publicationRevision: body.revision,
    snapshotHash: body.snapshot.snapshotHash,
  };
}

test("opens official SpiralIn V11 in Studio and retains selection-only leaves while scrubbing", async ({ page }) => {
  test.setTimeout(180_000);
  const run = await openOfficialSpiralIn(page);
  expect(run.bundle.scene).toMatchObject({
    duration: 3,
    requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "logical-group", "opacity-animation"],
    source: {
      kind: "imported-manim-server-snapshot",
      snapshotHash: run.snapshotHash,
      snapshotVersion: 11,
      sourceHash: OFFICIAL_SOURCE_SHA256,
    },
  });
  expect(run.bundle.scene.entities).toHaveLength(6);
  expect(run.bundle.scene.animationChannels).toHaveLength(11);
  expect(run.bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual([
    "opacity",
    "affine-transform",
    "opacity",
    "affine-transform",
    "opacity",
    "affine-transform",
    "opacity",
    "affine-transform",
    "opacity",
    "affine-transform",
    "opacity",
  ]);

  const mappings = run.identity.mappings.map(({ binding, entityId, familyPath }) => ({
    entityId,
    familyPath,
    name: binding.name,
  }));
  expect(mappings).toEqual([
    { entityId: run.bundle.scene.entities[0]?.id, familyPath: [], name: "shapes" },
    ...LEAVES.map(([name, familyPath], index) => ({
      entityId: run.bundle.scene.entities[index + 1]?.id,
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
  await expect(playhead).toHaveAttribute("max", "3");
  await playhead.fill("1.5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "1.5");
  await expect(page.getByRole("button", { name: "Move shapes", exact: true })).toHaveCount(0);

  const runtimeEntityByName = new Map(mappings.map(({ entityId, name }) => [name, entityId]));
  for (const [name] of LEAVES) {
    const target = page.getByRole("button", { name: `Move ${name}`, exact: true });
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute(
      "title",
      "This verified object can be selected, but source rewriting is unavailable.",
    );
    const studioEntityId = await target.getAttribute("data-studio-entity");
    if (!studioEntityId) throw new Error(`The ${name} leaf has no Studio identity.`);
    const wrapper = page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`);
    await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", runtimeEntityByName.get(name) ?? "");
    await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", /.+/);
  }

  const circle = page.getByRole("button", { name: "Move circle", exact: true });
  // The source-proven MathTex bounds must not cover the neighboring circle.
  // A real pointer click catches regressions that keyboard-only selection hides.
  await circle.click();
  await expect(circle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Resize circle/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const packetIds = new Set<string>();
  for (const sampleTime of [0.1, 0.5, 1, 2.5, 2.99]) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const packetId = await canvas.getAttribute("data-preview-packet-id");
    if (!packetId) throw new Error(`SpiralIn sample ${sampleTime} has no retained packet identity.`);
    packetIds.add(packetId);
  }
  expect(packetIds.size).toBe(5);

  await playhead.fill("3");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "3");
  for (const [name] of LEAVES) {
    await expect(page.getByRole("button", { name: `Move ${name}`, exact: true })).toHaveCount(0);
  }
  await playhead.fill("1");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
});

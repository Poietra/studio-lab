import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";
import { STUDIO_VIEWPORT } from "../src/studio/studio-viewport-geometry";

const PROJECT_ID = "real-preview-harness";
const SNAPSHOT_PATH = `/api/manim/projects/${PROJECT_ID}/scene-snapshots`;
const ASSET_PREFIX = `/api/manim/projects/${PROJECT_ID}/scene-snapshot-assets/`;

type RgbaPixel = readonly [number, number, number, number];

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance = 4) {
  for (const [index, component] of actual.entries()) {
    expect(Math.abs(component - expected[index])).toBeLessThanOrEqual(tolerance);
  }
}

function verifiedImageBounds(bundle: SceneIrBundleV1) {
  const entity = bundle.scene.entities.find(
    (candidate) => candidate.geometry.kind === "image" && candidate.appearance.kind === "image",
  );
  if (!entity || entity.geometry.kind !== "image") {
    throw new Error("The verified ImageMobject snapshot has no image entity.");
  }
  const { localRect } = entity.geometry;
  const points = [
    { x: localRect.left, y: localRect.bottom },
    { x: localRect.left, y: localRect.top },
    { x: localRect.right, y: localRect.bottom },
    { x: localRect.right, y: localRect.top },
  ].map(({ x, y }) => ({
    x: entity.transform.m11 * x + entity.transform.m12 * y + entity.transform.tx,
    y: entity.transform.m21 * x + entity.transform.m22 * y + entity.transform.ty,
  }));
  const minimumX = Math.min(...points.map(({ x }) => x));
  const maximumX = Math.max(...points.map(({ x }) => x));
  const minimumY = Math.min(...points.map(({ y }) => y));
  const maximumY = Math.max(...points.map(({ y }) => y));
  const { center, frameHeight, frameWidth } = bundle.scene.camera.view;
  return {
    centerFractionX: (minimumX + maximumX) / 2 / frameWidth - center.x / frameWidth + 0.5,
    centerFractionY: 0.5 - ((minimumY + maximumY) / 2 - center.y) / frameHeight,
    entity,
    height: maximumY - minimumY,
    heightFraction: (maximumY - minimumY) / frameHeight,
    width: maximumX - minimumX,
    widthFraction: (maximumX - minimumX) / frameWidth,
  };
}

async function waitForNewPresentedFrame(page: Page, previousRevision: string, previousPacket: string) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  const previewStatus = page.locator("[data-studio-preview-status]");
  await expect
    .poll(
      async () => {
        const [phase, reason, revision, packet, detail] = await Promise.all([
          canvasRoot.getAttribute("data-preview-renderer"),
          canvasRoot.getAttribute("data-preview-fallback-reason"),
          canvasRoot.getAttribute("data-preview-revision"),
          canvasRoot.getAttribute("data-preview-packet-id"),
          previewStatus.getAttribute("title"),
        ]);
        const presented =
          phase === "presented" &&
          revision !== null &&
          revision !== previousRevision &&
          packet !== null &&
          packet !== previousPacket;
        return presented ? "presented" : JSON.stringify({ detail, packet, phase, reason, revision });
      },
      { timeout: 15_000 },
    )
    .toBe("presented");
  const revision = await canvasRoot.getAttribute("data-preview-revision");
  const packet = await canvasRoot.getAttribute("data-preview-packet-id");
  if (!revision || !packet) throw new Error("The edited ImageMobject frame has no retained-frame identity.");
  expect(revision).toMatch(/^[0-9a-f]{64}$/);
  await expect(canvasRoot).not.toHaveAttribute("data-preview-fallback-reason", /.+/);
  return { packet, revision };
}

async function openImageWorkspace(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: "scene_image.py · RealImageScene" });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  const snapshot = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
  const asset = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(ASSET_PREFIX) &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return { asset, snapshot };
}

test("renders a real ImageMobject through verified PNG delivery and WebGPU readback", async ({ page }) => {
  test.setTimeout(120_000);
  const pending = await openImageWorkspace(page);
  const response = await pending.snapshot;
  const body = (await response.json()) as {
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
    sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
    status?: string;
  };
  expect(body.status).toBe("verified");
  if (!body.revision || !body.snapshot?.bundle || !body.snapshot.snapshotHash) {
    throw new Error("The verified ImageMobject snapshot response is incomplete.");
  }
  const bundle = body.snapshot.bundle;
  expect(bundle.scene.source).toMatchObject({ kind: "imported-manim-server-snapshot", snapshotVersion: 4 });
  expect(bundle.scene.requiredCapabilities).toEqual(["png-image"]);
  expect(bundle.assets.assets).toHaveLength(1);
  const manifestAsset = bundle.assets.assets[0]!;
  expect(manifestAsset).toMatchObject({
    byteLength: expect.any(Number),
    kind: "png-image",
    mediaType: "image/png",
    pixelHeight: 135,
    pixelWidth: 270,
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(bundle.scene.entities[0]).toMatchObject({
    appearance: { kind: "image", opacity: 1 },
    geometry: {
      asset: { assetId: manifestAsset.id, sha256: manifestAsset.sha256 },
      kind: "image",
      sampler: "nearest",
    },
  });
  expect(body.sourceRuntimeIdentity?.mappings).toMatchObject([
    { binding: { name: "image" }, entityId: bundle.scene.entities[0]?.id, familyPath: [] },
  ]);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("image.png");
  expect(serialized).not.toContain("objectKey");
  expect(serialized).not.toContain("versionId");

  const assetResponse = await pending.asset;
  expect(new URL(assetResponse.url()).pathname).toBe(`${ASSET_PREFIX}${manifestAsset.sha256}`);
  expect(assetResponse.headers()["content-type"]).toBe("image/png");
  expect(assetResponse.headers().etag).toBe(`"sha256:${manifestAsset.sha256}"`);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const previewOutcome = await page
    .waitForFunction(() => {
      const root = document.querySelector<HTMLElement>("[data-studio-canvas]");
      const phase = root?.dataset.previewRenderer;
      const reason = root?.dataset.previewFallbackReason;
      if (phase === "presented") return { phase };
      if (reason !== "install-failed") return null;
      return {
        detail: document.querySelector<HTMLElement>("[data-studio-preview-status]")?.title || null,
        phase,
        reason,
      };
    })
    .then((handle) => handle.jsonValue());
  expect(previewOutcome).toEqual({ phase: "presented" });
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${body.revision}`,
  );
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The retained ImageMobject frame did not expose its viewport.");

  const imageBounds = verifiedImageBounds(bundle);
  const mapping = body.sourceRuntimeIdentity?.mappings[0];
  if (!mapping) throw new Error("The verified ImageMobject has no source/runtime identity mapping.");
  const image = page.getByRole("button", { name: "Move image", exact: true });
  const selection = page.getByRole("checkbox", { name: "Select image" });
  await expect(selection).toBeVisible();
  await expect(image).toBeVisible();
  await expect(image).toBeEnabled();
  const studioEntityId = await image.getAttribute("data-studio-entity");
  if (!studioEntityId) throw new Error("The imported ImageMobject has no Studio entity identity.");
  const wrapper = page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", mapping.binding.id);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", mapping.entityId);
  await expect(wrapper).toHaveAttribute("data-studio-entity-width", imageBounds.width.toFixed(4));
  await expect(wrapper).toHaveAttribute("data-studio-entity-height", imageBounds.height.toFixed(4));
  const [canvasBox, imageBox] = await Promise.all([canvasRoot.boundingBox(), image.boundingBox()]);
  if (!canvasBox || !imageBox) throw new Error("The verified ImageMobject hit target is not visible.");
  expect(Math.abs(imageBox.width / canvasBox.width - imageBounds.widthFraction)).toBeLessThan(0.01);
  expect(Math.abs(imageBox.height / canvasBox.height - imageBounds.heightFraction)).toBeLessThan(0.01);
  expect(
    Math.abs((imageBox.x + imageBox.width / 2 - canvasBox.x) / canvasBox.width - imageBounds.centerFractionX),
  ).toBeLessThan(0.01);
  expect(
    Math.abs((imageBox.y + imageBox.height / 2 - canvasBox.y) / canvasBox.height - imageBounds.centerFractionY),
  ).toBeLessThan(0.01);

  await selection.check();
  await expect(selection).toBeChecked();
  await expect(image).toHaveAttribute("aria-pressed", "true");
  const resizeHandle = page.getByRole("button", { name: "Resize image from bottom-right corner" });
  await expect(resizeHandle).toBeVisible();
  await expect(resizeHandle).toHaveAttribute("data-studio-resize-handle", studioEntityId);
  await expect(page.locator(`[data-studio-resize-handle="${studioEntityId}"]`)).toHaveCount(4);

  const proof = await page.evaluate(
    async ({ asset, projectId, revision, scene, targetViewport }) => {
      const response = await fetch(
        `/api/manim/projects/${encodeURIComponent(projectId)}/scene-snapshot-assets/${asset.sha256}`,
        { headers: { accept: "image/png" } },
      );
      if (!response.ok) throw new Error(`Snapshot asset fetch failed with HTTP ${response.status}.`);
      const bytes = await response.arrayBuffer();
      const [widthPx, heightPx] = targetViewport.split("x").map(Number);
      const canvas = Object.assign(document.createElement("canvas"), { height: heightPx, width: widthPx });
      const { PoietraCanvasWorkerClient } = (await import(
        "/src/engine/canvas-worker-client.ts"
      )) as typeof import("../src/engine/canvas-worker-client");
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        "/src/engine/canvas-worker-evidence.ts"
      )) as typeof import("../src/engine/canvas-worker-evidence");
      const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
      try {
        await client.installScene({
          assetPayloads: [
            {
              assetId: asset.id,
              byteLength: asset.byteLength,
              bytes,
              mediaType: asset.mediaType,
              pixelHeight: asset.pixelHeight,
              pixelWidth: asset.pixelWidth,
              sha256: asset.sha256,
            },
          ],
          canvas,
          revision,
          snapshot: scene,
        });
        const frame = await client.render({ revision, sampleTime: 0, viewport: { heightPx, widthPx } });
        const evidence = await client.captureFrameEvidence({
          revision,
          samples: [
            { fractionX: 0.03, fractionY: 0.05 },
            { fractionX: 0.465, fractionY: 0.5 },
            { fractionX: 0.535, fractionY: 0.5 },
          ],
        });
        return { evidence, frame };
      } finally {
        client.dispose();
      }
    },
    {
      asset: manifestAsset,
      projectId: PROJECT_ID,
      revision: body.snapshot.snapshotHash,
      scene: bundle,
      targetViewport: viewport,
    },
  );
  expect(proof.frame).toMatchObject({ kind: "frame-presented", revision: body.snapshot.snapshotHash, sampleTime: 0 });
  expect(proof.evidence).toMatchObject({
    packetId: proof.frame.packetId,
    revision: body.snapshot.snapshotHash,
    sampleTime: 0,
  });
  const [background, red, blue] = proof.evidence.samples;
  expectPixelNear(background, [0, 0, 0, 255]);
  expectPixelNear(red, [255, 0, 0, 255]);
  expectPixelNear(blue, [0, 0, 255, 255]);

  const pristineRevision = await canvasRoot.getAttribute("data-preview-revision");
  const pristinePacket = await canvasRoot.getAttribute("data-preview-packet-id");
  if (!pristineRevision || !pristinePacket) throw new Error("The pristine retained frame has no identity.");
  await page.getByRole("button", { name: "Set position" }).click();
  await expect(page.getByRole("button", { name: "Set position" })).toHaveAttribute("aria-pressed", "true");
  await resizeHandle.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const scaledFrame = await waitForNewPresentedFrame(page, pristineRevision, pristinePacket);
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0500");
  await expect(wrapper).toHaveAttribute("data-studio-entity-width", (imageBounds.width * 1.05).toFixed(4));
  await expect(wrapper).toHaveAttribute("data-studio-entity-height", (imageBounds.height * 1.05).toFixed(4));
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0, { timeout: 30_000 });
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "presented");
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0500");
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
  const scaledBox = await image.boundingBox();
  if (!scaledBox) throw new Error("The resized ImageMobject hit target is not visible.");
  expect(Math.abs(scaledBox.width / imageBox.width - 1.05)).toBeLessThan(0.01);
  expect(Math.abs(scaledBox.height / imageBox.height - 1.05)).toBeLessThan(0.01);

  await resizeHandle.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const rescaledFrame = await waitForNewPresentedFrame(page, scaledFrame.revision, scaledFrame.packet);
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.1025");
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0, { timeout: 30_000 });
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "presented");
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.1025");
  const rescaledBox = await image.boundingBox();
  if (!rescaledBox) throw new Error("The repeatedly resized ImageMobject hit target is not visible.");
  expect(Math.abs(rescaledBox.width / imageBox.width - 1.1025)).toBeLessThan(0.01);
  expect(Math.abs(rescaledBox.height / imageBox.height - 1.1025)).toBeLessThan(0.01);

  await image.press("Shift+ArrowRight");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const editedFrame = await waitForNewPresentedFrame(page, rescaledFrame.revision, rescaledFrame.packet);
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", mapping.binding.id);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", mapping.entityId);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0, { timeout: 30_000 });
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", editedFrame.revision);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", mapping.binding.id);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", mapping.entityId);
  const movedBox = await image.boundingBox();
  if (!movedBox) throw new Error("The moved ImageMobject hit target is not visible.");
  expect(Math.abs(movedBox.x - rescaledBox.x - (10 / STUDIO_VIEWPORT.width) * canvasBox.width)).toBeLessThan(1.5);
  expect(Math.abs(movedBox.y - rescaledBox.y)).toBeLessThan(1.5);

  await page.getByRole("button", { name: "Render program" }).click();
  const commitButton = page.getByRole("button", { name: "Commit to source" });
  await expect(commitButton).toBeVisible({ timeout: 60_000 });
  await commitButton.click();
  const commitDialog = page.getByRole("alertdialog", { name: "Commit rendered program?" });
  await expect(commitDialog).toBeVisible();
  const rerun = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === SNAPSHOT_PATH &&
      candidate.status() === 200,
  );
  await commitDialog.getByRole("button", { name: "Commit source" }).click();
  const rerunBody = (await (await rerun).json()) as {
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
    sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
    status?: string;
  };
  expect(rerunBody.status).toBe("verified");
  expect(rerunBody.snapshot?.snapshotHash).not.toBe(body.snapshot.snapshotHash);
  if (!rerunBody.snapshot?.bundle || !rerunBody.revision) {
    throw new Error("The edited ImageMobject snapshot response is incomplete.");
  }
  const rerunBounds = verifiedImageBounds(rerunBody.snapshot.bundle);
  expect(rerunBounds.width).toBeCloseTo(imageBounds.width * 1.1025, 8);
  expect(rerunBounds.height).toBeCloseTo(imageBounds.height * 1.1025, 8);
  expect(rerunBounds.centerFractionX - imageBounds.centerFractionX).toBeCloseTo(10 / STUDIO_VIEWPORT.width, 8);
  expect(rerunBounds.centerFractionY).toBeCloseTo(imageBounds.centerFractionY, 8);
  const rerunMapping = rerunBody.sourceRuntimeIdentity?.mappings.find(
    (candidate) => candidate.binding.name === "image",
  );
  if (!rerunMapping) throw new Error("The edited ImageMobject did not re-correlate to its source binding.");
  await waitForNewPresentedFrame(page, editedFrame.revision, editedFrame.packet);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", rerunMapping.binding.id);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", rerunMapping.entityId);
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    `verified server snapshot r${rerunBody.revision}`,
  );
});

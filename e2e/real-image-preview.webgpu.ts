import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const PROJECT_ID = "real-preview-harness";
const SNAPSHOT_PATH = `/api/manim/projects/${PROJECT_ID}/scene-snapshots`;
const ASSET_PREFIX = `/api/manim/projects/${PROJECT_ID}/scene-snapshot-assets/`;

type RgbaPixel = readonly [number, number, number, number];

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance = 4) {
  for (const [index, component] of actual.entries()) {
    expect(Math.abs(component - expected[index])).toBeLessThanOrEqual(tolerance);
  }
}

async function openImageWorkspace(page: Page) {
  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: "scene_image.py · RealImageScene" });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
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
});

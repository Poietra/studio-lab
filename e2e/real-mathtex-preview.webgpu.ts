import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
type RgbaPixel = readonly [number, number, number, number];

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function openMathTexWorkspace(page: Page, sceneLabel: string) {
  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: sceneLabel });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function verifiedSnapshot(responsePromise: ReturnType<typeof snapshotResponse>) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
    status?: string;
  };
  expect(body.status).toBe("verified");
  expect(body.revision).toBeGreaterThan(0);
  if (!body.snapshot?.bundle || !body.snapshot.snapshotHash || !body.revision) {
    throw new Error("The verified MathTex snapshot is incomplete.");
  }
  return { bundle: body.snapshot.bundle, engineRevision: body.snapshot.snapshotHash, revision: body.revision };
}

async function expectPresented(page: Page, revision: number) {
  const canvas = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const phase = await canvas.getAttribute("data-preview-renderer");
        const reason = await canvas.getAttribute("data-preview-fallback-reason");
        return phase === "presented" || reason === "install-failed" ? { phase, reason } : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const phase = await canvas.getAttribute("data-preview-renderer");
  if (phase !== "presented") {
    const detail = await page.locator("[data-studio-preview-status]").getAttribute("title");
    throw new Error(`The retained WebGPU renderer failed to install the verified snapshot: ${detail ?? "no detail"}`);
  }
  await expect(canvas).toHaveAttribute("data-preview-packet-id", /^canvas:\d+$/);
  await expect(canvas).toHaveAttribute("data-preview-viewport", /^\d+x\d+$/);
  await expect(page.locator("[data-studio-preview-status]")).toContainText(`verified server snapshot r${revision}`);
  const viewport = await canvas.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The retained WebGPU frame did not expose its viewport.");
  return viewport;
}

async function capturePixels(
  page: Page,
  snapshot: SceneIrBundleV1,
  revision: string,
  viewport: string,
  points: readonly Readonly<{ fractionX: number; fractionY: number }>[],
): Promise<readonly RgbaPixel[]> {
  return page.evaluate(
    async ({ requestedRevision, samples, scene, targetViewport }) => {
      const [width, height] = targetViewport.split("x").map(Number);
      const canvas = Object.assign(document.createElement("canvas"), { height, width });
      const { PoietraCanvasWorkerClient } = (await import(
        "/src/engine/canvas-worker-client.ts"
      )) as typeof import("../src/engine/canvas-worker-client");
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        "/src/engine/canvas-worker-evidence.ts"
      )) as typeof import("../src/engine/canvas-worker-evidence");
      const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
      try {
        await client.installScene({ canvas, revision: requestedRevision, snapshot: scene });
        await client.render({
          revision: requestedRevision,
          sampleTime: 0,
          viewport: { heightPx: height, widthPx: width },
        });
        const pixels: RgbaPixel[] = [];
        for (let offset = 0; offset < samples.length; offset += 16) {
          const evidence = await client.captureFrameEvidence({
            revision: requestedRevision,
            samples: samples.slice(offset, offset + 16),
          });
          pixels.push(...evidence.samples);
        }
        return pixels;
      } finally {
        client.dispose();
      }
    },
    { requestedRevision: revision, samples: points, scene: snapshot, targetViewport: viewport },
  );
}

async function horizontalInkMask(page: Page, snapshot: SceneIrBundleV1, revision: string, viewport: string) {
  const points = Array.from({ length: 49 }, (_, index) => ({
    fractionX: 0.44 + (index / 48) * 0.12,
    fractionY: 0.5,
  }));
  return (await capturePixels(page, snapshot, revision, viewport, points)).map(
    ([red, green, blue]) => Math.max(red, green, blue) > 32,
  );
}

test("renders a real Python MathTex Scene through snapshot V3 on retained WebGPU", async ({ page }) => {
  const run = await verifiedSnapshot(openMathTexWorkspace(page, "scene_mathtex.py · RealMathTexScene"));
  expect(run.bundle.scene.source).toMatchObject({
    kind: "imported-manim-server-snapshot",
    snapshotVersion: 3,
  });
  expect(run.bundle.scene.entities).toHaveLength(1);
  const entity = run.bundle.scene.entities[0]!;
  expect(entity.geometry.kind).toBe("cubic-path");
  if (entity.geometry.kind !== "cubic-path" || entity.appearance.kind !== "vector") {
    throw new Error("The MathTex producer did not emit one vector cubic outline.");
  }
  expect(entity.geometry.path.subpaths.length).toBeGreaterThan(1);
  expect(entity.geometry.path.subpaths.every(({ closed }) => closed)).toBe(true);
  expect(entity.appearance.fill?.rule).toBe("nonzero");
  expect(entity.appearance.stroke).toBeNull();
  const browserPayload = JSON.stringify(run.bundle);
  expect(browserPayload).not.toContain("E = mc^2");
  expect(browserPayload).not.toContain(".otf");
  expect(browserPayload).not.toContain("<svg");
  const viewport = await expectPresented(page, run.revision);
  expect((await horizontalInkMask(page, run.bundle, run.engineRevision, viewport)).some(Boolean)).toBe(true);
});

test("preserves a real glyph counter as black between two WebGPU ink runs", async ({ page }) => {
  const run = await verifiedSnapshot(openMathTexWorkspace(page, "scene_mathtex_counter.py · RealMathTexCounterScene"));
  const viewport = await expectPresented(page, run.revision);
  const revision = run.engineRevision;
  const mask = await horizontalInkMask(page, run.bundle, revision, viewport);
  const firstInk = mask.indexOf(true);
  const lastInk = mask.lastIndexOf(true);
  expect(firstInk).toBeGreaterThanOrEqual(0);
  expect(lastInk).toBeGreaterThan(firstInk);
  expect(mask.slice(firstInk + 1, lastInk).some((ink) => !ink)).toBe(true);
  const background = await capturePixels(page, run.bundle, revision, viewport, [{ fractionX: 0.03, fractionY: 0.05 }]);
  expect(background[0]).toEqual([0, 0, 0, 255]);
});

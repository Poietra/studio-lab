import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const SCENE_LABEL = "scene_mathtex_morph.py · RealMathTexMorphScene";
type RgbaPixel = readonly [number, number, number, number];

// Four evidence requests per frame: a dense horizontal scan through the
// equation plus a vertical scan through its centre. Keep this fixed so an
// endpoint cannot choose samples that merely suit its own bounds.
const PIXEL_EVIDENCE_POINTS = [
  ...Array.from({ length: 49 }, (_, index) => ({
    fractionX: 0.44 + (index / 48) * 0.12,
    fractionY: 0.5,
  })),
  ...Array.from({ length: 15 }, (_, index) => ({
    fractionX: 0.5,
    fractionY: 0.42 + (index / 14) * 0.16,
  })),
] as const;

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function captureSnapshotBodyInPage(page: Page) {
  await page.evaluate((snapshotPath) => {
    const scope = globalThis as typeof globalThis & {
      __poietraSnapshotBodyV5?: Promise<unknown>;
    };
    let resolveBody: (body: unknown) => void;
    let rejectBody: (error: unknown) => void;
    scope.__poietraSnapshotBodyV5 = new Promise((resolve, reject) => {
      resolveBody = resolve;
      rejectBody = reject;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...arguments_) => {
      const response = await originalFetch(...arguments_);
      const [input, init] = arguments_;
      const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const requestMethod = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (requestMethod.toUpperCase() === "POST" && new URL(requestUrl, location.href).pathname === snapshotPath) {
        globalThis.fetch = originalFetch;
        response.clone().json().then(resolveBody, rejectBody);
      }
      return response;
    };
  }, SNAPSHOT_PATH);
}

async function openMorphWorkspace(page: Page) {
  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  await captureSnapshotBodyInPage(page);
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function verifiedSnapshot(page: Page, responsePromise: ReturnType<typeof snapshotResponse>) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await page.evaluate(() => {
    const captured = (
      globalThis as typeof globalThis & {
        __poietraSnapshotBodyV5?: Promise<unknown>;
      }
    ).__poietraSnapshotBodyV5;
    if (!captured) throw new Error("The browser did not install the V5 snapshot response capture.");
    return captured;
  })) as {
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
    sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
    status?: string;
  };
  expect(body.status).toBe("verified");
  if (!body.snapshot?.bundle || !body.snapshot.snapshotHash || !body.revision) {
    throw new Error("The verified MathTex morph snapshot is incomplete.");
  }
  return {
    bundle: body.snapshot.bundle,
    engineRevision: body.snapshot.snapshotHash,
    revision: body.revision,
    sourceRuntimeIdentity: body.sourceRuntimeIdentity,
  };
}

async function independentWebGpuProofs(
  page: Page,
  input: Readonly<{
    entityId: string;
    revision: string;
    snapshot: SceneIrBundleV1;
    times: readonly number[];
    viewport: string;
  }>,
) {
  return page.evaluate(
    async ({ entityId, points, revision, snapshot, times, viewport }) => {
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
        const proofs = [];
        for (const sampleTime of times) {
          const frame = await client.render({
            interactionEntityIds: [entityId],
            revision,
            sampleTime,
            viewport: { heightPx, widthPx },
          });
          const evidence = [];
          const pixels: RgbaPixel[] = [];
          for (let offset = 0; offset < points.length; offset += 16) {
            const batch = await client.captureFrameEvidence({
              revision,
              samples: points.slice(offset, offset + 16),
            });
            evidence.push(batch);
            pixels.push(...batch.samples);
          }
          proofs.push({ evidence, frame, pixels });
        }
        return proofs;
      } finally {
        client.dispose();
      }
    },
    { ...input, points: PIXEL_EVIDENCE_POINTS },
  );
}

test("scrubs a real A/B/A MathTex morph continuously on retained WebGPU", async ({ page }) => {
  const run = await verifiedSnapshot(page, openMorphWorkspace(page));
  expect(run.bundle.scene).toMatchObject({
    duration: 5.5,
    requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
    source: { kind: "imported-manim-server-snapshot", snapshotVersion: 5 },
  });
  expect(run.sourceRuntimeIdentity?.mappings).toEqual([]);
  expect(run.bundle.scene.entities).toHaveLength(1);
  expect(run.bundle.scene.animationChannels).toHaveLength(1);
  const entity = run.bundle.scene.entities[0]!;
  const channel = run.bundle.scene.animationChannels[0]!;
  expect(entity.geometry.kind).toBe("cubic-path");
  expect(channel.kind).toBe("path-morph");
  if (entity.geometry.kind !== "cubic-path" || channel.kind !== "path-morph") {
    throw new Error("The V5 producer did not emit one aggregate cubic-path morph track.");
  }
  expect(channel.entityId).toBe(entity.id);
  expect(channel.keyframes.map(({ at }) => at)).toEqual([1, 2, 2.5, 4.5]);
  expect(channel.keyframes[0]?.value).toEqual(entity.geometry.path);
  expect(channel.keyframes[0]?.value).toEqual(channel.keyframes[3]?.value);
  expect(channel.keyframes[1]?.value).toEqual(channel.keyframes[2]?.value);
  expect(channel.keyframes[0]?.value).not.toEqual(channel.keyframes[1]?.value);
  const browserPayload = JSON.stringify(run.bundle);
  expect(browserPayload).not.toContain("E = mc^2");
  expect(browserPayload).not.toContain("\\nabla");

  const canvas = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const phase = await canvas.getAttribute("data-preview-renderer");
        const reason = await canvas.getAttribute("data-preview-fallback-reason");
        const terminalFallback = reason !== null && reason !== "installing" && reason !== "frame-pending";
        return phase === "presented" || terminalFallback ? { phase, reason } : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  if ((await canvas.getAttribute("data-preview-renderer")) !== "presented") {
    const detail = await page.locator("[data-studio-preview-status]").getAttribute("title");
    throw new Error(`The retained WebGPU renderer failed to install the V5 snapshot: ${detail ?? "no detail"}`);
  }
  await expect(canvas).toHaveAttribute("data-preview-interaction", "display-only");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("display only");
  const viewport = await canvas.getAttribute("data-preview-viewport");
  if (!viewport) throw new Error("The retained V5 frame did not expose its viewport.");

  const times = [0.5, 1.5, 2.25, 3.5, 5] as const;
  const proofs = await independentWebGpuProofs(page, {
    entityId: entity.id,
    revision: run.engineRevision,
    snapshot: run.bundle,
    times,
    viewport,
  });
  const frames = proofs.map(({ frame }) => frame);
  expect(frames.map((frame) => frame.sampleTime)).toEqual(times);
  expect(frames.every((frame) => frame.kind === "frame-presented")).toBe(true);
  const bounds = frames.map((frame) => frame.interaction.entries[0]);
  expect(bounds.every((entry) => entry?.status === "present")).toBe(true);
  expect(bounds[0]).toEqual(bounds[4]);
  expect(bounds[0]).not.toEqual(bounds[2]);
  expect(bounds[1]).not.toEqual(bounds[0]);
  expect(bounds[1]).not.toEqual(bounds[2]);
  expect(bounds[3]).not.toEqual(bounds[2]);
  expect(bounds[3]).not.toEqual(bounds[4]);

  for (const { evidence, frame, pixels } of proofs) {
    expect(pixels).toHaveLength(PIXEL_EVIDENCE_POINTS.length);
    expect(pixels.some(([red, green, blue]) => Math.max(red, green, blue) > 32)).toBe(true);
    expect(evidence).toHaveLength(Math.ceil(PIXEL_EVIDENCE_POINTS.length / 16));
    for (const batch of evidence) {
      expect(batch).toMatchObject({
        packetId: frame.packetId,
        revision: run.engineRevision,
        sampleTime: frame.sampleTime,
      });
      expect(`${batch.viewport.widthPx}x${batch.viewport.heightPx}`).toBe(viewport);
      expect(batch.samples.length).toBeLessThanOrEqual(16);
    }
  }
  const pixels = proofs.map(({ pixels: samples }) => samples);
  expect(pixels[0]).toEqual(pixels[4]);
  expect(pixels[0]).not.toEqual(pixels[2]);
  expect(pixels[1]).not.toEqual(pixels[0]);
  expect(pixels[1]).not.toEqual(pixels[2]);
  expect(pixels[3]).not.toEqual(pixels[2]);
  expect(pixels[3]).not.toEqual(pixels[4]);

  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "5.5");
  const packetIds = new Set<string>();
  const seekTimes = [0.5, 1.01, 1.5, 2.25, 3.5, 4.49, 5] as const;
  for (const sampleTime of seekTimes) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    packetIds.add((await canvas.getAttribute("data-preview-packet-id")) ?? "");
  }
  expect(packetIds.size).toBe(seekTimes.length);
});

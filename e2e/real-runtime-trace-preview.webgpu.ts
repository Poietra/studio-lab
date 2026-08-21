import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";

const RUNTIME_TRACE_PATH = "/api/manim/projects/real-preview-harness/runtime-traces";

function runtimeTraceResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === RUNTIME_TRACE_PATH &&
      response.status() === 200,
    { timeout: 120_000 },
  );
}

async function startRuntimeTraceScene(page: Page, sceneLabel: string) {
  await page.getByLabel("Active imported Scene").selectOption({ label: sceneLabel });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  const response = runtimeTraceResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function openRuntimeTraceScene(page: Page, sceneLabel: string) {
  await page.addInitScript(() => {
    const requestKinds: string[] = [];
    const canvasSnapshots: unknown[] = [];
    const NativeWorker = globalThis.Worker;
    const studioCanvasWorkers = new WeakSet<Worker>();
    class ObservedWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (new URL(String(scriptURL), location.href).pathname.includes("poietra-canvas")) {
          studioCanvasWorkers.add(this);
        }
      }

      override postMessage(message: unknown, transferOrOptions?: StructuredSerializeOptions | Transferable[]) {
        if (studioCanvasWorkers.has(this)) {
          const kind = (message as Readonly<{ kind?: unknown }>).kind;
          if (typeof kind === "string") requestKinds.push(kind);
          const snapshotJson = (message as Readonly<{ snapshotJson?: unknown }>).snapshotJson;
          if ((kind === "install-canvas" || kind === "replace-scene") && snapshotJson instanceof ArrayBuffer) {
            canvasSnapshots.push(JSON.parse(new TextDecoder().decode(snapshotJson)) as unknown);
          }
        }
        if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
        else super.postMessage(message, transferOrOptions);
      }
    }
    Object.defineProperty(globalThis, "__poietraStudioCanvasWorkerRequestKindsV1", {
      configurable: false,
      enumerable: false,
      value: requestKinds,
      writable: false,
    });
    Object.defineProperty(globalThis, "__poietraCanvasSnapshotsV1", {
      configurable: false,
      enumerable: false,
      value: canvasSnapshots,
      writable: false,
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: ObservedWorker,
      writable: true,
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  return startRuntimeTraceScene(page, sceneLabel);
}

async function installedCanvasSnapshots(page: Page) {
  const snapshots = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __poietraCanvasSnapshotsV1?: readonly unknown[] })
        .__poietraCanvasSnapshotsV1 ?? [],
  );
  return snapshots.map((snapshot) => sceneIrBundleV1Schema.parse(snapshot));
}

function vectorPaintAlphas(bundle: SceneIrBundleV1) {
  return bundle.scene.entities.flatMap((entity) => {
    if (entity.appearance.kind !== "vector") return [];
    return [entity.appearance.fill?.color.alpha, entity.appearance.stroke?.color.alpha].filter(
      (alpha): alpha is number => alpha !== undefined,
    );
  });
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("The NumberPlane prepared hit target is unavailable.");
  const origin = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 4 });
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
        return phase === "presented" && revision !== previousRevision && packet !== previousPacket
          ? "presented"
          : JSON.stringify({ packet, phase, reason, revision });
      },
      { timeout: 30_000 },
    )
    .toBe("presented");
  const revision = await canvas.getAttribute("data-preview-revision");
  const packet = await canvas.getAttribute("data-preview-packet-id");
  if (!revision || !packet) throw new Error("The edited NumberPlane frame has no retained identity.");
  return { packet, revision };
}

async function downloadedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const path = await (await downloadPromise).path();
  if (!path) throw new Error("Chromium did not persist the NumberPlane source export.");
  return readFile(path, "utf8");
}

async function decodedLocalMp4(page: Page) {
  const control = page.locator("[data-studio-export-mp4-state]");
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 }).catch(() => null);
  await page.getByRole("button", { name: "Export MP4" }).click();
  await expect
    .poll(async () => control.getAttribute("data-studio-export-mp4-state"), { timeout: 90_000 })
    .toMatch(/^(done|refused)$/u);
  if ((await control.getAttribute("data-studio-export-mp4-state")) === "refused") {
    const reason = await control.getAttribute("data-studio-export-mp4-reason");
    test.skip(reason === "unsupported-codec", "This Chromium build has no supported H.264 WebCodecs encoder.");
    throw new Error(`The NumberPlane MP4 export was refused: ${reason ?? "unknown"}.`);
  }
  const download = await downloadPromise;
  if (!download) throw new Error("The NumberPlane MP4 was not downloaded.");
  const path = await download.path();
  if (!path) throw new Error("Chromium did not persist the NumberPlane MP4.");
  const mp4Base64 = (await readFile(path)).toString("base64");
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The NumberPlane MP4 did not decode.")), 15_000);
        video.addEventListener(
          "loadeddata",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        video.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error(video.error?.message || "Chromium rejected the NumberPlane MP4."));
          },
          { once: true },
        );
        video.load();
      });
      await new Promise<void>((resolve) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.currentTime = Math.min(video.duration / 2, Math.max(0, video.duration - 0.001));
      });
      const canvas = Object.assign(document.createElement("canvas"), {
        height: video.videoHeight,
        width: video.videoWidth,
      });
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      if (!context) throw new Error("The NumberPlane MP4 decode canvas is unavailable.");
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let brightPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 90) {
          brightPixels += 1;
        }
      }
      return {
        brightPixels,
        duration: video.duration,
        height: video.videoHeight,
        width: video.videoWidth,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, mp4Base64);
}

test("applies construction-time opacity through real Runtime Trace and retained WebGPU", async ({ page }) => {
  test.setTimeout(180_000);
  const response = await openRuntimeTraceScene(page, "scene_runtime_trace_v3.py · StaticSquare");
  expect(response.ok()).toBe(true);
  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 60_000 });
  const baseRevision = await canvas.getAttribute("data-preview-revision");
  const basePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!baseRevision || !basePacket) throw new Error("StaticSquare has no retained WebGPU identity.");
  await expect.poll(async () => (await installedCanvasSnapshots(page)).length).toBeGreaterThan(0);
  const baseSnapshots = await installedCanvasSnapshots(page);
  const baseBundle = baseSnapshots.at(-1)!;
  expect(baseBundle.scene.source.kind).toBe("imported-manim-runtime-trace");
  expect(vectorPaintAlphas(baseBundle)).toEqual([0.6, 1]);
  await page.getByRole("button", { exact: true, name: "Move square" }).click();
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  const opacity = page.getByLabel("Opacity square");
  await expect(opacity).toBeEnabled();
  await opacity.fill("0.25");
  await opacity.press("Enter");
  await waitForNewPresentedFrame(page, baseRevision, basePacket);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const exportResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/manim/projects/real-preview-harness/export",
  );
  await page.getByRole("button", { name: "Apply program" }).click();
  const exported = await exportResponse;
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toContain("square.set_opacity(0.25)");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(baseRevision);
  await expect.poll(async () => (await installedCanvasSnapshots(page)).length).toBeGreaterThan(baseSnapshots.length);
  const editedSnapshots = await installedCanvasSnapshots(page);
  const editedBundle = editedSnapshots.at(-1)!;
  expect(editedBundle.scene.source.kind).toBe("studio-edit-program");
  expect(vectorPaintAlphas(editedBundle)).toEqual([0.25, 0.25]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(canvas).toHaveAttribute("data-preview-revision", baseRevision);
  await expect.poll(async () => (await installedCanvasSnapshots(page)).length).toBeGreaterThan(editedSnapshots.length);
  const restoredBundle = (await installedCanvasSnapshots(page)).at(-1)!;
  expect(restoredBundle.scene.source.kind).toBe("imported-manim-runtime-trace");
  expect(vectorPaintAlphas(restoredBundle)).toEqual([0.6, 1]);
});

test("validates a static NumberPlane move and round-trips its scale through Runtime Trace and WebCodecs", async ({
  page,
}) => {
  test.setTimeout(360_000);
  const sceneLabel = "scene_number_plane.py · StaticNumberPlane";
  const response = await openRuntimeTraceScene(page, sceneLabel);
  expect(response.ok()).toBe(true);

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 120_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "bounded-interactive");
  await expect.poll(async () => (await installedCanvasSnapshots(page)).length).toBeGreaterThan(0);
  const pristineBundle = (await installedCanvasSnapshots(page)).at(-1)!;
  expect(pristineBundle.scene.source.kind).toBe("imported-manim-runtime-trace");

  const grid = page.getByRole("button", { name: "Move grid", exact: true });
  await expect(grid).toBeVisible();
  await expect(grid).toBeEnabled();
  const entityId = await grid.getAttribute("data-studio-entity");
  if (!entityId) throw new Error("The NumberPlane did not retain a Studio root identity.");
  const wrapper = page.locator(`[data-studio-entity-wrapper="${entityId}"]`);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", /.+/u);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", /.+/u);
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");

  const [canvasBounds, pristineBounds] = await Promise.all([canvas.boundingBox(), grid.boundingBox()]);
  if (!canvasBounds || !pristineBounds) throw new Error("The NumberPlane prepared hit bounds are unavailable.");
  expect(pristineBounds.width).toBeGreaterThan(canvasBounds.width * 0.7);
  expect(pristineBounds.height).toBeGreaterThan(canvasBounds.height * 0.7);
  const positionMode = page.getByRole("button", { name: "Set position" });
  await positionMode.click();
  await expect(positionMode).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("checkbox", { name: "Select grid", exact: true }).check();
  await expect(grid).toHaveAttribute("aria-pressed", "true");

  const pristineRevision = await canvas.getAttribute("data-preview-revision");
  const pristinePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!pristineRevision || !pristinePacket) throw new Error("The pristine NumberPlane frame has no identity.");
  await dragBy(page, grid, { x: 30, y: -18 });
  await waitForNewPresentedFrame(page, pristineRevision, pristinePacket);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", /.+/u);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", /.+/u);
  const movedBounds = await grid.boundingBox();
  if (!movedBounds) throw new Error("The moved NumberPlane hit bounds are unavailable.");
  expect(Math.abs(movedBounds.x - pristineBounds.x - 30)).toBeLessThan(2);
  expect(Math.abs(movedBounds.y - pristineBounds.y + 18)).toBeLessThan(2);

  const moveValidation = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/manim/projects/real-preview-harness/export",
    { timeout: 120_000 },
  );
  await page.getByRole("button", { name: "Apply program" }).click();
  const moveResponse = await moveValidation;
  const movedSource = await moveResponse.text();
  expect(moveResponse.ok(), movedSource).toBe(true);
  expect(movedSource).toMatch(/grid\.move_to\(\([^\n]+, [^\n]+, 0\)\)/u);
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(canvas).toHaveAttribute("data-preview-revision", pristineRevision);
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");
  await page.getByRole("checkbox", { name: "Select grid", exact: true }).check();
  await expect(grid).toHaveAttribute("aria-pressed", "true");

  const scaleBaseRevision = await canvas.getAttribute("data-preview-revision");
  const scaleBasePacket = await canvas.getAttribute("data-preview-packet-id");
  if (!scaleBaseRevision || !scaleBasePacket) throw new Error("The restored NumberPlane frame has no identity.");

  const scale = page.getByRole("spinbutton", { name: "Scale grid" });
  await expect(scale).toBeEnabled();
  await scale.fill("0.8");
  await scale.press("Enter");
  await waitForNewPresentedFrame(page, scaleBaseRevision, scaleBasePacket);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "0.8000");

  const scaleValidation = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/manim/projects/real-preview-harness/export",
    { timeout: 120_000 },
  );
  await page.getByRole("button", { name: "Apply program" }).click();
  const scaleResponse = await scaleValidation;
  const scaledSource = await scaleResponse.text();
  expect(scaleResponse.ok(), scaledSource).toBe(true);
  expect(scaledSource).toContain("grid.scale(0.8)");
  expect(scaledSource).not.toContain("grid.move_to((");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  expect(await downloadedSource(page)).toBe(scaledSource);

  const appliedRevision = await canvas.getAttribute("data-preview-revision");
  const appliedPacket = await canvas.getAttribute("data-preview-packet-id");
  if (!appliedRevision || !appliedPacket) throw new Error("The applied NumberPlane scale has no retained identity.");
  await page.getByRole("button", { name: "Render program" }).click();
  const commit = page.getByRole("button", { name: "Commit to source" });
  await expect(commit).toBeVisible({ timeout: 180_000 });
  await expect(commit).toBeEnabled();
  await expect(page.getByLabel("Rendered Manim preview of StaticNumberPlane")).toBeVisible();
  await commit.click();
  const commitDialog = page.getByRole("alertdialog", { name: "Commit rendered program?" });
  await expect(commitDialog).toBeVisible();
  const freshTrace = runtimeTraceResponse(page);
  await commitDialog.getByRole("button", { name: "Commit source" }).click();
  expect((await freshTrace).ok()).toBe(true);
  await waitForNewPresentedFrame(page, appliedRevision, appliedPacket);
  await expect(grid).toHaveAttribute("data-studio-entity", entityId);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", /.+/u);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", /.+/u);
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");
  const freshBounds = await grid.boundingBox();
  if (!freshBounds) throw new Error("The freshly traced NumberPlane hit bounds are unavailable.");
  expect(freshBounds.width).toBeLessThan(pristineBounds.width * 0.85);
  expect(freshBounds.height).toBeLessThan(pristineBounds.height * 0.85);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  const magicEditToggle = page.getByRole("button", { name: "Hide Magic Edit" });
  if (await magicEditToggle.isVisible()) await magicEditToggle.click();
  const reloadResponse = await startRuntimeTraceScene(page, sceneLabel);
  expect(reloadResponse.ok()).toBe(true);
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 120_000 });
  const restoredGrid = page.getByRole("button", { name: "Move grid", exact: true });
  await expect(restoredGrid).toHaveAttribute("data-studio-entity", entityId);
  const restoredWrapper = page.locator(`[data-studio-entity-wrapper="${entityId}"]`);
  await expect(restoredWrapper).toHaveAttribute("data-studio-runtime-binding", /.+/u);
  await expect(restoredWrapper).toHaveAttribute("data-studio-runtime-entity", /.+/u);
  await expect(restoredWrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");
  const restoredBounds = await restoredGrid.boundingBox();
  if (!restoredBounds) throw new Error("The reloaded NumberPlane hit bounds are unavailable.");
  expect(restoredBounds.width).toBeCloseTo(freshBounds.width, 1);
  expect(restoredBounds.height).toBeCloseTo(freshBounds.height, 1);

  const decoded = await decodedLocalMp4(page);
  expect(decoded.width).toBe(854);
  expect(decoded.height).toBe(480);
  expect(decoded.duration).toBeGreaterThan(1.5);
  expect(decoded.brightPixels).toBeGreaterThan(1_000);
});

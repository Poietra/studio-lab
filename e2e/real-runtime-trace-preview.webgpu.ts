import { expect, type Page, test } from "@playwright/test";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";

const RUNTIME_TRACE_PATH = "/api/manim/projects/real-preview-harness/runtime-traces";

function runtimeTraceResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === RUNTIME_TRACE_PATH &&
      response.status() === 200,
  );
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
  await page.getByLabel("Active imported Scene").selectOption({ label: sceneLabel });

  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  const response = runtimeTraceResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
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

test("applies construction-time opacity through real Runtime Trace and retained WebGPU", async ({ page }) => {
  test.setTimeout(180_000);
  const response = await openRuntimeTraceScene(page, "scene_runtime_trace_v3.py · StaticSquare");
  expect(response.ok()).toBe(true);
  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 60_000 });
  const baseRevision = await canvas.getAttribute("data-preview-revision");
  if (!baseRevision) throw new Error("StaticSquare has no retained WebGPU revision.");
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

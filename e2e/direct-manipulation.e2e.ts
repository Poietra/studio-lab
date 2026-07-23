import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

async function position(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  return { x: box.x, y: box.y };
}

async function dragBy(page: Page, locator: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y);
  await page.mouse.up();
}

async function exportedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

function transactionBlock(source: string, transactionId: string) {
  const marker = `# poietra:transaction ${JSON.stringify(transactionId)}`;
  const end = source.indexOf(marker);
  if (end < 0) throw new Error(`Transaction ${transactionId} is missing from the exported source.`);
  const previousTransaction = source.lastIndexOf("# poietra:transaction ", end - 1);
  const precedingCursor = source.lastIndexOf("# poietra:cursor ", end);
  const start = Math.max(0, previousTransaction, precedingCursor);
  return source.slice(start, end + marker.length);
}

test("keeps the first object position while moving and applying a second object", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 40, y: 60 } });
  await page.getByRole("button", { name: "Apply program" }).click();
  await page.getByRole("button", { name: "Move playhead to source anchor 7.000 seconds" }).click();
  const equation = page.getByRole("button", { name: "Move equation" });
  const circle = page.getByRole("button", { name: "Move Circle" });
  await expect(equation).toBeVisible();
  await page.getByRole("button", { name: "Set position" }).click();
  await page.getByRole("checkbox", { name: "Select Circle" }).uncheck();
  await page.getByRole("checkbox", { name: "Select equation" }).check();

  const initialEquation = await position(equation);
  const initialCircle = await position(circle);
  await dragBy(page, equation, { x: 80, y: 30 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const movedEquation = await position(equation);
  expect(movedEquation.x - initialEquation.x).toBeCloseTo(80, 0);
  expect(movedEquation.y - initialEquation.y).toBeCloseTo(30, 0);

  await dragBy(page, circle, { x: 60, y: 20 });
  const appliedPrograms = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Applied programs" }),
  });
  await expect(appliedPrograms.getByRole("listitem")).toHaveCount(2);
  const equationAfterSecondMove = await position(equation);
  const movedCircle = await position(circle);
  expect(equationAfterSecondMove.x).toBeCloseTo(movedEquation.x, 1);
  expect(equationAfterSecondMove.y).toBeCloseTo(movedEquation.y, 1);
  expect(movedCircle.x - initialCircle.x).toBeCloseTo(60, 0);
  expect(movedCircle.y - initialCircle.y).toBeCloseTo(20, 0);

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(appliedPrograms.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const equationAfterApply = await position(equation);
  const circleAfterApply = await position(circle);
  expect(equationAfterApply.x).toBeCloseTo(movedEquation.x, 1);
  expect(equationAfterApply.y).toBeCloseTo(movedEquation.y, 1);
  expect(circleAfterApply.x).toBeCloseTo(movedCircle.x, 1);
  expect(circleAfterApply.y).toBeCloseTo(movedCircle.y, 1);
});

test("reopens an applied motion and replaces it in place with undoable export history", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "Create animation" }).click();
  await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("1");
  await dragBy(page, page.getByRole("button", { name: "Move equation" }), { x: 64, y: -20 });
  await page.getByRole("button", { name: "Apply program" }).click();

  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 460, y: 260 } });
  await page.getByRole("button", { name: "Apply program" }).click();

  const appliedPrograms = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Applied programs" }),
  });
  const rows = appliedPrograms.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("This canonical Program was created without editable authoring metadata.");
  await expect(appliedPrograms).toContainText("Imported .py operations are read-only");
  const beforeRows = await rows.allTextContents();
  const firstTransactionId = beforeRows[0]?.match(/studio-gesture-[0-9a-f-]{36}/)?.[0];
  const secondTransactionId = beforeRows[1]?.match(/studio-insert-[0-9a-f-]{36}/)?.[0];
  if (!firstTransactionId || !secondTransactionId) {
    throw new Error("Applied transaction identities were not rendered in source order.");
  }

  const originalSource = await exportedSource(page);
  expect(originalSource.indexOf(`# poietra:transaction "${firstTransactionId}"`)).toBeLessThan(
    originalSource.indexOf(`# poietra:transaction "${secondTransactionId}"`),
  );
  expect(transactionBlock(originalSource, firstTransactionId)).toContain("run_time=1");
  expect(transactionBlock(originalSource, secondTransactionId)).toContain("Circle(radius=1)");

  await page.getByRole("button", { name: "Edit applied program 1" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace program" })).toBeVisible();
  await expect(page.getByText("5.00s", { exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { exact: true, name: "Duration" }).fill("2");

  const previewSource = await exportedSource(page);
  expect(transactionBlock(previewSource, firstTransactionId)).toContain("run_time=2");
  expect(previewSource.indexOf(`# poietra:transaction "${firstTransactionId}"`)).toBeLessThan(
    previewSource.indexOf(`# poietra:transaction "${secondTransactionId}"`),
  );
  expect(transactionBlock(previewSource, secondTransactionId)).toContain("Circle(radius=1)");

  await page.getByRole("button", { name: "Replace program" }).click();
  await expect(rows).toHaveCount(2);
  expect(await rows.allTextContents()).toEqual(beforeRows);

  await page.keyboard.press("Control+z");
  await expect(rows).toHaveCount(2);
  expect(transactionBlock(await exportedSource(page), firstTransactionId)).toContain("run_time=1");

  await page.keyboard.press("Control+Shift+z");
  await expect(rows).toHaveCount(2);
  const redoneSource = await exportedSource(page);
  expect(transactionBlock(redoneSource, firstTransactionId)).toContain("run_time=2");
  expect(redoneSource.indexOf(`# poietra:transaction "${firstTransactionId}"`)).toBeLessThan(
    redoneSource.indexOf(`# poietra:transaction "${secondTransactionId}"`),
  );
});

test("moves and retimes an applied motion clip with pointer and keyboard controls", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "Create animation" }).click();
  await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("1");
  await dragBy(page, page.getByRole("button", { name: "Move equation" }), { x: 64, y: -20 });
  await page.getByRole("button", { name: "Apply program" }).click();

  const appliedPrograms = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Applied programs" }),
  });
  const transactionText = await appliedPrograms.getByRole("listitem").first().innerText();
  const transactionId = transactionText.match(/studio-gesture-[0-9a-f-]{36}/)?.[0];
  if (!transactionId) throw new Error("The applied motion transaction was not rendered.");

  const clip = page.getByRole("button", { name: "Edit equation motion clip" });
  await expect(clip).toBeVisible();
  const clipBox = await clip.boundingBox();
  const laneBox = await clip.locator("xpath=../..").boundingBox();
  const duration = Number(await page.getByRole("slider", { name: "Scene playhead" }).getAttribute("max"));
  if (!clipBox || !laneBox || !Number.isFinite(duration)) {
    throw new Error("The applied motion clip lane is not measurable.");
  }
  const origin = { x: clipBox.x + clipBox.width / 2, y: clipBox.y + clipBox.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + (laneBox.width * 2) / duration, origin.y, { steps: 4 });
  await page.mouse.up();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { exact: true, name: "Start" })).toHaveValue("7");
  await expect(page.getByRole("status")).toContainText("safe amber source anchors");
  await expect(page.locator("[data-motion-control]")).toBeVisible();
  await page.getByRole("combobox", { name: "Easing" }).selectOption("linear");
  await page.locator("[data-motion-control]").press("ArrowUp");

  const endHandle = page.getByRole("button", { name: "Adjust equation motion end" });
  await expect(endHandle).toBeVisible();
  await endHandle.press("ArrowRight");
  await expect(page.getByRole("spinbutton", { exact: true, name: "Duration" })).toHaveValue("1.1");

  const preview = transactionBlock(await exportedSource(page), transactionId);
  expect(preview).toContain("# poietra:cursor 7");
  expect(preview).toContain('"easing":"linear"');
  expect(preview).toContain("run_time=1.1");
  expect(preview).toContain("rate_func=linear");

  await page.getByRole("button", { name: "Replace program" }).click();
  await page.keyboard.press("Control+z");
  const undone = transactionBlock(await exportedSource(page), transactionId);
  expect(undone).toContain("# poietra:cursor 5");
  expect(undone).toContain("run_time=1");
  expect(undone).toContain("rate_func=smooth");

  await page.keyboard.press("Control+Shift+z");
  const redone = transactionBlock(await exportedSource(page), transactionId);
  expect(redone).toContain("# poietra:cursor 7");
  expect(redone).toContain('"easing":"linear"');
  expect(redone).toContain("run_time=1.1");
});

test("rejects a motion retime that would cross another applied source anchor", async ({ page }) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-motion-order-"));
  const source = `from manim import *

class MotionOrderScene(Scene):
    def construct(self):
        dot = Dot()
        self.add(dot)
        # poietra:anchor 1.000
        self.wait(2)
        # poietra:anchor 3.000
        self.wait(2)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;
  await writeFile(join(projectRoot, "motion_order.py"), source, "utf8");
  const createdResponse = await page.request.post("/api/manim/projects", {
    data: { kind: "existing", name: "Motion Order Fixture", root: projectRoot },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()) as { project: { id: string } };
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Open Motion Order Fixture workspace" }).click();
    await expect(page.locator("[data-studio-canvas]")).toBeVisible();

    const dot = page.getByRole("button", { name: "Move dot" });
    await page.getByRole("button", { name: "Move playhead to source anchor 3.000 seconds" }).click();
    await page.getByRole("button", { name: "Create animation" }).click();
    await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("0.5");
    await dragBy(page, dot, { x: 30, y: 0 });
    await page.getByRole("button", { name: "Apply program" }).click();

    const appliedPrograms = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Applied programs" }),
    });
    await expect(appliedPrograms.getByRole("listitem")).toHaveCount(1);

    await page.getByRole("button", { name: "Move playhead to source anchor 1.000 seconds" }).click();
    await dragBy(page, dot, { x: 0, y: 30 });
    await expect(page.getByRole("alert")).toContainText("earlier than the latest applied Program");
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await expect(appliedPrograms.getByRole("listitem")).toHaveCount(1);

    await page.getByRole("button", { name: "Edit applied program 1" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("spinbutton", { exact: true, name: "Duration" }).fill("0.6");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

    await page.getByRole("button", { name: "Move playhead to source anchor 5.000 seconds" }).click();
    await dragBy(page, dot, { x: 0, y: 30 });
    await page.getByRole("button", { name: "Apply program" }).click();

    await expect(appliedPrograms.getByRole("listitem")).toHaveCount(2);
    const rows = await appliedPrograms.getByRole("listitem").allTextContents();
    const transactionIds = rows.map((row) => row.match(/studio-gesture-[0-9a-f-]{36}/)?.[0]);
    if (!transactionIds[0] || !transactionIds[1]) {
      throw new Error("The motion-order transactions were not rendered.");
    }

    const firstClip = page.getByRole("button", { name: "Edit dot motion clip" }).first();
    await firstClip.press("ArrowRight");
    await expect(page.getByRole("spinbutton", { exact: true, name: "Start" })).toHaveValue("5");
    await firstClip.press("ArrowRight");

    await expect(page.getByRole("alert")).toContainText("would cross the next applied Program");
    await expect(page.getByRole("spinbutton", { exact: true, name: "Start" })).toHaveValue("5");
    const exported = await exportedSource(page);
    expect(transactionBlock(exported, transactionIds[0])).toContain("# poietra:cursor 5");
    expect(exported.indexOf(`# poietra:transaction ${JSON.stringify(transactionIds[0])}`)).toBeLessThan(
      exported.indexOf(`# poietra:transaction ${JSON.stringify(transactionIds[1])}`),
    );
  } finally {
    await page.request.delete(`/api/manim/projects/${created.project.id}`).catch(() => undefined);
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("snaps direct manipulation to the latest safe source anchor before creating a draft", async ({ page }) => {
  await openWorkspace(page);
  const equation = page.getByRole("button", { name: "Move equation" });
  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(equation).toBeVisible();
  await scenePlayhead.fill("5.6");
  await page.getByRole("button", { name: "Set position" }).click();

  await dragBy(page, equation, { x: 40, y: 20 });
  await expect(scenePlayhead).toHaveValue("5");
  await expect(page.getByRole("alert")).toContainText("Moved the playhead to the latest safe .py source anchor");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const anchored = await position(equation);

  await dragBy(page, equation, { x: 40, y: 20 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const afterSafeDrag = await position(equation);
  expect(afterSafeDrag.x - anchored.x).toBeCloseTo(40, 0);
  expect(afterSafeDrag.y - anchored.y).toBeCloseTo(20, 0);
});

test("previews, exports, applies, and undoes a Circle geometry resize", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  const canvas = page.locator("[data-studio-canvas]");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("The Studio canvas is not visible.");
  await canvas.click({ position: { x: 40, y: 60 } });
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await scenePlayhead.fill("5.6");
  await page.getByRole("button", { name: "Set position" }).click();

  const circle = page.getByRole("button", { name: "Move Circle" });
  const wrapper = page.locator("[data-studio-entity-wrapper]").filter({ has: circle });
  const handle = page.getByRole("button", { name: "Resize Circle from bottom-right corner" });
  await expect(handle).toBeVisible();
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");
  await expect(wrapper).toHaveAttribute("data-studio-entity-radius", "1.0000");

  const unsafeHandleBox = await handle.boundingBox();
  if (!unsafeHandleBox) throw new Error("The Circle resize handle is not visible.");
  await page.mouse.click(unsafeHandleBox.x + unsafeHandleBox.width / 2, unsafeHandleBox.y + unsafeHandleBox.height / 2);
  await expect(scenePlayhead).toHaveValue("5.4");
  await expect(page.getByRole("alert")).toContainText("Moved the playhead to the latest safe .py source anchor");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const initialBox = await circle.boundingBox();
  const handleBox = await handle.boundingBox();
  if (!initialBox || !handleBox) throw new Error("The Circle resize controls are not visible.");

  const origin = {
    x: handleBox.x + handleBox.width / 2,
    y: handleBox.y + handleBox.height / 2,
  };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 45, origin.y + 35, { steps: 4 });
  await expect.poll(async () => Number(await wrapper.getAttribute("data-studio-entity-radius")))
    .toBeGreaterThan(1.25);
  const previewBox = await circle.boundingBox();
  expect(previewBox?.width ?? 0).toBeGreaterThan(initialBox.width);
  const previewHandleBox = await handle.boundingBox();
  expect(previewHandleBox?.width ?? 0).toBeCloseTo(handleBox.width, 1);
  expect(previewHandleBox?.height ?? 0).toBeCloseTo(handleBox.height, 1);
  await page.mouse.up();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const committedRadius = Number(await wrapper.getAttribute("data-studio-entity-radius"));
  expect(committedRadius).toBeGreaterThan(1.25);
  const source = await exportedSource(page);
  expect(source).toContain("# poietra:dimensions");
  expect(source).toMatch(/\.scale_to_fit_width\([0-9.]+\)/);
  expect(source).not.toContain(".animate.scale_to_fit_width(");
  expect(source).not.toMatch(/run_time=0(?:\.0+)?[,)]/);
  await page.getByRole("button", { name: "Apply program" }).click();
  await page.keyboard.press("Control+z");
  await expect(wrapper).toHaveAttribute("data-studio-entity-radius", "1.0000");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => Number(await wrapper.getAttribute("data-studio-entity-radius")))
    .toBeCloseTo(committedRadius, 2);
});

test("resizes Rectangle width independently with edge and keyboard controls", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert rectangle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 150, y: 100 } });
  await page.getByRole("button", { name: "Apply program" }).click();
  await page.getByRole("button", { name: "Move playhead to source anchor 7.000 seconds" }).click();
  await page.getByRole("button", { name: "Set position" }).click();

  const rectangle = page.getByRole("button", { name: "Move Rectangle" });
  const wrapper = page.locator("[data-studio-entity-wrapper]").filter({ has: rectangle });
  const eastHandle = page.getByRole("button", { name: "Resize Rectangle from right edge" });
  await expect(page.getByRole("spinbutton", { name: "Width of Rectangle" })).toHaveValue("4.00");
  await expect(page.getByRole("spinbutton", { name: "Height of Rectangle" })).toHaveValue("2.00");
  await expect(eastHandle).toBeVisible();
  await expect(wrapper).toHaveAttribute("data-studio-entity-width", "4.0000");
  await expect(wrapper).toHaveAttribute("data-studio-entity-height", "2.0000");
  const initial = await rectangle.boundingBox();
  const handleBox = await eastHandle.boundingBox();
  if (!initial || !handleBox) throw new Error("The Rectangle resize controls are not visible.");
  const origin = {
    x: handleBox.x + handleBox.width / 2,
    y: handleBox.y + handleBox.height / 2,
  };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 45, origin.y, { steps: 4 });
  await expect.poll(async () => Number(await wrapper.getAttribute("data-studio-entity-width")))
    .toBeGreaterThan(4.7);
  await expect(wrapper).toHaveAttribute("data-studio-entity-height", "2.0000");
  const preview = await rectangle.boundingBox();
  expect(preview?.width ?? 0).toBeGreaterThan(initial.width + 30);
  expect(preview?.height ?? 0).toBeCloseTo(initial.height, 1);
  const previewHandle = await eastHandle.boundingBox();
  expect((previewHandle?.x ?? 0) + (previewHandle?.width ?? 0) / 2).toBeCloseTo(origin.x + 45, 0);
  await page.mouse.up();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const source = await exportedSource(page);
  expect(source).toContain("# poietra:dimensions");
  expect(source).toContain(".stretch_to_fit_width(");
  expect(source).toContain(".stretch_to_fit_height(2)");
  await page.getByRole("button", { name: "Apply program" }).click();

  const widthBeforeKey = Number(await wrapper.getAttribute("data-studio-entity-width"));
  await eastHandle.focus();
  await eastHandle.press("ArrowUp");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(wrapper).toHaveAttribute("data-studio-entity-width", widthBeforeKey.toFixed(4));
  await eastHandle.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect.poll(async () => Number(await wrapper.getAttribute("data-studio-entity-width")))
    .toBeGreaterThan(widthBeforeKey);
  await expect(wrapper).toHaveAttribute("data-studio-entity-height", "2.0000");
});

test("labels runtime-dependent geometry and blocks unsafe direct manipulation", async ({ page }) => {
  const positionReason = "Position depends on a runtime move_to expression.";
  const scaleReason = "Scale depends on a runtime function call.";
  await page.route("**/api/manim/projects/studio-lab/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as {
      sources: Array<{
        scenes: Array<{
          name: string;
          runtimeSceneState: {
            objectGraph: { entities: Record<string, { geometry: { position: unknown; scale: unknown } }> };
            propertyChannels: Record<string, { samples: Array<{ knowledge?: unknown }> }>;
          };
        }>;
      }>;
    };
    const scene = workspace.sources
      .flatMap((source) => source.scenes)
      .find((candidate) => candidate.name === "GroupedEquation");
    if (!scene) throw new Error("The GroupedEquation fixture Scene is missing.");
    const entityId = Object.keys(scene.runtimeSceneState.objectGraph.entities).find((candidate) =>
      candidate.endsWith(":equation"),
    );
    if (!entityId) throw new Error("The equation fixture entity is missing.");
    const entity = scene.runtimeSceneState.objectGraph.entities[entityId];
    entity.geometry.position = { kind: "unknown", reason: positionReason };
    entity.geometry.scale = { kind: "unknown", reason: scaleReason };
    for (const sample of scene.runtimeSceneState.propertyChannels[`${entityId}/position`].samples) {
      sample.knowledge = { kind: "unknown", reason: positionReason };
    }
    for (const sample of scene.runtimeSceneState.propertyChannels[`${entityId}/scale`].samples) {
      sample.knowledge = { kind: "unknown", reason: scaleReason };
    }
    await route.fulfill({ json: workspace, response });
  });

  await openWorkspace(page);
  await page.getByRole("checkbox", { name: "Select equation" }).check();
  const equation = page.getByRole("button", { name: "Move equation" });
  await expect(equation).toBeDisabled();
  await expect(page.locator("[data-studio-geometry='approximate']").filter({ has: equation })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Scale equation" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Resize equation" })).toHaveCount(0);
  const notice = page.getByRole("region", { name: "Approximate source geometry" });
  await expect(notice).toContainText(positionReason);
  await expect(notice).toContainText(scaleReason);
});

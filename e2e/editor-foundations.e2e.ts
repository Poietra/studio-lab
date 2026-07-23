import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

async function dragBy(page: Page, locator: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 4 });
  await expect(page.locator("[data-motion-preview]")).toHaveCount(1);
  await page.mouse.up();
}

async function exportedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.py$/);
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

test("exports the selected Python source unchanged before any Studio edit", async ({ page }) => {
  await openWorkspace(page);

  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled();
  await expect(exportedSource(page)).resolves.toBe(
    await readFile(join(process.cwd(), "examples", "relativity.py"), "utf8"),
  );
});

test("inserts geometry without Magic Edit and exports exact Manim source", async ({ page }) => {
  await openWorkspace(page);

  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
  await expect(exportedSource(page)).resolves.toContain("Circle(radius=1)");

  await page.getByRole("button", { name: "Apply program" }).click();
  await page.keyboard.press("Control+d");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Move Circle" })).toHaveCount(2);
  const composedSource = await exportedSource(page);
  expect(composedSource.match(/Circle\(radius=1\)/g)).toHaveLength(2);

  await page.getByRole("button", { name: "Apply program" }).click();
  await dragBy(page, page.getByRole("button", { name: "Move Circle" }).nth(1), { x: 30, y: 0 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByText(/not present at the operation start/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Apply program" }).click();
  const duration = page.getByRole("spinbutton", { name: "Scene duration in seconds" });
  await expect(duration).toHaveValue("14.30");
  await duration.fill("15");
  await page.getByRole("button", { name: "Extend" }).click();
  const extendedComposition = await exportedSource(page);
  expect(extendedComposition.match(/Circle\(radius=1\)/g)).toHaveLength(2);
  expect(extendedComposition).toContain("self.wait(0.7)");
});

test("retains editor sessions while leaving and reopening workspaces", async ({ page }) => {
  await openWorkspace(page);

  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();

  const scene = page.getByRole("combobox", { name: "Active imported Scene" });
  await scene.selectOption({ label: "examples/relativity.py · FieldSummary" });
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(0);
  await scene.selectOption({ label: "examples/relativity.py · GroupedEquation" });
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(1);

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.locator("[data-studio-canvas]")).toHaveCount(0);

  const workspaceResponse = page.waitForResponse(/\/api\/manim\/projects\/examples\/workspace$/);
  await page.getByRole("button", { name: "Open Examples workspace" }).click();
  await workspaceResponse;
  await expect(page.getByLabel("Current workspace")).toHaveText("Examples");
  await expect(page.getByRole("combobox", { name: "Active imported Scene" })).toContainText("relativity.py");

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  const returnResponse = page.waitForResponse(/\/api\/manim\/projects\/studio-lab\/workspace$/);
  await page.getByRole("button", { name: "Open Studio Lab workspace" }).click();
  await returnResponse;
  await expect(page.getByLabel("Current workspace")).toHaveText("Studio Lab");
  await expect(scene).toHaveValue(/GroupedEquation/);
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(1);
});

test("waits at the launcher and only imports explicitly selected workspaces", async ({ page }) => {
  let projectCatalogRequests = 0;
  let thumbnailRequests = 0;
  let workspaceRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/manim/projects") projectCatalogRequests += 1;
    if (/^\/api\/manim\/projects\/[^/]+\/thumbnail$/.test(pathname)) thumbnailRequests += 1;
    if (/^\/api\/manim\/projects\/[^/]+\/workspace$/.test(pathname)) workspaceRequests += 1;
  });
  await page.route("**/api/manim/projects/examples/thumbnail", async (route) => {
    await route.abort("failed");
  });

  const catalogResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/manim/projects"
  ));
  const thumbnailResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/manim/projects/studio-lab/thumbnail"
  ));
  await page.goto("/");
  await catalogResponse;
  const thumbnailResponse = await thumbnailResponsePromise;

  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open .* workspace/ })).toHaveCount(2);
  const studioCard = page.locator("[data-workspace-card='studio-lab']");
  const openStudio = page.getByRole("button", { name: "Open Studio Lab workspace" });
  const studioThumbnail = openStudio.locator("[data-workspace-thumbnail]");
  const actualStudioThumbnail = openStudio.locator("[data-workspace-actual-thumbnail='studio-lab']");
  const renameStudio = page.getByRole("button", { name: "Rename Studio Lab workspace" });
  const removeStudio = page.getByRole("button", { name: "Remove Studio Lab workspace" });
  await expect(studioThumbnail).toBeVisible();
  await expect(studioThumbnail).toHaveAttribute("aria-hidden", "true");
  await expect(actualStudioThumbnail).toHaveAttribute("alt", "");
  await expect(actualStudioThumbnail).toHaveAttribute("loading", "lazy");
  await expect(actualStudioThumbnail).toHaveAttribute("data-state", "loaded");
  await expect.poll(() => actualStudioThumbnail.evaluate((image) => (
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  ))).toBe(true);
  expect(thumbnailResponse.status()).toBe(200);
  expect(thumbnailResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(await thumbnailResponse.text()).toContain("E = m c^2");
  const openExamples = page.getByRole("button", { name: "Open Examples workspace" });
  await expect(openExamples.locator("[data-workspace-actual-thumbnail='examples']"))
    .toHaveAttribute("data-state", "error");
  await expect(openExamples.locator("[data-workspace-thumbnail-fallback]")).toBeVisible();
  const idleCardBackground = await studioCard.evaluate((node) => getComputedStyle(node).backgroundColor);
  await openStudio.hover();
  await expect.poll(() => studioCard.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(idleCardBackground);
  const hoveredCardBackground = await studioCard.evaluate((node) => getComputedStyle(node).backgroundColor);
  const idleRenameBackground = await renameStudio.evaluate((node) => getComputedStyle(node).backgroundColor);
  await renameStudio.hover();
  await expect.poll(() => renameStudio.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(idleRenameBackground);
  await expect.poll(() => studioCard.evaluate((node) => getComputedStyle(node).backgroundColor))
    .toBe(hoveredCardBackground);
  const idleRemoveBackground = await removeStudio.evaluate((node) => getComputedStyle(node).backgroundColor);
  await removeStudio.hover();
  await expect.poll(() => removeStudio.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(idleRemoveBackground);
  const addWorkspace = page.getByRole("button", { name: "Add workspace" });
  await expect(addWorkspace.locator("svg[aria-hidden='true']")).toBeVisible();
  await expect(page.locator("[data-studio-canvas]")).toHaveCount(0);
  expect(thumbnailRequests).toBeGreaterThanOrEqual(2);
  expect(workspaceRequests).toBe(0);
  expect(projectCatalogRequests).toBe(1);

  await renameStudio.click();
  await expect(page.getByRole("dialog", { name: "Rename workspace" })).toBeVisible();
  await page.getByRole("dialog", { name: "Rename workspace" }).getByRole("button", { name: "Cancel" }).click();
  await removeStudio.click();
  await expect(page.getByRole("alertdialog", { name: /Remove Studio Lab from Studio/ })).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  expect(workspaceRequests).toBe(0);

  const workspaceResponse = page.waitForResponse(/\/api\/manim\/projects\/studio-lab\/workspace$/);
  await studioThumbnail.click();
  await workspaceResponse;

  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  expect(workspaceRequests).toBe(1);
  expect(projectCatalogRequests).toBe(1);

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  const examplesResponse = page.waitForResponse(/\/api\/manim\/projects\/examples\/workspace$/);
  await page.getByRole("button", { name: "Open Examples workspace" }).focus();
  await page.keyboard.press("Enter");
  await examplesResponse;

  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  expect(workspaceRequests).toBe(2);
  expect(projectCatalogRequests).toBe(1);
});

test("allows a pending workspace mutation dialog to be cancelled", async ({ page }) => {
  let releaseRequest: (() => void) | null = null;
  let resolveRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequestStarted = resolve;
  });
  await page.route("**/api/manim/projects/studio-lab", async (route) => {
    resolveRequestStarted();
    await new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await route.abort("timedout").catch(() => undefined);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Rename Studio Lab workspace" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename workspace" });
  await renameDialog.getByRole("textbox", { name: "Workspace name" }).fill("Pending rename");
  await renameDialog.getByRole("button", { name: "Save name" }).click();
  await requestStarted;
  await expect(renameDialog.locator("form")).toHaveAttribute("aria-busy", "true");

  await page.keyboard.press("Escape");
  await expect(renameDialog).toHaveCount(0);
  releaseRequest?.();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByRole("button", { name: "Open Studio Lab workspace" })).toBeVisible();
});

test("creates, persists, renames, and deletes a browser-managed workspace", async ({ page }) => {
  let projectId: string | null = null;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Add workspace" }).click();
    const addDialog = page.getByRole("dialog", { name: "Add workspace" });
    await expect(addDialog.getByRole("textbox", { name: "Existing folder path" })).toHaveCount(0);
    await addDialog.getByRole("button", { name: "Create workspace" }).click();
    await expect(addDialog.getByRole("alert")).toContainText("Enter a workspace name");
    await addDialog.getByRole("textbox", { name: "Workspace name" }).fill("CRUD Fixture");
    const createResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/manim/projects"
    ));
    await addDialog.getByRole("button", { name: "Create workspace" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.request().postDataJSON()).toEqual({ kind: "managed", name: "CRUD Fixture" });
    const created = await createResponse.json() as { project: { id: string } };
    projectId = created.project.id;
    await expect(page.getByLabel("Current workspace")).toHaveText("CRUD Fixture");
    await expect(page.locator("[data-studio-canvas]")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Active imported Scene" })).toContainText("main.py · MainScene");

    await page.getByRole("button", { name: "Back to workspaces" }).click();
    await page.getByRole("button", { name: "Rename CRUD Fixture workspace" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename workspace" });
    await renameDialog.getByRole("textbox", { name: "Workspace name" }).fill("Renamed Fixture");
    const renameResponse = page.waitForResponse((response) => (
      response.request().method() === "PATCH"
      && new URL(response.url()).pathname === `/api/manim/projects/${projectId}`
    ));
    await renameDialog.getByRole("button", { name: "Save name" }).click();
    await renameResponse;
    await expect(page.getByRole("button", { name: "Open Renamed Fixture workspace" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Open Renamed Fixture workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Delete Renamed Fixture workspace" }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: "Delete Renamed Fixture?" });
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Open Renamed Fixture workspace" })).toBeVisible();

    await page.getByRole("button", { name: "Delete Renamed Fixture workspace" }).click();
    const deleteResponse = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/manim/projects/${projectId}`
    ));
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete workspace" }).click();
    await deleteResponse;
    await expect(page.getByRole("button", { name: "Open Renamed Fixture workspace" })).toHaveCount(0);
  } finally {
    if (projectId) await page.request.delete(`/api/manim/projects/${projectId}`).catch(() => undefined);
  }
});

test("reconciles local workspace state when DELETE commits but its response is lost", async ({ page }) => {
  await page.addInitScript(() => {
    const browserUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => `${browserUserAgent} Electron`,
    });
  });
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-workspace-delete-race-"));
  const sourcePath = join(projectRoot, "scene.py");
  const source = `from manim import *

class DeleteRaceScene(Scene):
    def construct(self):
        title = Text("Delete race")
        self.add(title)
        # poietra:anchor 0.000
        self.wait(1)
`;
  await writeFile(sourcePath, source, "utf8");
  const createdResponse = await page.request.post("/api/manim/projects", {
    data: { kind: "existing", name: "Delete Race Fixture", root: projectRoot },
  });
  const created = await createdResponse.json() as { project: { id: string } };
  const projectId = created.project.id;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Open Delete Race Fixture workspace" }).click();
    await page.getByRole("button", { name: /Insert circle/ }).click();
    await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Back to workspaces" }).click();

    await page.route(`**/api/manim/projects/${projectId}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("connectionfailed");
    });
    await page.getByRole("button", { name: "Remove Delete Race Fixture workspace" }).click();
    const removeDialog = page.getByRole("alertdialog", { name: /Remove Delete Race Fixture from Studio/ });
    await removeDialog.getByRole("button", { name: "Remove workspace" }).click();
    await expect(removeDialog.getByRole("alert")).toBeVisible();
    await removeDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Open Delete Race Fixture workspace" })).toHaveCount(0);
    await expect(readFile(sourcePath, "utf8")).resolves.toBe(source);

    await page.getByRole("button", { name: "Add workspace" }).click();
    const addDialog = page.getByRole("dialog", { name: "Add workspace" });
    await addDialog.getByRole("textbox", { name: "Workspace name" }).fill("Delete Race Fixture");
    await addDialog.getByRole("textbox", { name: "Existing folder path" }).fill(projectRoot);
    const recreatedResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/manim/projects"
    ));
    await addDialog.getByRole("button", { name: "Add workspace" }).click();
    const recreated = await (await recreatedResponsePromise).json() as { project: { id: string } };
    expect(recreated.project.id).toBe(projectId);
    await expect(page.locator("[data-studio-canvas]")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to workspaces" }).click();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.request.delete(`/api/manim/projects/${projectId}`).catch(() => undefined);
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("undo and redo restore an uncommitted draft", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();

  await page.keyboard.press("Control+z");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
});

test("scrubs time from the ruler without blocking object intervals", async ({ page }) => {
  await openWorkspace(page);
  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  const timelinePlayhead = page.getByRole("slider", { name: "Timeline playhead" });
  await expect(timelinePlayhead).toBeVisible();

  const duration = Number(await timelinePlayhead.getAttribute("max"));
  await scenePlayhead.fill(String(duration / 4));
  const box = await timelinePlayhead.boundingBox();
  if (!box) throw new Error("The timeline playhead is not visible.");

  const pointerY = box.y + box.height - 8;
  await page.mouse.move(box.x + box.width * 0.25, pointerY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, pointerY, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => Number(await timelinePlayhead.inputValue()))
    .toBeGreaterThan(duration * 0.7);
  const scrubbedTime = Number(await timelinePlayhead.inputValue());
  expect(scrubbedTime).toBeLessThan(duration * 0.8);
  await expect.poll(async () => Number(await scenePlayhead.inputValue()))
    .toBeCloseTo(scrubbedTime, 2);
  await expect.poll(async () => timelinePlayhead.getAttribute("aria-valuetext"))
    .toBe(`${scrubbedTime.toFixed(2)} seconds of ${duration.toFixed(2)} seconds`);
  const playheadPosition = await page.locator("[data-timeline-playhead]").first().evaluate((node) => (
    Number.parseFloat((node as HTMLElement).style.left)
  ));
  expect(playheadPosition).toBeCloseTo((scrubbedTime / duration) * 100, 2);

  await timelinePlayhead.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await timelinePlayhead.inputValue()))
    .toBeLessThan(scrubbedTime);

  const lifetime = page.locator("[data-timeline-lifetime]").first();
  await expect(lifetime).toHaveAttribute("title", /^Present /);
  const lifetimeBox = await lifetime.boundingBox();
  if (!lifetimeBox) throw new Error("The object lifetime is not visible.");
  const hitLifetime = await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.hasAttribute("data-timeline-lifetime") === true
  ), {
    x: lifetimeBox.x + lifetimeBox.width / 2,
    y: lifetimeBox.y + lifetimeBox.height / 2,
  });
  expect(hitLifetime).toBe(true);
});

test("trims an object lifetime at a safe source anchor and exports an instant removal", async ({ page }) => {
  await openWorkspace(page);
  const lifetime = page.getByRole("button", { name: /Select equation lifetime/ });
  await lifetime.click();
  await expect(page.getByRole("combobox", { name: "Lifetime end for equation" })).toHaveValue("7");

  const handle = page.getByRole("button", { name: "Trim equation lifetime end" });
  const handleBox = await handle.boundingBox();
  const laneBox = await lifetime.locator("xpath=ancestor::*[@data-timeline-track][1]")
    .locator("[data-timeline-lane]").boundingBox();
  if (!handleBox || !laneBox) throw new Error("The equation lifetime trim handle is not visible.");
  const handleCenter = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
  await page.mouse.move(handleCenter.x, handleCenter.y);
  await page.mouse.down();
  await page.mouse.move(laneBox.x + laneBox.width * (7 / 12), handleCenter.y, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(lifetime).toHaveAttribute("title", "Present 0.00–7.00s");
  await expect(page.getByRole("spinbutton", { name: "Scene duration in seconds" })).toHaveValue("12.00");
  const source = await exportedSource(page);
  expect(source).toContain("self.remove(equation)");
  expect(source).not.toContain("run_time=0");

  await page.getByRole("button", { name: "Apply program" }).click();
  await page.keyboard.press("Control+z");
  await expect(lifetime).toHaveAttribute("title", "Present 0.00–12.00s");
});

test("previews a motion path, bends it, and exports a Bézier move", async ({ page }) => {
  await openWorkspace(page);
  const equation = page.getByRole("button", { name: "Move equation" });
  await expect(equation).toBeVisible();
  await page.getByRole("button", { name: "Create animation" }).click();
  await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("6");

  await dragBy(page, equation, { x: 80, y: -30 });
  await expect(page.locator("[data-motion-path]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Adjust motion path/ })).toBeVisible();

  await page.getByRole("spinbutton", { name: "Curve Y" }).fill("-30");
  await expect(page.locator("[data-motion-path]")).toHaveAttribute("d", /Q [^ ]+ [^ ]+ /);
  await expect(exportedSource(page)).resolves.toEqual(expect.stringMatching(/MoveAlongPath\([\s\S]*run_time=6/));
});

test("exports one continuous batch across distinct source anchors", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();

  await page.getByRole("button", { name: "Move playhead to source anchor 7.000 seconds" }).click();
  await dragBy(page, page.getByRole("button", { name: "Move Circle" }), { x: 45, y: -15 });

  const source = await exportedSource(page);
  expect(source).toContain("Circle(radius=1)");
  expect(source).toMatch(/poietra_studio_insert_[A-Za-z0-9_]+\.animate\.shift\(/);
  expect(source).toContain("# poietra:anchor 5.4");
  expect(source).toContain("# poietra:cursor 7.4");
  expect(source).toContain("# poietra:anchor 8.9");
});

test("extends the Scene duration through an exportable wait", async ({ page }) => {
  await openWorkspace(page);
  const duration = page.getByRole("spinbutton", { name: "Scene duration in seconds" });
  await expect(duration).toHaveValue("12.00");
  await duration.fill("15");
  await page.getByRole("button", { name: "Extend" }).click();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Scene duration in seconds" })).toHaveValue("15.00");
  await expect(exportedSource(page)).resolves.toContain("self.wait(3)");
});

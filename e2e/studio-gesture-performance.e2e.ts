import { expect, type Locator, type Page, test } from "@playwright/test";

import type { StudioRenderBoundary, StudioRenderProfileEvent } from "../src/studio/studio-render-profiler";
import { cleanupFixtureWorkspace } from "./workspace";

const POINTER_MOVE_STEPS = 24;

type BrowserRenderProbe = {
  events: StudioRenderProfileEvent[];
};

type RenderProbeWindow = typeof globalThis & {
  __POIETRA_STUDIO_RENDER_PROBE__?: (event: StudioRenderProfileEvent) => void;
  __POIETRA_STUDIO_RENDER_PROBE_STATE__?: BrowserRenderProbe;
};

type RenderBoundarySummary = Readonly<{
  commits: number;
  renders: number;
}>;

type RenderProfile = Readonly<{
  boundaries: Readonly<Record<StudioRenderBoundary, RenderBoundarySummary>>;
}>;

type GestureProfile = RenderProfile &
  Readonly<{
    pointerMoveSteps: number;
  }>;

test.skip(
  process.env.POIETRA_STUDIO_GESTURE_BENCHMARK !== "1",
  "Set POIETRA_STUDIO_GESTURE_BENCHMARK=1 to run the explicit Studio gesture benchmark.",
);

async function installRenderProbe(page: Page) {
  await page.addInitScript(() => {
    const browserWindow = globalThis as RenderProbeWindow;
    const state: BrowserRenderProbe = { events: [] };
    browserWindow.__POIETRA_STUDIO_RENDER_PROBE_STATE__ = state;
    browserWindow.__POIETRA_STUDIO_RENDER_PROBE__ = (event) => state.events.push(event);
  });
}

async function settleRender(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function startRenderProfile(page: Page) {
  await page.evaluate(() => {
    const state = (globalThis as RenderProbeWindow).__POIETRA_STUDIO_RENDER_PROBE_STATE__;
    if (!state) throw new Error("The Studio render probe was not installed.");
    state.events = [];
  });
}

async function stopRenderProfile(page: Page) {
  return page.evaluate(() => {
    const state = (globalThis as RenderProbeWindow).__POIETRA_STUDIO_RENDER_PROBE_STATE__;
    if (!state) throw new Error("The Studio render probe was not installed.");
    return state.events;
  });
}

function summarizeProfile(events: readonly StudioRenderProfileEvent[]): RenderProfile {
  const boundaries = Object.fromEntries(
    (["app", "canvas", "timeline", "toolbar"] as const).map((boundary) => [
      boundary,
      {
        commits: events.filter((event) => event.boundary === boundary && event.kind === "commit").length,
        renders: events.filter((event) => event.boundary === boundary && event.kind === "render").length,
      },
    ]),
  ) as RenderProfile["boundaries"];
  return { boundaries };
}

async function profilePointerDrag(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The drag target is not visible.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await settleRender(page);
  await startRenderProfile(page);
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: POINTER_MOVE_STEPS });
  await settleRender(page);
  const profile: GestureProfile = {
    ...summarizeProfile(await stopRenderProfile(page)),
    pointerMoveSteps: POINTER_MOVE_STEPS,
  };
  await page.mouse.up();

  console.info(`STUDIO_GESTURE_BOUNDARIES ${JSON.stringify(profile.boundaries)}`);
  expect(profile.boundaries.canvas.renders).toBeGreaterThan(0);
  for (const boundary of ["app", "timeline", "toolbar"] as const) {
    expect(
      profile.boundaries[boundary].renders,
      `${boundary} renders must stay constant rather than scale with pointer moves`,
    ).toBeLessThanOrEqual(2);
  }
  for (const boundary of ["timeline", "toolbar"] as const) {
    expect(
      profile.boundaries[boundary].commits,
      `${boundary} commits must stay constant rather than scale with pointer moves`,
    ).toBeLessThanOrEqual(1);
  }
  return profile;
}

async function profilePlayback(page: Page) {
  const canvas = page.locator("[data-studio-canvas]");
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("0");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await expect
    .poll(async () => {
      const sampleTime = await canvas.getAttribute("data-preview-sample-time");
      return sampleTime === null ? Number.NaN : Number(sampleTime);
    })
    .toBeCloseTo(0, 2);
  const initialPacketId = await canvas.getAttribute("data-preview-packet-id");
  await page.getByRole("button", { exact: true, name: "Play" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
  await settleRender(page);
  await startRenderProfile(page);
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThan(0.5);
  const profile = summarizeProfile(await stopRenderProfile(page));
  for (const boundary of ["app", "canvas", "timeline", "toolbar"] as const) {
    expect(
      profile.boundaries[boundary].renders,
      `${boundary} renders must stay constant rather than scale with playback frames`,
    ).toBeLessThanOrEqual(6);
  }
  for (const boundary of ["canvas", "toolbar"] as const) {
    expect(
      profile.boundaries[boundary].commits,
      `${boundary} commits must stay constant rather than scale with playback frames`,
    ).toBeLessThanOrEqual(3);
  }
  await page.getByRole("button", { exact: true, name: "Pause" }).click();
  const pausedTime = Number(await playhead.inputValue());
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-preview-sample-time")), { timeout: 30_000 })
    .toBeCloseTo(pausedTime, 1);
  await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(initialPacketId);
  await expect(canvas.locator("[data-studio-preview-canvas]")).not.toHaveClass(/invisible/u);

  await page.getByRole("button", { exact: true, name: "Play" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
  await playhead.fill("1.25");
  await expect(page.getByRole("button", { exact: true, name: "Play" })).toBeVisible();
  await expect(playhead).toHaveValue("1.25");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-preview-sample-time")), { timeout: 30_000 })
    .toBeCloseTo(1.25, 1);
  return profile;
}

async function retainedRevision(page: Page) {
  const revision = await page.locator("[data-studio-canvas]").getAttribute("data-preview-revision");
  if (!revision) throw new Error("The presented WebGPU frame has no revision.");
  return revision;
}

async function waitForNewPresentedRevision(page: Page, previousRevision: string) {
  const canvas = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const [phase, revision] = await Promise.all([
          canvas.getAttribute("data-preview-renderer"),
          canvas.getAttribute("data-preview-revision"),
        ]);
        return phase === "presented" && revision && revision !== previousRevision;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
}

async function createBlankWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Gesture performance fixture");
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects",
  );
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  const projectId = ((await response.json()) as { project: { id: string } }).project.id;
  await expect(page.getByLabel("Current workspace")).toHaveText("Gesture performance fixture");
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "presented", {
    timeout: 30_000,
  });
  return projectId;
}

async function createAndApplyCircle(page: Page) {
  const canvas = page.locator("[data-studio-canvas]");
  await page.getByRole("slider", { name: "Scene playhead" }).fill("0");
  const previousRevision = await retainedRevision(page);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("The Studio canvas is unavailable for circle placement.");
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  // Creation has a provisional retained frame before its editor transaction is
  // committed. Waiting for it is the contract that makes the following Apply
  // valid in the fixture harness as well as the product.
  await waitForNewPresentedRevision(page, previousRevision);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
}

test("profiles a local WebGPU circle drag without rebuilding the app shell", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await installRenderProbe(page);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page);
    await createAndApplyCircle(page);

    const circle = page.getByRole("button", { name: "Move Circle", exact: true });
    await expect(circle).toBeVisible();
    const drag = await profilePointerDrag(page, circle, { x: 96, y: 48 });
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();

    const playback = await profilePlayback(page);

    const report = {
      environment: { browser: testInfo.project.name, viewport: testInfo.project.use.viewport },
      gesture: drag,
      playback,
      scene: { fixture: "studio-native", insertedCircles: 1 },
    };
    console.info(`STUDIO_GESTURE_PROFILE ${JSON.stringify(report)}`);
    await testInfo.attach("studio-gesture-profile.json", {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: "application/json",
    });
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

import { expect, type Locator, type Page, test } from "@playwright/test";

import type { StudioRenderBoundary, StudioRenderProfileEvent } from "../src/studio/studio-render-profiler";
import { openWorkspace } from "./workspace";

const POINTER_MOVE_STEPS = 24;
const SLOW_FRAME_THRESHOLD_MS = 32;

type BrowserRenderProbe = {
  events: StudioRenderProfileEvent[];
  frameTimes: number[];
  generation: number;
};

type RenderProbeWindow = typeof globalThis & {
  __POIETRA_STUDIO_RENDER_PROBE__?: (event: StudioRenderProfileEvent) => void;
  __POIETRA_STUDIO_RENDER_PROBE_STATE__?: BrowserRenderProbe;
};

type GestureProfile = Readonly<{
  boundaries: Readonly<
    Record<
      StudioRenderBoundary,
      Readonly<{
        actualDurationMs: number;
        commits: number;
        maxActualDurationMs: number;
        renders: number;
      }>
    >
  >;
  frameIntervalsMs: readonly number[];
  maxFrameIntervalMs: number;
  pointerMoveSteps: number;
  sampledFrames: number;
  slowFrames: number;
}>;

async function installRenderProbe(page: Page) {
  await page.addInitScript(() => {
    const browserWindow = globalThis as RenderProbeWindow;
    const state: BrowserRenderProbe = { events: [], frameTimes: [], generation: 0 };
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
    state.frameTimes = [];
    state.generation += 1;
    const generation = state.generation;
    const sampleFrame = (at: number) => {
      if (state.generation !== generation) return;
      state.frameTimes.push(at);
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
  });
}

async function stopRenderProfile(page: Page) {
  return page.evaluate(() => {
    const state = (globalThis as RenderProbeWindow).__POIETRA_STUDIO_RENDER_PROBE_STATE__;
    if (!state) throw new Error("The Studio render probe was not installed.");
    state.generation += 1;
    return { events: state.events, frameTimes: state.frameTimes };
  });
}

function summarizeProfile(events: readonly StudioRenderProfileEvent[], frameTimes: readonly number[]): GestureProfile {
  const boundaries = Object.fromEntries(
    (["canvas", "timeline", "toolbar"] as const).map((boundary) => {
      const commits = events.filter((event) => event.boundary === boundary && event.kind === "commit");
      const actualDurations = commits.map((event) => event.actualDuration);
      return [
        boundary,
        {
          actualDurationMs: actualDurations.reduce((total, duration) => total + duration, 0),
          commits: commits.length,
          maxActualDurationMs: Math.max(0, ...actualDurations),
          renders: events.filter((event) => event.boundary === boundary && event.kind === "render").length,
        },
      ];
    }),
  ) as GestureProfile["boundaries"];
  const frameIntervalsMs = frameTimes.slice(1).map((at, index) => at - frameTimes[index]);
  return {
    boundaries,
    frameIntervalsMs,
    maxFrameIntervalMs: Math.max(0, ...frameIntervalsMs),
    pointerMoveSteps: POINTER_MOVE_STEPS,
    sampledFrames: frameTimes.length,
    slowFrames: frameIntervalsMs.filter((duration) => duration > SLOW_FRAME_THRESHOLD_MS).length,
  };
}

async function profilePointerGesture(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The gesture target is not visible.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await settleRender(page);
  await startRenderProfile(page);
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: POINTER_MOVE_STEPS });
  await settleRender(page);
  const { events, frameTimes } = await stopRenderProfile(page);
  await page.mouse.up();

  const profile = summarizeProfile(events, frameTimes);
  expect(profile.boundaries.canvas.renders).toBeGreaterThan(0);
  for (const boundary of ["timeline", "toolbar"] as const) {
    expect(profile.boundaries[boundary].renders, `${boundary} must not rebuild during pointer move`).toBe(0);
    expect(profile.boundaries[boundary].commits, `${boundary} must not commit during pointer move`).toBe(0);
  }
  return profile;
}

async function createRepresentativeScene(page: Page) {
  const canvas = page.locator("[data-studio-canvas]");
  const positions = [
    { x: 90, y: 70 },
    { x: 210, y: 70 },
    { x: 330, y: 70 },
    { x: 90, y: 190 },
    { x: 210, y: 190 },
    { x: 330, y: 190 },
  ] as const;

  for (const position of positions) {
    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position });
  }
  await expect(page.getByRole("button", { name: "Move Circle" })).toHaveCount(positions.length);
  await page.getByRole("button", { name: "Apply program" }).click();
  await page.getByRole("button", { name: "Set position" }).click();
}

test("profiles drag and resize render boundaries in a representative multi-entity scene", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await installRenderProbe(page);
  await openWorkspace(page);
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await createRepresentativeScene(page);

  const circle = page.getByRole("button", { name: "Move Circle" }).first();
  const drag = await profilePointerGesture(page, circle, { x: 96, y: 48 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();

  await circle.click();
  const resizeHandle = page.getByRole("button", { name: "Resize Circle from bottom-right corner" });
  await expect(resizeHandle).toBeVisible();
  const resize = await profilePointerGesture(page, resizeHandle, { x: 60, y: 40 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();

  const report = {
    environment: {
      browser: testInfo.project.name,
      slowFrameThresholdMs: SLOW_FRAME_THRESHOLD_MS,
      viewport: testInfo.project.use.viewport,
    },
    gestures: { drag, resize },
    scene: { insertedCircles: 6 },
  };
  console.info(`STUDIO_GESTURE_PROFILE ${JSON.stringify(report)}`);
  await testInfo.attach("studio-gesture-profile.json", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
});

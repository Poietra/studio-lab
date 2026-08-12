import { expect, type Page, type TestInfo, test } from "@playwright/test";

import {
  type ProgramRenderRequest,
  type RenderSessionView,
  renderProgramBatchId,
  renderRequestId,
} from "../src/render-pipeline/contracts";
import { openWorkspace } from "./workspace";

const FIXTURE_QUERY = "?previewRenderer=fixture";

function requireChromiumAuthorityLane(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "preview-chromium", "This assertion belongs to the non-WebGPU authority lane.");
}

function requireWebGpuDraftLane(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "preview-webgpu", "Visual draft creation requires the canonical WebGPU lane.");
}

async function activateRequestedPreview(page: Page) {
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
}

async function openWorkspaceWithQuery(page: Page, query: string, name: string) {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${name} workspace` }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText(name);
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await activateRequestedPreview(page);
}

async function makePreviewHarnessCommandAvailable(page: Page) {
  await page.route("**/api/manim/projects/preview-harness/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...workspace,
        commandAvailable: true,
        renderCapability: { available: true, kind: "local-command", unavailableReason: null },
      },
      response,
    });
  });
}

function readyRenderSession(request: ProgramRenderRequest, id: string): RenderSessionView {
  const programs = request.programs ?? [request.program];
  return {
    actionInProgress: false,
    canCancel: false,
    canCommit: true,
    canDiscard: true,
    canUndo: false,
    createdAt: "2026-07-27T00:00:00.000Z",
    error: null,
    id,
    logTail: "fixture render complete",
    patch: {
      anchorLine: 5,
      anchorLines: [5],
      insertedCode: "self.play(FadeIn(circle))",
      patchedSourceHash: request.sourceHash,
      sourceHash: request.sourceHash,
    },
    programBatchId: renderProgramBatchId(programs),
    programTransactionId: request.program.transactionId,
    progress: 1,
    projectId: request.projectId,
    renderRequestId: renderRequestId(request),
    sceneName: request.sceneName,
    sourceAction: null,
    sourcePath: request.sourcePath,
    status: "ready",
    updatedAt: "2026-07-27T00:00:01.000Z",
    videoUrl: null,
  };
}

async function openActivatedPreviewHarnessDraft(page: Page) {
  await page.goto("/?previewRenderer=mathtex-fixture");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  const scene = page.getByLabel("Active imported Scene");
  await scene.selectOption({ label: "studio_mathtex.py · StudioMathTexPreview" });
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toBeVisible();
  await activateRequestedPreview(page);
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });
  return canvasRoot;
}

test("the canonical preview is selected by default but waits for execution consent", async ({ page }, testInfo) => {
  requireChromiumAuthorityLane(testInfo);
  await openWorkspace(page);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "off");
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(0);
  await expect(page.locator("[data-studio-preview-status]")).toHaveCount(0);
  await expect(page.locator('[data-studio-manim-preview-state="awaiting-consent"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /Insert circle/ })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Describe an edit" })).toBeDisabled();
});

test("a legacy server query cannot bypass explicit Scene execution consent", async ({ page }, testInfo) => {
  requireChromiumAuthorityLane(testInfo);
  let executionPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(runtime-traces|scene-snapshots)$/u.test(new URL(request.url()).pathname))
      executionPosts += 1;
  });
  await page.goto("/?previewRenderer=server", { referer: "https://attacker.example/" });
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start preview…" })).toBeVisible();
  expect(executionPosts).toBe(0);

  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  expect(executionPosts).toBe(0);

  const executionRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && /\/(runtime-traces|scene-snapshots)$/u.test(new URL(request.url()).pathname),
  );
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await executionRequest;
  await expect.poll(() => executionPosts).toBeGreaterThan(0);
  await expect
    .poll(async () => page.locator("[data-studio-manim-preview-state]").getAttribute("data-studio-manim-preview-state"))
    .toMatch(/^(failed|presented|unsupported)$/);
  const confirmedExecutionPosts = executionPosts;

  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start preview…" })).toBeVisible();
  expect(executionPosts).toBe(confirmedExecutionPosts);
});

test("an embedded Studio cannot grant Scene execution", async ({ baseURL, page }, testInfo) => {
  requireChromiumAuthorityLane(testInfo);
  if (!baseURL) throw new Error("The preview E2E base URL is unavailable.");
  let snapshotPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(runtime-traces|scene-snapshots)$/u.test(new URL(request.url()).pathname))
      snapshotPosts += 1;
  });
  await page.setContent(`<iframe title="Embedded Studio" src="${baseURL}/?previewRenderer=server"></iframe>`);
  const studio = page.frameLocator('iframe[title="Embedded Studio"]');
  await expect(studio.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await studio.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(studio.locator("[data-studio-canvas]")).toBeVisible();
  await expect(studio.getByText("Open Studio in a top-level tab to start it.")).toBeVisible();
  await expect(studio.getByRole("button", { name: "Start preview…" })).toHaveCount(0);
  expect(snapshotPosts).toBe(0);
});

test("a ready render exposes an explicit MP4 download on the authenticated video route", async ({ page }, testInfo) => {
  requireWebGpuDraftLane(testInfo);
  const renderId = "11111111-1111-4111-8111-111111111129";
  await makePreviewHarnessCommandAvailable(page);
  await page.route("**/api/manim/projects/preview-harness/renders", async (route) => {
    const request = route.request().postDataJSON() as ProgramRenderRequest;
    await route.fulfill({
      json: {
        ...readyRenderSession(request, renderId),
        videoUrl: `/api/manim/renders/${renderId}/video`,
      },
      status: 202,
    });
  });
  await page.route(`**/api/manim/renders/${renderId}/video*`, (route) =>
    route.fulfill({ body: "", contentType: "video/mp4", status: 200 }),
  );
  await openActivatedPreviewHarnessDraft(page);

  await page.getByRole("button", { name: "Render program" }).click();

  const downloadLink = page.getByRole("link", { name: "Download MP4" });
  await expect(downloadLink).toHaveAttribute("download", `poietra-${renderId}.mp4`);
  await expect(downloadLink).toHaveAttribute(
    "href",
    `/api/manim/renders/${renderId}/video?v=${encodeURIComponent("2026-07-27T00:00:01.000Z")}`,
  );
  const [download] = await Promise.all([page.waitForEvent("download"), downloadLink.click()]);
  expect(download.suggestedFilename()).toBe(`poietra-${renderId}.mp4`);
  await download.cancel();
});

test("a terminal source action keeps polling until its exact outcome is known", async ({ page }, testInfo) => {
  requireWebGpuDraftLane(testInfo);
  const renderId = "11111111-1111-4111-8111-111111111122";
  const actionId = "00000000-0000-4000-8000-000000000031";
  let renderSession: RenderSessionView | null = null;
  let renderGets = 0;
  let workspaceGets = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/workspace")) workspaceGets += 1;
  });
  await makePreviewHarnessCommandAvailable(page);
  await page.route("**/api/manim/projects/preview-harness/renders", async (route) => {
    const request = route.request().postDataJSON() as ProgramRenderRequest;
    renderSession = {
      ...readyRenderSession(request, renderId),
      actionInProgress: true,
      canCommit: false,
      canDiscard: false,
      sourceAction: { id: actionId, kind: "commit", outcome: null, state: "running" },
    };
    await route.fulfill({ json: renderSession, status: 202 });
  });
  await page.route(`**/api/manim/renders/${renderId}`, async (route) => {
    if (!renderSession) throw new Error("The fake render session has not started.");
    renderGets += 1;
    if (renderGets >= 2) {
      renderSession = {
        ...renderSession,
        actionInProgress: false,
        canUndo: true,
        sourceAction: { id: actionId, kind: "commit", outcome: "committed", state: "succeeded" },
        status: "committed",
        updatedAt: "2026-07-27T00:00:02.000Z",
      };
    }
    await route.fulfill({ json: renderSession });
  });
  await openActivatedPreviewHarnessDraft(page);
  const workspaceBaseline = workspaceGets;

  await page.getByRole("button", { name: "Render program" }).click();
  await expect(page.locator("[data-studio-editor]")).toHaveAttribute("inert", "");

  await expect.poll(() => renderGets).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Undo source" })).toBeEnabled();
  await expect.poll(() => workspaceGets).toBeGreaterThan(workspaceBaseline);
  await expect(page.locator("[data-studio-editor]")).not.toHaveAttribute("inert", "");
  await page.waitForTimeout(250);
  expect(renderGets).toBeLessThanOrEqual(3);
});

test("source reimport locks Studio editing until the committed revision is loaded", async ({ page }, testInfo) => {
  requireWebGpuDraftLane(testInfo);
  const renderId = "11111111-1111-4111-8111-111111111126";
  const patchedSourceHash = "b".repeat(64);
  let renderSession: RenderSessionView | null = null;
  let workspaceGets = 0;
  let releaseReimport = () => {};
  const reimportRelease = new Promise<void>((resolve) => {
    releaseReimport = resolve;
  });
  let markReimportStarted = () => {};
  const reimportStarted = new Promise<void>((resolve) => {
    markReimportStarted = resolve;
  });
  await page.route("**/api/manim/projects/preview-harness/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as {
      sources: readonly Readonly<{
        path: string;
        scenes: readonly Readonly<{ name: string; sourceHash: string } & Record<string, unknown>>[];
      }>[];
    } & Record<string, unknown>;
    workspaceGets += 1;
    if (workspaceGets === 2) {
      markReimportStarted();
      await reimportRelease;
    }
    const sources = workspace.sources.map((source) => ({
      ...source,
      scenes: source.scenes.map((scene) =>
        workspaceGets >= 3 && source.path === "studio_mathtex.py" && scene.name === "StudioMathTexPreview"
          ? { ...scene, sourceHash: patchedSourceHash }
          : scene,
      ),
    }));
    await route.fulfill({
      json: {
        ...workspace,
        commandAvailable: true,
        renderCapability: { available: true, kind: "local-command", unavailableReason: null },
        sources,
      },
      response,
    });
  });
  await page.route("**/api/manim/projects/preview-harness/renders", async (route) => {
    const request = route.request().postDataJSON() as ProgramRenderRequest;
    const ready = readyRenderSession(request, renderId);
    renderSession = { ...ready, patch: { ...ready.patch, patchedSourceHash } };
    await route.fulfill({ json: renderSession, status: 202 });
  });
  await page.route(`**/api/manim/renders/${renderId}/commit`, async (route) => {
    const body = route.request().postDataJSON() as { actionId: string };
    renderSession = {
      ...renderSession!,
      canCommit: false,
      canDiscard: false,
      canUndo: true,
      sourceAction: { id: body.actionId, kind: "commit", outcome: "committed", state: "succeeded" },
      status: "committed",
      updatedAt: "2026-07-27T00:00:02.000Z",
    };
    await route.fulfill({ json: renderSession });
  });
  await page.route(`**/api/manim/renders/${renderId}`, async (route) => {
    if (!renderSession) throw new Error("The fake render session has not started.");
    await route.fulfill({ json: renderSession });
  });
  await openActivatedPreviewHarnessDraft(page);
  await page.getByRole("button", { name: "Render program" }).click();
  await page.getByRole("button", { name: "Commit to source" }).click();
  await page.getByRole("button", { name: "Commit source" }).click();

  await reimportStarted;
  const editor = page.locator("[data-studio-editor]");
  try {
    await expect(editor).toHaveAttribute("aria-busy", "true");
    await expect(editor).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Reimporting…" })).toBeDisabled();
  } finally {
    releaseReimport();
  }

  await expect(editor).toHaveAttribute("aria-busy", "false");
  await expect(editor).not.toHaveAttribute("inert", "");
  expect(workspaceGets).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("button", { name: "Undo source" })).toBeEnabled();
});

test("an unknown Commit response stays locked until the source-action ledger resolves", async ({ page }, testInfo) => {
  requireWebGpuDraftLane(testInfo);
  const renderId = "11111111-1111-4111-8111-111111111127";
  let renderSession: RenderSessionView | null = null;
  let renderGets = 0;
  let cancellationPosts = 0;
  let workspaceGets = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/workspace")) workspaceGets += 1;
  });
  await makePreviewHarnessCommandAvailable(page);
  await page.route("**/api/manim/projects/preview-harness/renders", async (route) => {
    const request = route.request().postDataJSON() as ProgramRenderRequest;
    renderSession = readyRenderSession(request, renderId);
    await route.fulfill({ json: renderSession, status: 202 });
  });
  await page.route(`**/api/manim/renders/${renderId}/commit`, async (route) => {
    const body = route.request().postDataJSON() as { actionId: string };
    renderSession = {
      ...renderSession!,
      actionInProgress: true,
      canCommit: false,
      canDiscard: false,
      sourceAction: { id: body.actionId, kind: "commit", outcome: null, state: "running" },
    };
    await route.fulfill({ json: { error: "The response was lost after dispatch." }, status: 500 });
  });
  await page.route(`**/api/manim/renders/${renderId}/cancel-source-action`, async (route) => {
    cancellationPosts += 1;
    await route.fulfill({ json: { error: "Cancellation outcome is temporarily unavailable." }, status: 503 });
  });
  await page.route(`**/api/manim/renders/${renderId}`, async (route) => {
    if (!renderSession?.sourceAction) throw new Error("The fake source action has not started.");
    renderGets += 1;
    if (renderGets >= 2) {
      renderSession = {
        ...renderSession,
        actionInProgress: false,
        canUndo: true,
        sourceAction: { ...renderSession.sourceAction, outcome: "committed", state: "succeeded" },
        status: "committed",
        updatedAt: "2026-07-27T00:00:03.000Z",
      };
    }
    await route.fulfill({ json: renderSession });
  });
  await openActivatedPreviewHarnessDraft(page);
  await page.getByRole("button", { name: "Render program" }).click();
  await page.getByRole("button", { name: "Commit to source" }).click();
  const workspaceBaseline = workspaceGets;
  await page.getByRole("button", { name: "Commit source" }).click();

  const editor = page.locator("[data-studio-editor]");
  await expect(editor).toHaveAttribute("inert", "");
  await expect.poll(() => cancellationPosts).toBe(1);
  await expect.poll(() => renderGets).toBeGreaterThanOrEqual(2);
  await expect.poll(() => workspaceGets).toBeGreaterThan(workspaceBaseline);
  await expect(editor).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Undo source" })).toBeEnabled();
});

test("the fixture never correlates with a workspace outside its checked-in harness Scene", async ({
  page,
}, testInfo) => {
  requireChromiumAuthorityLane(testInfo);
  await openWorkspaceWithQuery(page, FIXTURE_QUERY, "Studio Lab");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute(
    "data-preview-fallback-reason",
    /snapshot-unavailable|capability-unsupported/,
  );
  await expect(page.locator('[data-studio-preview-status="fallback"]')).toBeVisible();
  await expect(page.locator("[data-studio-preview-canvas]")).toBeHidden();
  await expect(canvasRoot).not.toHaveAttribute("data-preview-packet-id", /.+/);
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
  await expect(page.locator("[data-studio-entity]")).toHaveCount(0);
});

test("an unavailable WebGPU host is explicit and never restores DOM Scene paint", async ({ page }, testInfo) => {
  requireChromiumAuthorityLane(testInfo);
  await openWorkspaceWithQuery(page, FIXTURE_QUERY, "Preview Harness");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(1);
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute("data-preview-fallback-reason", /capability-unsupported|install-failed/);
  await expect(page.locator('[data-studio-preview-status="fallback"]')).toBeVisible();
  await expect(page.locator("[data-studio-preview-canvas]")).toBeHidden();
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
  await expect(page.locator("[data-studio-entity]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Insert circle/ })).toBeDisabled();
});

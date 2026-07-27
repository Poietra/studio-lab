import { expect, test, type Page } from "@playwright/test";

import {
  renderProgramBatchId,
  renderRequestId,
  type ProgramRenderRequest,
  type RenderSessionView,
} from "../src/render-pipeline/contracts";
import { openWorkspace } from "./workspace";

const FIXTURE_QUERY = "?previewRenderer=fixture";
const SERVER_QUERY = "?previewRenderer=server";

async function activateRequestedPreview(page: Page) {
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
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
    await route.fulfill({ json: { ...workspace, commandAvailable: true }, response });
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

async function openPreviewHarnessDraft(page: Page) {
  await page.goto(`/${FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toBeVisible();
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });
  return canvasRoot;
}

test("the retained canvas preview stays off unless explicitly requested", async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "off");
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(0);
  await expect(page.locator("[data-studio-preview-status]")).toHaveCount(0);
});

test("a server preview URL requires explicit confirmation before Scene execution", async ({ page }) => {
  let snapshotPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/scene-snapshots")) snapshotPosts += 1;
  });
  await page.goto(`/${SERVER_QUERY}`, { referer: "https://attacker.example/" });
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable preview…" })).toBeVisible();
  expect(snapshotPosts).toBe(0);

  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  expect(snapshotPosts).toBe(0);

  const snapshotRequest = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/scene-snapshots"),
  );
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await snapshotRequest;
  expect(snapshotPosts).toBe(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable preview…" })).toBeVisible();
  expect(snapshotPosts).toBe(1);
});

test("an embedded server preview URL cannot grant Scene execution", async ({ baseURL, page }) => {
  if (!baseURL) throw new Error("The preview E2E base URL is unavailable.");
  let snapshotPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/scene-snapshots")) snapshotPosts += 1;
  });
  await page.setContent(`<iframe title="Embedded Studio" src="${baseURL}/${SERVER_QUERY}"></iframe>`);
  const studio = page.frameLocator('iframe[title="Embedded Studio"]');
  await expect(studio.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await studio.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(studio.locator("[data-studio-canvas]")).toBeVisible();
  await expect(studio.getByText("Open Studio in a top-level tab to enable it.")).toBeVisible();
  await expect(studio.getByRole("button", { name: "Enable preview…" })).toHaveCount(0);
  expect(snapshotPosts).toBe(0);
});

test("enabling verified timing while Apply preflight is pending cannot apply a stale draft", async ({ page }) => {
  let releaseExport = () => {};
  const exportRelease = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  await page.route("**/api/manim/projects/preview-harness/export", async (route) => {
    await exportRelease;
    await route.continue();
  });
  await makePreviewHarnessCommandAvailable(page);
  await page.goto(`/${FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toBeVisible();
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Render program" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export .py" })).toBeEnabled();

  const exportStarted = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/export"),
  );
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("button", { name: "Checking source…" })).toBeVisible();
  await exportStarted;
  try {
    await page.getByRole("button", { name: "Enable preview…" }).click();
    await page.getByRole("button", { name: "Run Scene preview" }).click();
    await expect(page.getByRole("heading", { name: "Scene timing needs resolution" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Render program" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Export .py" })).toBeDisabled();
  } finally {
    releaseExport();
  }

  await expect(page.getByRole("button", { name: "Apply program" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByText(/Waiting will not resolve this conflict/).first()).toBeVisible();
});

test("a timing conflict aborts an in-flight modified source Export before download", async ({ page }) => {
  let releaseExport = () => {};
  const exportRelease = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.route("**/api/manim/projects/preview-harness/export", async (route) => {
    await exportRelease;
    await route
      .fulfill({
        body: "from manim import *\n",
        headers: {
          "content-disposition": 'attachment; filename="stale.poietra.py"',
          "content-type": "text/x-python; charset=utf-8",
          "x-poietra-project-id": "preview-harness",
        },
      })
      .catch(() => undefined);
  });
  await makePreviewHarnessCommandAvailable(page);
  await page.goto(`/${FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toBeVisible();
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });

  const exportStarted = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/export"),
  );
  await page.getByRole("button", { name: "Export .py" }).click();
  await expect(page.getByRole("button", { name: "Exporting…" })).toBeVisible();
  await exportStarted;
  try {
    await activateRequestedPreview(page);
    await expect(page.getByRole("heading", { name: "Scene timing needs resolution" })).toBeVisible();
  } finally {
    releaseExport();
  }

  await expect(page.getByRole("button", { name: "Export .py" })).toBeDisabled();
  expect(downloads).toBe(0);
});

test("a stale Render response is atomically abandoned after timing changes", async ({ page }) => {
  const renderId = "11111111-1111-4111-8111-111111111121";
  let releaseRender = () => {};
  const renderRelease = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  let startedSession: RenderSessionView | null = null;
  let abandonPosts = 0;
  await makePreviewHarnessCommandAvailable(page);
  await page.route("**/api/manim/projects/preview-harness/renders", async (route) => {
    const request = route.request().postDataJSON() as ProgramRenderRequest;
    startedSession = readyRenderSession(request, renderId);
    await renderRelease;
    await route.fulfill({ json: startedSession, status: 202 });
  });
  await page.route(`**/api/manim/renders/${renderId}/abandon`, async (route) => {
    abandonPosts += 1;
    expect(route.request().postDataJSON()).toEqual({ renderRequestId: startedSession?.renderRequestId });
    await route.fulfill({ json: { abandoned: true } });
  });
  await openPreviewHarnessDraft(page);

  const renderStarted = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/renders"),
  );
  await page.getByRole("button", { name: "Render program" }).click();
  await renderStarted;
  await activateRequestedPreview(page);
  await expect(page.getByRole("heading", { name: "Scene timing needs resolution" })).toBeVisible();
  releaseRender();

  await expect.poll(() => abandonPosts).toBe(1);
  await expect(page.getByRole("button", { name: "Commit to source" })).toHaveCount(0);
});

test("a terminal source action keeps polling until its exact outcome is known", async ({ page }) => {
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
  await openPreviewHarnessDraft(page);
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

test("source reimport locks Studio editing until the committed revision is loaded", async ({ page }) => {
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
        workspaceGets >= 3 && source.path === "shared_circle_opacity.py" && scene.name === "SharedCircleOpacity"
          ? { ...scene, sourceHash: patchedSourceHash }
          : scene,
      ),
    }));
    await route.fulfill({ json: { ...workspace, commandAvailable: true, sources }, response });
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
  await openPreviewHarnessDraft(page);
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

test("an unknown Commit response stays locked until the source-action ledger resolves", async ({ page }) => {
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
  await openPreviewHarnessDraft(page);
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

for (const sourceOutcome of ["cancelled", "committed", "concurrent-commit"] as const) {
  test(`a timing conflict reconciles a pending Commit when cancellation finishes ${sourceOutcome}`, async ({
    page,
  }) => {
    const renderId = {
      cancelled: "11111111-1111-4111-8111-111111111123",
      committed: "11111111-1111-4111-8111-111111111124",
      "concurrent-commit": "11111111-1111-4111-8111-111111111125",
    }[sourceOutcome];
    let renderSession: RenderSessionView | null = null;
    let sourceActionId: string | null = null;
    let releaseCommit = () => {};
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let cancelPosts = 0;
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
      sourceActionId = body.actionId;
      renderSession = {
        ...renderSession!,
        actionInProgress: true,
        canCommit: false,
        canDiscard: false,
        sourceAction: { id: body.actionId, kind: "commit", outcome: null, state: "running" },
      };
      await commitRelease;
      await route.fulfill({ json: { error: "Commit request was cancelled." }, status: 409 }).catch(() => undefined);
    });
    await page.route(`**/api/manim/renders/${renderId}/cancel-source-action`, async (route) => {
      const body = route.request().postDataJSON() as { actionId: string; kind: "commit" };
      expect(body).toEqual({ actionId: sourceActionId, kind: "commit" });
      cancelPosts += 1;
      const sourceChanged = sourceOutcome !== "cancelled";
      const action =
        sourceOutcome === "committed"
          ? ({ id: body.actionId, kind: "commit", outcome: "committed", state: "succeeded" } as const)
          : ({ id: body.actionId, kind: "commit", outcome: null, state: "cancelled" } as const);
      renderSession = {
        ...renderSession!,
        actionInProgress: false,
        canCommit: !sourceChanged,
        canDiscard: !sourceChanged,
        canUndo: sourceChanged,
        sourceAction:
          sourceOutcome === "concurrent-commit"
            ? {
                id: "00000000-0000-4000-8000-000000000032",
                kind: "commit",
                outcome: "committed",
                state: "succeeded",
              }
            : action,
        status: sourceChanged ? "committed" : "ready",
        updatedAt: "2026-07-27T00:00:02.000Z",
      };
      releaseCommit();
      await route.fulfill({ json: { action, session: renderSession } });
    });
    await page.route(`**/api/manim/renders/${renderId}`, async (route) => {
      if (!renderSession) throw new Error("The fake render session has not started.");
      await route.fulfill({ json: renderSession });
    });
    await openPreviewHarnessDraft(page);
    await page.getByRole("button", { name: "Render program" }).click();
    await expect(page.getByRole("button", { name: "Commit to source" })).toBeEnabled();
    const workspaceBaseline = workspaceGets;

    await page.getByRole("button", { name: "Commit to source" }).click();
    const commitStarted = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/commit"),
    );
    await page.getByRole("button", { name: "Commit source" }).click();
    await commitStarted;
    await page.locator('dialog[aria-labelledby="commit-render-title"]').evaluate((dialog: HTMLDialogElement) => {
      dialog.close();
    });
    await activateRequestedPreview(page);
    await expect.poll(() => cancelPosts).toBe(1);
    if (sourceOutcome !== "cancelled") {
      await expect.poll(() => workspaceGets).toBeGreaterThan(workspaceBaseline);
      await expect(page.getByRole("button", { name: "Undo source" })).toBeEnabled();
    } else {
      await expect(page.getByRole("heading", { name: "Scene timing needs resolution" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Commit to source" })).toBeDisabled();
    }
  });
}

test("a stale rendered session cannot Commit across timing resolution", async ({ page }) => {
  const renderId = "11111111-1111-4111-8111-111111111111";
  let commitPosts = 0;
  let discardPosts = 0;
  let readySession: RenderSessionView | null = null;
  await makePreviewHarnessCommandAvailable(page);
  await page.route("**/api/manim/projects/preview-harness/renders", async (route) => {
    const request = route.request().postDataJSON() as ProgramRenderRequest;
    const programs = request.programs ?? [request.program];
    readySession = {
      actionInProgress: false,
      canCancel: false,
      canCommit: true,
      canDiscard: true,
      canUndo: false,
      createdAt: "2026-07-27T00:00:00.000Z",
      error: null,
      id: renderId,
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
    await route.fulfill({ json: readySession, status: 202 });
  });
  await page.route("**/api/manim/renders/**", async (route) => {
    if (!readySession) throw new Error("The fake render session has not started.");
    const url = new URL(route.request().url());
    if (!url.pathname.includes(renderId)) return route.fallback();
    if (url.pathname.endsWith("/commit")) commitPosts += 1;
    if (url.pathname.endsWith("/discard")) {
      discardPosts += 1;
      readySession = {
        ...readySession,
        canCommit: false,
        canDiscard: false,
        status: "discarded",
        updatedAt: "2026-07-27T00:00:02.000Z",
      };
    }
    await route.fulfill({ json: readySession });
  });

  await page.goto(`/${FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toBeVisible();
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Render program" }).click();
  await expect(page.getByRole("button", { name: "Commit to source" })).toBeEnabled();

  await activateRequestedPreview(page);
  await expect(page.getByRole("heading", { name: "Scene timing needs resolution" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Commit to source" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard preview" })).toBeEnabled();

  await page.getByRole("button", { name: "Resolve timing" }).click();
  await expect(page.getByRole("alertdialog", { name: "Discard Studio edit history?" })).toBeVisible();
  await page.getByRole("button", { name: "Discard and resolve" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Commit to source" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard preview" })).toBeEnabled();

  await page.getByRole("button", { name: "Discard preview" }).click();
  await expect(page.getByRole("button", { name: "Commit to source" })).toHaveCount(0);
  await expect.poll(() => discardPosts).toBe(1);
  expect(commitPosts).toBe(0);
});

test("the fixture never correlates with a workspace outside its checked-in harness Scene", async ({ page }) => {
  await openWorkspaceWithQuery(page, FIXTURE_QUERY, "Studio Lab");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute(
    "data-preview-fallback-reason",
    /snapshot-unavailable|capability-unsupported/,
  );
  await expect(page.locator("[data-studio-preview-status]")).toContainText("Canvas preview fallback");
  await expect(page.locator("[data-studio-semantic-paint='deferred-to-canvas']")).toHaveCount(0);
});

test("the harness opt-in reports a truthful phase and preserves the semantic editor", async ({ page }) => {
  await openWorkspaceWithQuery(page, FIXTURE_QUERY, "Preview Harness");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(1);

  // The host must settle on a truthful phase: a presented, exactly
  // correlated frame, or a whole-Scene fallback that names its reason.
  await expect
    .poll(async () => {
      const phase = await canvasRoot.getAttribute("data-preview-renderer");
      return phase === "presented" || phase === "fallback" ? phase : null;
    })
    .not.toBeNull();
  const status = page.locator("[data-studio-preview-status]");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Canvas preview");
  if ((await canvasRoot.getAttribute("data-preview-renderer")) === "fallback") {
    const reason = await canvasRoot.getAttribute("data-preview-fallback-reason");
    expect(reason).toBeTruthy();
    await expect(status).toContainText("fallback");
  }

  // Semantic DOM and editing operations remain intact under the opt-in, and
  // any Studio edit makes the fixture snapshot uncorrelated by definition.
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(page.locator("[data-studio-semantic-paint='painted']").first()).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  const inserted = page.getByRole("button", { name: "Move Circle", exact: true });
  await inserted.click();
  await expect(inserted).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Timeline playhead" })).toBeVisible();
});

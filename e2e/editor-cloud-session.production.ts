import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

import type { EditorSessionSnapshotV1 } from "../src/collaboration/editor-session-contract";
import { editorSessionIdentityKey, editorSessionStorageKey } from "../src/studio/editor-session-store";
import { createInitialEditorState, snapshotCloudEditorSessionV1 } from "../src/studio/use-editor-controller";

const WORKSPACE_NAME = "Production Demo";

type EditorFixtureIdentity = Readonly<{
  organizationId: string;
  projectId: string;
  sceneId: string;
  sourceHash: string;
  userId: string;
}>;

type SessionPutBody = Readonly<{ snapshot?: EditorSessionSnapshotV1 }>;

function sessionPut(
  page: Page,
  status: number,
  matchesSnapshot: (snapshot: EditorSessionSnapshotV1) => boolean = () => true,
) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "PUT" &&
      /^\/api\/editor\/projects\/production-demo\/documents\/[0-9a-f]{64}\/session$/u.test(url.pathname) &&
      response.status() === status
    ) {
      try {
        const snapshot = (response.request().postDataJSON() as SessionPutBody).snapshot;
        return snapshot !== undefined && matchesSnapshot(snapshot);
      } catch {
        return false;
      }
    }
    return false;
  });
}

function mutationPost(page: Page, status = 201) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      /^\/api\/editor\/projects\/production-demo\/documents\/[0-9a-f]{64}\/events$/u.test(url.pathname) &&
      response.status() === status
    );
  });
}

async function resetEditorAuthority(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/__e2e/editor/reset", { method: "POST" });
    if (!response.ok) throw new TypeError(`Editor E2E reset failed (${response.status}).`);
    return (await response.json()) as EditorFixtureIdentity;
  });
}

async function signInAndSelectStudio(page: Page) {
  await page.goto("/");
  const fixture = await resetEditorAuthority(page);
  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Billing account" })).toBeVisible();
  await page.getByLabel("Active organization").selectOption("editor-team");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  return fixture;
}

async function openStudio(page: Page) {
  await page.getByRole("button", { name: `Open ${WORKSPACE_NAME} workspace` }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText(WORKSPACE_NAME);
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
}

async function signInAndOpenStudio(page: Page) {
  const fixture = await signInAndSelectStudio(page);
  await openStudio(page);
  return fixture;
}

async function reopenStudio(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${WORKSPACE_NAME} workspace` }).click();
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
}

async function sameAccountContext(browser: Browser, source: BrowserContext, origin: string) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: { cookies: await source.cookies(), origins: [] },
    viewport: { height: 900, width: 1_440 },
  });
  const page = await context.newPage();
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${WORKSPACE_NAME} workspace` }).click();
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  return { context, page };
}

async function setPlayheadAndAwaitCloudSave(
  page: Page,
  value: number,
  status = 200,
  matchesSnapshot: (snapshot: EditorSessionSnapshotV1) => boolean = () => true,
) {
  const response = sessionPut(page, status, (snapshot) => snapshot.currentTime === value && matchesSnapshot(snapshot));
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill(String(value));
  await response;
  await expect.poll(async () => Number(await playhead.inputValue())).toBeCloseTo(value, 2);
}

function localStorageFixture(identity: EditorFixtureIdentity, currentTime: number) {
  const exactIdentity = {
    projectId: identity.projectId,
    sceneId: identity.sceneId,
    sourceHash: identity.sourceHash,
  };
  const retainedIdentity = {
    projectId: identity.projectId,
    sceneId: "retained-e2e-scene",
    sourceHash: "b".repeat(64),
  };
  const storedIdentity = (value: typeof exactIdentity) => {
    const key = editorSessionIdentityKey(value);
    if (key === null) throw new TypeError("The Editor E2E local identity is invalid.");
    const [projectId, sceneKey, sourceHash] = JSON.parse(key) as [string, string, string];
    return { projectId, sceneKey, sourceHash };
  };
  return {
    envelope: {
      entries: [
        {
          identity: storedIdentity(exactIdentity),
          savedAt: 200,
          snapshot: snapshotCloudEditorSessionV1({ ...createInitialEditorState(), currentTime }),
        },
        {
          identity: storedIdentity(retainedIdentity),
          savedAt: 100,
          snapshot: snapshotCloudEditorSessionV1({ ...createInitialEditorState(), currentTime: 1.25 }),
        },
      ],
      version: 1,
    },
    storageKey: editorSessionStorageKey({
      organizationId: identity.organizationId,
      userId: identity.userId,
    }),
  } as const;
}

async function writeLocalStorageFixture(page: Page, fixture: ReturnType<typeof localStorageFixture>) {
  await page.evaluate(
    ({ envelope, storageKey }) => window.localStorage.setItem(storageKey, JSON.stringify(envelope)),
    fixture,
  );
}

async function readLocalStorageFixture(page: Page, storageKey: string) {
  return page.evaluate((key) => {
    const serialized = window.localStorage.getItem(key);
    return serialized === null ? null : (JSON.parse(serialized) as ReturnType<typeof localStorageFixture>["envelope"]);
  }, storageKey);
}

test("restores a private editor session after reload and in a fresh context for the same account", async ({
  browser,
  page,
}) => {
  await signInAndOpenStudio(page);
  await setPlayheadAndAwaitCloudSave(page, 3.25);

  await reopenStudio(page);
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(3.25, 2);

  const peer = await sameAccountContext(browser, page.context(), new URL("/", page.url()).href);
  try {
    await expect
      .poll(async () => Number(await peer.page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
      .toBeCloseTo(3.25, 2);
  } finally {
    await peer.context.close();
  }
});

test("restores draft authoring metadata and Undo history before a cloud-backed Redo", async ({ page }) => {
  await signInAndOpenStudio(page);
  const canvas = page.locator("[data-studio-canvas]");

  await page.getByRole("slider", { name: "Scene playhead" }).fill("1");
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvas.click({ position: { x: 190, y: 130 } });
  await page.getByRole("button", { name: "Create animation" }).click();
  await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("2.4");
  await page.getByRole("button", { name: "Set position" }).click();
  await setPlayheadAndAwaitCloudSave(
    page,
    4.5,
    200,
    (snapshot) =>
      snapshot.draftProgram !== null && snapshot.interactionMode === "position" && snapshot.motionDuration === 2.4,
  );

  await reopenStudio(page);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Set position" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Create animation" }).click();
  await expect(page.getByRole("spinbutton", { name: "New motion duration in seconds" })).toHaveValue("2.4");

  const apply = mutationPost(page);
  await page.getByRole("button", { name: "Apply program" }).click();
  await apply;
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  const undo = mutationPost(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await undo;
  await expect(page.getByRole("button", { name: "Move Circle" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo" })).toBeVisible();

  await reopenStudio(page);
  await expect(page.getByRole("button", { name: "Redo" })).toBeVisible();
  const redo = mutationPost(page);
  await page.getByRole("button", { name: "Redo" }).click();
  await redo;
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
});

test("a session CAS loser keeps its local UI and cannot silently overwrite the winner", async ({ browser, page }) => {
  await signInAndOpenStudio(page);
  const origin = new URL("/", page.url()).href;
  const loser = await sameAccountContext(browser, page.context(), origin);

  try {
    await setPlayheadAndAwaitCloudSave(page, 2.25);
    await setPlayheadAndAwaitCloudSave(loser.page, 6.5, 409);

    await expect(loser.page.getByRole("alert")).toContainText("private Editor session changed in another request");
    await expect(loser.page.locator("[data-studio-canvas]")).toBeVisible();
    await expect
      .poll(async () => Number(await loser.page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
      .toBeCloseTo(6.5, 2);

    const observer = await sameAccountContext(browser, page.context(), origin);
    try {
      await expect
        .poll(async () => Number(await observer.page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
        .toBeCloseTo(2.25, 2);
    } finally {
      await observer.context.close();
    }
  } finally {
    await loser.context.close();
  }
});

test("migrates the exact local session into an absent cloud session and retains unrelated local state", async ({
  page,
}) => {
  await page.goto("/");
  const identity = await resetEditorAuthority(page);
  const local = localStorageFixture(identity, 5.75);
  await writeLocalStorageFixture(page, local);

  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Billing account" })).toBeVisible();
  await page.getByLabel("Active organization").selectOption(identity.organizationId);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();

  const migrated = sessionPut(page, 200, (snapshot) => snapshot.currentTime === 5.75);
  await openStudio(page);
  await migrated;
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(5.75, 2);
  await expect
    .poll(() => readLocalStorageFixture(page, local.storageKey))
    .toEqual({
      entries: [local.envelope.entries[1]],
      version: 1,
    });
});

test("keeps an exact local session when a cloud session already exists", async ({ page }) => {
  const identity = await signInAndSelectStudio(page);
  const initialized = sessionPut(page, 200, (snapshot) => snapshot.currentTime === 1);
  await openStudio(page);
  await initialized;

  const local = localStorageFixture(identity, 6.75);
  await writeLocalStorageFixture(page, local);
  await reopenStudio(page);

  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(1, 2);
  await expect.poll(() => readLocalStorageFixture(page, local.storageKey)).toEqual(local.envelope);
});

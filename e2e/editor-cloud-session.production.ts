import { type Browser, type BrowserContext, expect, type Page, type Request, test } from "@playwright/test";
import { Pool } from "pg";

import type { EditorSessionSnapshotV1 } from "../src/collaboration/editor-session-contract";
import { editorSessionPendingJournalEntryStoragePrefixV1 } from "../src/studio/editor-session-pending-journal";
import { editorSessionIdentityKey, editorSessionStorageKey } from "../src/studio/editor-session-store";
import { createInitialEditorState, snapshotCloudEditorSessionV1 } from "../src/studio/use-editor-controller";
import { ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1 } from "./account-production-fixture";
import {
  cleanupAccountEditorDocumentFixtureV1,
  prepareAccountEditorDocumentFixtureV1,
} from "./editor-document-postgres-fixture";

const WORKSPACE_NAME = "Production Demo";
const SESSION_PUT_PATH = /^\/api\/editor\/projects\/production-demo\/documents\/[0-9a-f]{64}\/session$/u;
const SESSION_PUT_ROUTE = "**/api/editor/projects/production-demo/documents/*/session?*";

type EditorFixtureIdentity = Readonly<{
  organizationId: string;
  projectId: string;
  sceneId: string;
  sourceHash: string;
  userId: string;
}>;

const databaseUrl = process.env.POIETRA_ACCOUNT_E2E_DATABASE_URL;
if (!databaseUrl) throw new TypeError("The account Editor E2E requires its isolated PostgreSQL database.");
const fixturePool = new Pool({ connectionString: databaseUrl, max: 1 });

test.afterEach(async () => {
  await cleanupAccountEditorDocumentFixtureV1(fixturePool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
});

test.afterAll(async () => {
  await fixturePool.end();
});

type SessionPutBody = Readonly<{ snapshot?: EditorSessionSnapshotV1 }>;
type StoredSessionPutResult = Readonly<{
  kind: "stored";
  replayed: boolean;
  session: Readonly<{ sessionGeneration: string }>;
}>;
type AvailableSessionReadResult = Readonly<{
  kind: "available";
  session: Readonly<{ sessionGeneration: string; snapshot: EditorSessionSnapshotV1 }>;
}>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve } as const;
}

function sessionPutSnapshot(request: Request) {
  if (request.method() !== "PUT" || !SESSION_PUT_PATH.test(new URL(request.url()).pathname)) return null;
  try {
    return (request.postDataJSON() as SessionPutBody).snapshot ?? null;
  } catch {
    return null;
  }
}

function sessionPut(
  page: Page,
  status: number,
  matchesSnapshot: (snapshot: EditorSessionSnapshotV1) => boolean = () => true,
) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (response.request().method() === "PUT" && SESSION_PUT_PATH.test(url.pathname) && response.status() === status) {
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

async function prepareEditorAuthority() {
  return prepareAccountEditorDocumentFixtureV1(fixturePool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
}

async function signInAndSelectStudio(page: Page) {
  const fixture = await prepareEditorAuthority();
  await page.goto("/");
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

async function pendingJournalTimes(page: Page, identity: EditorFixtureIdentity) {
  const prefix = editorSessionPendingJournalEntryStoragePrefixV1({
    organizationId: identity.organizationId,
    userId: identity.userId,
  });
  return page.evaluate((entryPrefix) => {
    const times: number[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null || !key.startsWith(entryPrefix)) continue;
      const serialized = window.localStorage.getItem(key);
      if (serialized === null) continue;
      const payload = JSON.parse(serialized) as {
        entry?: { request: { snapshot: { currentTime: unknown } } };
        kind?: unknown;
      };
      if (payload.kind !== "entry" || payload.entry === undefined) continue;
      const currentTime = payload.entry.request.snapshot.currentTime;
      if (typeof currentTime === "number") times.push(currentTime);
    }
    return times.length === 0 ? null : times;
  }, prefix);
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

test("flushes a change inside the autosave window before returning to the workspace launcher", async ({ page }) => {
  await signInAndOpenStudio(page);
  await setPlayheadAndAwaitCloudSave(page, 1.5);

  const intercepted = deferred<void>();
  const release = deferred<void>();
  let held = false;
  await page.route(SESSION_PUT_ROUTE, async (route) => {
    const snapshot = sessionPutSnapshot(route.request());
    if (!held && snapshot?.currentTime === 4.25) {
      held = true;
      intercepted.resolve();
      await release.promise;
    }
    await route.continue();
  });

  const stored = sessionPut(page, 200, (snapshot) => snapshot.currentTime === 4.25);
  await page.getByRole("slider", { name: "Scene playhead" }).fill("4.25");
  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await intercepted.promise;
  try {
    await expect(page.locator("[data-studio-canvas]")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await stored;
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();

  await openStudio(page);
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(4.25, 2);
});

test("leaves for the workspace launcher after a bounded flush while the latest PUT remains blocked", async ({
  page,
}) => {
  const identity = await signInAndOpenStudio(page);
  await setPlayheadAndAwaitCloudSave(page, 1.5);

  const intercepted = deferred<void>();
  const release = deferred<void>();
  let held = false;
  await page.route(SESSION_PUT_ROUTE, async (route) => {
    const snapshot = sessionPutSnapshot(route.request());
    if (!held && snapshot?.currentTime === 5.25) {
      held = true;
      intercepted.resolve();
      await Promise.all([
        release.promise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_250);
        }),
      ]);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.getByRole("slider", { name: "Scene playhead" }).fill("5.25");
  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await intercepted.promise;
  try {
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible({ timeout: 3_500 });
    await expect.poll(() => pendingJournalTimes(page, identity)).toContain(5.25);
  } finally {
    release.resolve();
  }

  await openStudio(page);
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(5.25, 2);
  await expect.poll(() => pendingJournalTimes(page, identity)).toBeNull();
});

test("replays the exact pending session after a pre-store request abort and reload", async ({ page }) => {
  const identity = await signInAndOpenStudio(page);
  await setPlayheadAndAwaitCloudSave(page, 1.5);

  const aborted = deferred<void>();
  let blockPendingSnapshot = true;
  await page.route(SESSION_PUT_ROUTE, async (route) => {
    const snapshot = sessionPutSnapshot(route.request());
    if (snapshot?.currentTime === 3.75 && blockPendingSnapshot) {
      aborted.resolve();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.getByRole("slider", { name: "Scene playhead" }).fill("3.75");
  await aborted.promise;
  await expect.poll(() => pendingJournalTimes(page, identity)).toContain(3.75);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect.poll(() => pendingJournalTimes(page, identity)).toContain(3.75);
  blockPendingSnapshot = false;
  await openStudio(page);
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(3.75, 2);
  await expect.poll(() => pendingJournalTimes(page, identity)).toBeNull();
});

test("observes an exact stored session after its response is lost without advancing CAS again", async ({ page }) => {
  const identity = await signInAndOpenStudio(page);
  await setPlayheadAndAwaitCloudSave(page, 1.5);

  const storedWithoutResponse = deferred<StoredSessionPutResult>();
  const immediateRetryAborted = deferred<void>();
  const terminationReplays: StoredSessionPutResult[] = [];
  let matchingPutCount = 0;
  await page.route(SESSION_PUT_ROUTE, async (route) => {
    const snapshot = sessionPutSnapshot(route.request());
    if (snapshot?.currentTime !== 4.75) {
      await route.continue();
      return;
    }
    matchingPutCount += 1;
    if (matchingPutCount === 1) {
      const response = await route.fetch();
      storedWithoutResponse.resolve((await response.json()) as StoredSessionPutResult);
      await route.abort("failed");
      return;
    }
    if (matchingPutCount === 2) {
      immediateRetryAborted.resolve();
      await route.abort("failed");
      return;
    }
    const response = await route.fetch();
    terminationReplays.push((await response.json()) as StoredSessionPutResult);
    await route.fulfill({ response });
  });

  await page.getByRole("slider", { name: "Scene playhead" }).fill("4.75");
  const stored = await storedWithoutResponse.promise;
  await immediateRetryAborted.promise;
  expect(stored).toMatchObject({ kind: "stored", replayed: false });
  await expect.poll(() => pendingJournalTimes(page, identity)).toContain(4.75);

  const cloudRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && SESSION_PUT_PATH.test(url.pathname) && response.status() === 200;
  });
  await reopenStudio(page);
  const observed = (await (await cloudRead).json()) as AvailableSessionReadResult;
  expect(observed).toMatchObject({
    kind: "available",
    session: {
      sessionGeneration: stored.session.sessionGeneration,
      snapshot: { currentTime: 4.75 },
    },
  });
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(4.75, 2);
  await expect.poll(() => pendingJournalTimes(page, identity)).toBeNull();
  for (const replayed of terminationReplays) {
    expect(replayed).toMatchObject({
      kind: "stored",
      replayed: true,
      session: { sessionGeneration: stored.session.sessionGeneration },
    });
  }
});

test("retains the cloud winner and exposes a pending-session conflict after a concurrent CAS advance", async ({
  browser,
  page,
}) => {
  const identity = await signInAndOpenStudio(page);
  await setPlayheadAndAwaitCloudSave(page, 1.5);
  const origin = new URL("/", page.url()).href;
  const aborted = deferred<void>();
  let abortedAttempts = 0;
  let blockPendingLoser = true;
  await page.route(SESSION_PUT_ROUTE, async (route) => {
    const snapshot = sessionPutSnapshot(route.request());
    if (blockPendingLoser && snapshot?.currentTime === 6.5) {
      abortedAttempts += 1;
      if (abortedAttempts === 2) aborted.resolve();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.getByRole("slider", { name: "Scene playhead" }).fill("6.5");
  await aborted.promise;
  await expect.poll(() => pendingJournalTimes(page, identity)).toContain(6.5);

  const winner = await sameAccountContext(browser, page.context(), origin);
  try {
    await setPlayheadAndAwaitCloudSave(winner.page, 2.25);
    blockPendingLoser = false;

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await expect.poll(() => pendingJournalTimes(page, identity)).toContain(6.5);
    await page.getByRole("button", { name: `Open ${WORKSPACE_NAME} workspace` }).click();
    const conflictAlert = page.getByRole("alert");
    await expect(conflictAlert).toContainText("pending private Editor session conflicts with newer cloud state");
    await expect(conflictAlert.getByRole("button", { name: "Clear pending session journal" })).toBeVisible();
    await expect.poll(() => pendingJournalTimes(page, identity)).toContain(6.5);

    const observer = await sameAccountContext(browser, page.context(), origin);
    try {
      await expect
        .poll(async () => Number(await observer.page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
        .toBeCloseTo(2.25, 2);
    } finally {
      await observer.context.close();
    }
  } finally {
    await winner.context.close();
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
  const identity = await prepareEditorAuthority();
  await page.goto("/");
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

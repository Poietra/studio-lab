import { rm } from "node:fs/promises";

import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

const DELETE_TIMEOUT_MS = 10_000;
const DELETE_RETRY_INTERVAL_MS = 100;

function cleanupFailure(
  projectId: string,
  attempts: number,
  startedAt: number,
  status: number,
  body: string,
  requestId: string | undefined,
) {
  const elapsedMs = Date.now() - startedAt;
  const detail = body.trim().slice(0, 500) || "<empty response>";
  const correlation = requestId ? `, request ${requestId}` : "";
  return new Error(
    `Could not unregister fixture workspace ${projectId} after ${attempts} DELETE attempt(s) in ${elapsedMs}ms: HTTP ${status}${correlation}: ${detail}`,
  );
}

async function unregisterFixtureWorkspace(request: APIRequestContext, projectId: string) {
  const startedAt = Date.now();
  const deadline = startedAt + DELETE_TIMEOUT_MS;
  let attempts = 0;
  let lastConflict: Readonly<{ body: string; requestId: string | undefined; status: number }> | null = null;

  while (Date.now() < deadline) {
    attempts += 1;
    let response: APIResponse;
    try {
      response = await request.delete(`/api/manim/projects/${projectId}`, {
        headers: { "content-type": "application/json" },
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (cause) {
      throw new Error(
        `Could not unregister fixture workspace ${projectId}: DELETE attempt ${attempts} did not receive a response.`,
        { cause },
      );
    }
    const status = response.status();
    if (status === 200 || status === 404) return;

    const body = await response.text();
    const requestId = response.headers()["x-poietra-request-id"];
    if (status !== 409) throw cleanupFailure(projectId, attempts, startedAt, status, body, requestId);
    lastConflict = { body, requestId, status };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, Math.min(DELETE_RETRY_INTERVAL_MS, remainingMs));
    });
  }

  if (lastConflict) {
    throw cleanupFailure(
      projectId,
      attempts,
      startedAt,
      lastConflict.status,
      lastConflict.body,
      lastConflict.requestId,
    );
  }
  throw new Error(`Timed out before fixture workspace ${projectId} could be unregistered.`);
}

export async function cleanupFixtureWorkspace(
  request: APIRequestContext,
  fixture: Readonly<{ projectId: string; temporaryRoot?: string }>,
) {
  const errors: unknown[] = [];
  try {
    await unregisterFixtureWorkspace(request, fixture.projectId);
  } catch (error) {
    errors.push(error);
  }

  if (fixture.temporaryRoot) {
    try {
      await rm(fixture.temporaryRoot, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `Fixture workspace ${fixture.projectId} could not be fully cleaned up.`);
  }
}

export async function openWorkspace(page: Page, name = "Studio Lab") {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${name} workspace` }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText(name);
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
}

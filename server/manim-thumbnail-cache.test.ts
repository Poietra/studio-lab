import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ManimThumbnailCache } from "./manim-thumbnail-cache";

const fakeRenderer = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));
const frame = { height: 8, width: 14.222 } as const;
const temporaryRoots: string[] = [];
const caches: ManimThumbnailCache[] = [];

afterEach(async () => {
  await Promise.allSettled(caches.splice(0).map((cache) => cache.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function sceneSource(label: string) {
  return `from manim import *

class ThumbnailScene(Scene):
    def construct(self):
        title = Text(${JSON.stringify(label)})
        self.add(title)
        self.wait(1)
`;
}

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-project-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
  temporaryRoots.push(projectRoot, cacheRoot);
  const sourcePath = join(projectRoot, "scene.py");
  const source = sceneSource("initial");
  await writeFile(sourcePath, source, "utf8");
  return { cacheRoot, projectRoot, source, sourcePath };
}

function thumbnailCache(options: Readonly<{
  cacheRoot: string;
  command?: readonly string[];
  projectRoot: string;
}>) {
  const instance = new ManimThumbnailCache({
    cacheRoot: options.cacheRoot,
    command: options.command ?? [process.execPath, fakeRenderer],
    frame,
    projectId: "default",
    projectRoot: options.projectRoot,
    renderTimeoutMs: 5_000,
  });
  caches.push(instance);
  return instance;
}

async function waitForStatus(
  instance: ManimThumbnailCache,
  expected: "current" | "failed",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await instance.status();
    if (status.state === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Thumbnail did not reach ${expected}.`);
}

describe("persistent real Manim thumbnail cache", () => {
  it("does not execute Python for reads, then stores a source-bound PNG after explicit generation", async () => {
    const { cacheRoot, projectRoot, source } = await fixture();
    const renderMarker = join(projectRoot, "thumbnail-render-started");
    const instance = thumbnailCache({
      cacheRoot,
      command: [process.execPath, fakeRenderer, "--render-start-marker", renderMarker],
      projectRoot,
    });

    await expect(instance.status()).resolves.toMatchObject({
      imageKind: "semantic",
      sourceHash: createHash("sha256").update(source).digest("hex"),
      state: "missing",
    });
    await expect(instance.asset()).resolves.toMatchObject({
      kind: "semantic",
      mediaType: "image/svg+xml; charset=utf-8",
    });
    await expect(readFile(renderMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(instance.generate(async () => true)).resolves.toMatchObject({ state: "generating" });
    expect(instance.isBusy()).toBe(true);
    const current = await waitForStatus(instance, "current");
    expect(current).toMatchObject({
      cachedSourceHash: createHash("sha256").update(source).digest("hex"),
      imageKind: "rendered",
      sceneName: "ThumbnailScene",
      sourcePath: "scene.py",
    });
    expect(current.generatedAt).not.toBeNull();
    expect(await readFile(renderMarker, "utf8")).toBe("started");
    await expect(instance.asset()).resolves.toMatchObject({
      kind: "rendered",
      mediaType: "image/png",
      state: "current",
    });
    expect(instance.isBusy()).toBe(false);
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(source);

    await instance.close();
    const restored = thumbnailCache({
      cacheRoot,
      command: ["poietra-command-that-does-not-exist"],
      projectRoot,
    });
    await expect(restored.status()).resolves.toMatchObject({
      imageKind: "rendered",
      state: "current",
    });
    await expect(restored.asset()).resolves.toMatchObject({ kind: "rendered" });
  });

  it("marks changed source stale and keeps semantic fallback after a failed refresh", async () => {
    const { cacheRoot, projectRoot, source, sourcePath } = await fixture();
    const initial = thumbnailCache({ cacheRoot, projectRoot });
    await initial.generate(async () => true);
    const generated = await waitForStatus(initial, "current");
    await initial.close();

    const changedSource = sceneSource("changed");
    await writeFile(sourcePath, changedSource, "utf8");
    const failing = thumbnailCache({
      cacheRoot,
      command: [process.execPath, fakeRenderer, "--fail-render"],
      projectRoot,
    });
    const stale = await failing.status();
    expect(stale).toMatchObject({
      cachedSourceHash: generated.sourceHash,
      imageKind: "semantic",
      sourceHash: createHash("sha256").update(changedSource).digest("hex"),
      state: "stale",
    });
    await expect(failing.asset()).resolves.toMatchObject({
      kind: "semantic",
      state: "stale",
    });

    await expect(failing.generate(async () => true)).resolves.toMatchObject({ state: "generating" });
    const failed = await waitForStatus(failing, "failed");
    expect(failed.error).toMatch(/exited with code 9/i);
    expect(failed.imageKind).toBe("semantic");
    await expect(failing.asset()).resolves.toMatchObject({
      kind: "semantic",
      state: "failed",
    });

    await failing.close();
    await writeFile(sourcePath, source, "utf8");
    const reverted = thumbnailCache({
      cacheRoot,
      command: ["poietra-command-that-does-not-exist"],
      projectRoot,
    });
    await expect(reverted.status()).resolves.toMatchObject({
      cachedSourceHash: generated.sourceHash,
      imageKind: "rendered",
      state: "current",
    });
  });

  it("rejects invalid PNG output, bounds failures, and stops an in-flight job during close", async () => {
    const { cacheRoot, projectRoot } = await fixture();
    const invalid = thumbnailCache({
      cacheRoot,
      command: [process.execPath, fakeRenderer, "--invalid-png"],
      projectRoot,
    });
    await invalid.generate(async () => true);
    await expect(waitForStatus(invalid, "failed")).resolves.toMatchObject({
      imageKind: "semantic",
      state: "failed",
    });
    expect((await invalid.status()).error).toMatch(/not a PNG/i);
    await invalid.close();

    const unavailableCacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
    temporaryRoots.push(unavailableCacheRoot);
    const unavailable = thumbnailCache({
      cacheRoot: unavailableCacheRoot,
      command: ["x".repeat(1_000)],
      projectRoot,
    });
    await expect(unavailable.generate(async () => false)).rejects.toMatchObject({ status: 503 });
    expect((await unavailable.status()).error?.length).toBeLessThanOrEqual(500);
    await unavailable.close();

    const slowCacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
    temporaryRoots.push(slowCacheRoot);
    const slow = thumbnailCache({
      cacheRoot: slowCacheRoot,
      command: [process.execPath, fakeRenderer, "--slow-render"],
      projectRoot,
    });
    await slow.generate(async () => true);
    const startedAt = Date.now();
    await slow.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(slow.status()).resolves.toMatchObject({ error: null, state: "missing" });
  });
});

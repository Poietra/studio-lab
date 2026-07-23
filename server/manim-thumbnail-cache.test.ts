import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findRenderedImage } from "./manim-render-process";
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
    const argvMarker = join(projectRoot, "thumbnail-argv.json");
    const instance = thumbnailCache({
      cacheRoot,
      command: [
        process.execPath,
        fakeRenderer,
        "--render-start-marker",
        renderMarker,
        "--argv-marker",
        argvMarker,
      ],
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
    const renderArguments = JSON.parse(await readFile(argvMarker, "utf8")) as string[];
    expect(renderArguments.slice(renderArguments.indexOf("--output_file"), renderArguments.indexOf("--output_file") + 2))
      .toEqual(["--output_file", "poietra-thumbnail"]);
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
    expect(() => slow.status()).toThrow(/shutting down/i);
    const afterClose = thumbnailCache({
      cacheRoot: slowCacheRoot,
      command: ["poietra-command-that-does-not-exist"],
      projectRoot,
    });
    await expect(afterClose.status()).resolves.toMatchObject({ error: null, state: "missing" });
  });

  it("uses one preparation/render flight and prevents a late spawn during shutdown", async () => {
    const { cacheRoot, projectRoot } = await fixture();
    const renderCount = join(projectRoot, "render-count");
    let releaseAvailability!: (available: boolean) => void;
    const availability = new Promise<boolean>((resolveAvailability) => {
      releaseAvailability = resolveAvailability;
    });
    const commandAvailable = vi.fn(() => availability);
    const instance = thumbnailCache({
      cacheRoot,
      command: [process.execPath, fakeRenderer, "--render-count-marker", renderCount],
      projectRoot,
    });

    const starts = Array.from({ length: 16 }, () => instance.generate(commandAvailable));
    releaseAvailability(true);
    await expect(Promise.all(starts)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "generating" }),
    ]));
    await waitForStatus(instance, "current");
    expect(commandAvailable).toHaveBeenCalledOnce();
    expect((await readFile(renderCount, "utf8")).trim().split("\n")).toHaveLength(1);

    const secondCacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
    temporaryRoots.push(secondCacheRoot);
    let releaseSecondAvailability!: (available: boolean) => void;
    const secondAvailability = new Promise<boolean>((resolveAvailability) => {
      releaseSecondAvailability = resolveAvailability;
    });
    const lateMarker = join(projectRoot, "late-render");
    const closing = thumbnailCache({
      cacheRoot: secondCacheRoot,
      command: [process.execPath, fakeRenderer, "--render-start-marker", lateMarker],
      projectRoot,
    });
    const preparing = closing.generate(() => secondAvailability);
    const closed = closing.close();
    releaseSecondAvailability(true);
    await expect(preparing).rejects.toMatchObject({ status: 503 });
    await closed;
    await expect(access(lateMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finds only the fixed output name, not Manim version-suffixed Scene output", async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-media-"));
    temporaryRoots.push(mediaRoot);
    const images = join(mediaRoot, "images", "fake");
    await mkdir(images, { recursive: true });
    await writeFile(join(images, "ThumbnailScene_ManimCE_v0.20.1.png"), "suffix", "utf8");
    await expect(findRenderedImage(mediaRoot, "poietra-thumbnail.png")).resolves.toBeNull();
    const fixed = join(images, "poietra-thumbnail.png");
    await writeFile(fixed, "fixed", "utf8");
    await expect(findRenderedImage(mediaRoot, "poietra-thumbnail.png")).resolves.toBe(fixed);
  });

  it("reports same-source refresh failure while serving the last rendered frame", async () => {
    const { cacheRoot, projectRoot } = await fixture();
    const successful = thumbnailCache({ cacheRoot, projectRoot });
    await successful.generate(async () => true);
    await waitForStatus(successful, "current");
    await successful.close();

    const failing = thumbnailCache({
      cacheRoot,
      command: [process.execPath, fakeRenderer, "--fail-render"],
      projectRoot,
    });
    await expect(failing.status()).resolves.toMatchObject({ imageKind: "rendered", state: "current" });
    await failing.generate(async () => true);
    await expect(waitForStatus(failing, "failed")).resolves.toMatchObject({
      imageKind: "rendered",
      state: "failed",
    });
    await expect(failing.asset()).resolves.toMatchObject({ kind: "rendered", state: "failed" });
  });

  it("cleans orphan/temp files and rejects unsafe manifests without following links", async () => {
    const { cacheRoot, projectRoot } = await fixture();
    const directory = join(cacheRoot, "default");
    await mkdir(directory);
    const orphan = `${"a".repeat(64)}-${"b".repeat(16)}.png`;
    await Promise.all([
      writeFile(join(directory, orphan), "orphan", "utf8"),
      writeFile(join(directory, ".manifest-deadbeef.tmp"), "temporary", "utf8"),
    ]);
    const externalManifest = join(projectRoot, "external-manifest.json");
    await writeFile(externalManifest, JSON.stringify({ entries: [], lastAttempt: null, version: 1 }), "utf8");
    await symlink(externalManifest, join(directory, "manifest.json"));
    const instance = thumbnailCache({ cacheRoot, projectRoot });

    await expect(instance.status()).resolves.toMatchObject({ state: "missing" });
    await expect(access(join(directory, orphan))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, ".manifest-deadbeef.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(externalManifest, "utf8")).toContain('"entries"');

    await instance.close();
    await rm(join(directory, "manifest.json"), { force: true });
    await writeFile(join(directory, "manifest.json"), "x".repeat(65 * 1024), "utf8");
    const oversized = thumbnailCache({ cacheRoot, projectRoot });
    await expect(oversized.status()).resolves.toMatchObject({ state: "missing" });
  });

  it("publishes the new manifest before best-effort garbage collection", async () => {
    const { cacheRoot, projectRoot, source } = await fixture();
    const directory = join(cacheRoot, "default");
    await mkdir(directory);
    const entries = Array.from({ length: 8 }, (_, index) => ({
      fileName: `${String(index + 1).repeat(64).slice(0, 64)}-${String(index + 1).repeat(16).slice(0, 16)}.png`,
      generatedAt: `2026-07-23T10:00:0${index}.000Z`,
      sceneName: "ThumbnailScene",
      sourceHash: String(index + 1).repeat(64).slice(0, 64),
      sourcePath: "scene.py",
    }));
    await Promise.all(entries.slice(0, -1).map((entry) => writeFile(join(directory, entry.fileName), "old", "utf8")));
    await mkdir(join(directory, entries.at(-1)!.fileName));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      entries,
      lastAttempt: null,
      version: 1,
    }), "utf8");
    const instance = thumbnailCache({ cacheRoot, projectRoot });

    await instance.generate(async () => true);
    await waitForStatus(instance, "current");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
      entries: { fileName: string; sourceHash: string }[];
    };
    expect(manifest.entries).toHaveLength(8);
    expect(manifest.entries[0]?.sourceHash).toBe(createHash("sha256").update(source).digest("hex"));
    expect(manifest.entries.some((entry) => entry.fileName === entries.at(-1)!.fileName)).toBe(false);
    await expect(access(join(directory, entries.at(-1)!.fileName))).resolves.toBeUndefined();
  });

  it("fails closed when cache IDs, child links, or parent links could escape deletion", async () => {
    const { cacheRoot, projectRoot } = await fixture();
    expect(() => new ManimThumbnailCache({
      cacheRoot,
      command: [process.execPath, fakeRenderer],
      frame,
      projectId: "../outside",
      projectRoot,
      renderTimeoutMs: 5_000,
    })).toThrow(/project ID/i);

    const external = await mkdtemp(join(tmpdir(), "poietra-thumbnail-external-"));
    temporaryRoots.push(external);
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "alive", "utf8");
    await symlink(external, join(cacheRoot, "default"), "dir");
    const childLink = thumbnailCache({ cacheRoot, projectRoot });
    await expect(childLink.remove()).rejects.toThrow(/outside|child directory|canonical/i);
    expect(await readFile(sentinel, "utf8")).toBe("alive");

    await rm(join(cacheRoot, "default"), { force: true });
    const parentLinkedRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
    const replacementRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-replacement-"));
    const displacedRoot = `${parentLinkedRoot}-displaced`;
    temporaryRoots.push(parentLinkedRoot, replacementRoot, displacedRoot);
    const parentLink = thumbnailCache({ cacheRoot: parentLinkedRoot, projectRoot });
    await parentLink.status();
    await mkdir(join(replacementRoot, "default"));
    const replacementSentinel = join(replacementRoot, "default", "sentinel.txt");
    await writeFile(replacementSentinel, "alive", "utf8");
    await rename(parentLinkedRoot, displacedRoot);
    await symlink(replacementRoot, parentLinkedRoot, "dir");
    await expect(parentLink.remove()).rejects.toThrow(/canonical root/i);
    expect(await readFile(replacementSentinel, "utf8")).toBe("alive");
  });

  it("distinguishes a Scene-free workspace from a missing project root", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-empty-"));
    const emptyCacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
    temporaryRoots.push(emptyRoot, emptyCacheRoot);
    const empty = thumbnailCache({ cacheRoot: emptyCacheRoot, projectRoot: emptyRoot });
    await expect(empty.status()).resolves.toMatchObject({
      error: null,
      imageKind: "empty",
      state: "missing",
    });

    const missingRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-missing-"));
    const missingCacheRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-cache-"));
    temporaryRoots.push(missingRoot, missingCacheRoot);
    await rm(missingRoot, { recursive: true });
    const missing = thumbnailCache({ cacheRoot: missingCacheRoot, projectRoot: missingRoot });
    await expect(missing.status()).resolves.toMatchObject({
      imageKind: "empty",
      state: "unavailable",
    });
    expect((await missing.status()).error).toMatch(/ENOENT|no such file/i);
    await expect(missing.asset()).resolves.toMatchObject({ state: "unavailable", status: 404 });
    await expect(missing.generate(async () => true)).rejects.toMatchObject({ status: 503 });
  });
});

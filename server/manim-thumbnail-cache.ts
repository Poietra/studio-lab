import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import type { ManimThumbnailStatus } from "../src/render-pipeline/contracts";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import {
  appendRenderLog,
  findRenderedImage,
  stopRenderProcess,
  waitForRenderExit,
  waitForRenderProcessStop,
} from "./manim-render-process";
import { renderManimSceneThumbnailSvg } from "./manim-thumbnail";
import {
  discoverManimThumbnailTarget,
  type ManimThumbnailTarget,
} from "./manim-workspace";

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
const TARGET_CACHE_TTL_MS = 1_000;
const CACHE_FILE_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{16}\.png$/;

const cacheEntrySchema = z.object({
  fileName: z.string().regex(CACHE_FILE_PATTERN),
  generatedAt: z.string().datetime(),
  sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourcePath: z.string().min(1).max(500),
}).strict();

const attemptSchema = z.object({
  error: z.string().max(MAX_ERROR_LENGTH).nullable(),
  finishedAt: z.string().datetime(),
  sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourcePath: z.string().min(1).max(500),
}).strict();

const cacheManifestSchema = z.object({
  entries: z.array(cacheEntrySchema).max(MAX_CACHE_ENTRIES),
  lastAttempt: attemptSchema.nullable(),
  version: z.literal(CACHE_VERSION),
}).strict();

type CacheEntry = z.infer<typeof cacheEntrySchema>;
type CacheManifest = z.infer<typeof cacheManifestSchema>;

type ThumbnailAsset = Readonly<{
  body: Buffer;
  kind: "empty" | "rendered" | "semantic";
  mediaType: "image/png" | "image/svg+xml; charset=utf-8";
  state: ManimThumbnailStatus["state"];
  status: 200 | 404;
}>;

type ThumbnailProcessProgress = {
  logTail: string;
  progress: number;
  updatedAt: string;
};

type ThumbnailGeneration = {
  child: ChildProcess | null;
  key: string;
  promise: Promise<void>;
  target: ManimThumbnailTarget;
};

const EMPTY_MANIFEST: CacheManifest = {
  entries: [],
  lastAttempt: null,
  version: CACHE_VERSION,
};

function targetKey(target: ManimThumbnailTarget) {
  return `${target.scene.sourceHash}\0${target.sourcePath}\0${target.scene.name}`;
}

function entryMatchesTarget(entry: CacheEntry, target: ManimThumbnailTarget) {
  return entry.sourceHash === target.scene.sourceHash
    && entry.sourcePath === target.sourcePath
    && entry.sceneName === target.scene.name;
}

function attemptMatchesTarget(attempt: CacheManifest["lastAttempt"], target: ManimThumbnailTarget) {
  return Boolean(attempt
    && attempt.sourceHash === target.scene.sourceHash
    && attempt.sourcePath === target.sourcePath
    && attempt.sceneName === target.scene.name);
}

function cacheFileName(target: ManimThumbnailTarget) {
  const identity = createHash("sha256")
    .update(targetKey(target))
    .digest("hex")
    .slice(0, 16);
  return `${target.scene.sourceHash}-${identity}.png`;
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : "Manim thumbnail generation failed.";
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_ERROR_LENGTH)
    || "Manim thumbnail generation failed.";
}

export class ManimThumbnailCache {
  private readonly cacheDirectory: string;
  private readonly command: readonly string[];
  private generation: ThumbnailGeneration | null = null;
  private manifest: CacheManifest | null = null;
  private manifestRequest: Promise<CacheManifest> | null = null;
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly logger: StructuredLogger;
  private readonly projectId: string;
  private readonly projectRoot: string;
  private readonly renderTimeoutMs: number;
  private targetCache: Readonly<{ checkedAt: number; target: ManimThumbnailTarget | null }> | null = null;
  private targetRequest: Promise<ManimThumbnailTarget | null> | null = null;

  constructor(options: Readonly<{
    cacheRoot: string;
    command: readonly string[];
    frame: Readonly<{ height: number; width: number }>;
    logger?: StructuredLogger;
    projectId: string;
    projectRoot: string;
    renderTimeoutMs: number;
  }>) {
    this.cacheDirectory = resolve(options.cacheRoot, options.projectId);
    this.command = options.command;
    this.frame = options.frame;
    this.logger = options.logger ?? nullLogger;
    this.projectId = options.projectId;
    this.projectRoot = options.projectRoot;
    this.renderTimeoutMs = options.renderTimeoutMs;
  }

  isBusy() {
    return this.generation !== null || this.targetRequest !== null;
  }

  isGenerating() {
    return this.generation !== null;
  }

  invalidateTarget() {
    this.targetCache = null;
  }

  private async loadManifest() {
    if (this.manifest) return this.manifest;
    this.manifestRequest ??= (async () => {
      await mkdir(this.cacheDirectory, { mode: 0o700, recursive: true });
      try {
        const parsed = cacheManifestSchema.safeParse(JSON.parse(
          await readFile(join(this.cacheDirectory, "manifest.json"), "utf8"),
        ));
        if (!parsed.success) {
          this.logger.warn("thumbnail.cache_manifest_invalid");
          return EMPTY_MANIFEST;
        }
        return parsed.data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn("thumbnail.cache_manifest_unreadable", { error });
        }
        return EMPTY_MANIFEST;
      }
    })();
    try {
      this.manifest = await this.manifestRequest;
      return this.manifest;
    } finally {
      this.manifestRequest = null;
    }
  }

  private async persistManifest(next: CacheManifest) {
    await mkdir(this.cacheDirectory, { mode: 0o700, recursive: true });
    const temporaryPath = join(this.cacheDirectory, `.manifest-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, join(this.cacheDirectory, "manifest.json"));
      this.manifest = next;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async target(now = Date.now()) {
    if (this.targetCache && now - this.targetCache.checkedAt < TARGET_CACHE_TTL_MS) {
      return this.targetCache.target;
    }
    this.targetRequest ??= (async () => {
      try {
        return await discoverManimThumbnailTarget(this.projectRoot, this.frame);
      } catch (error) {
        this.logger.warn("thumbnail.discovery_failed", { error });
        return null;
      }
    })();
    const request = this.targetRequest;
    try {
      const target = await request;
      if (this.targetRequest === request) this.targetCache = { checkedAt: Date.now(), target };
      return target;
    } finally {
      if (this.targetRequest === request) this.targetRequest = null;
    }
  }

  private async readableEntry(entry: CacheEntry) {
    try {
      const metadata = await lstat(join(this.cacheDirectory, entry.fileName));
      return metadata.isFile()
        && !metadata.isSymbolicLink()
        && metadata.size > 0
        && metadata.size <= MAX_IMAGE_BYTES;
    } catch {
      return false;
    }
  }

  private async currentEntry(manifest: CacheManifest, target: ManimThumbnailTarget) {
    const entry = manifest.entries.find((candidate) => entryMatchesTarget(candidate, target)) ?? null;
    return entry && await this.readableEntry(entry) ? entry : null;
  }

  private async firstReadableEntry(manifest: CacheManifest) {
    for (const entry of manifest.entries) {
      if (await this.readableEntry(entry)) return entry;
    }
    return null;
  }

  async status(): Promise<ManimThumbnailStatus> {
    const [manifest, target] = await Promise.all([this.loadManifest(), this.target()]);
    if (!target) {
      return {
        cachedSourceHash: (await this.firstReadableEntry(manifest))?.sourceHash ?? null,
        error: null,
        generatedAt: null,
        imageKind: "empty",
        projectId: this.projectId,
        sceneName: null,
        sourceHash: null,
        sourcePath: null,
        state: "missing",
      };
    }
    const currentEntry = await this.currentEntry(manifest, target);
    const generationMatches = this.generation?.key === targetKey(target);
    if (generationMatches) {
      return {
        cachedSourceHash: currentEntry?.sourceHash ?? null,
        error: null,
        generatedAt: currentEntry?.generatedAt ?? null,
        imageKind: currentEntry ? "rendered" : "semantic",
        projectId: this.projectId,
        sceneName: target.scene.name,
        sourceHash: target.scene.sourceHash,
        sourcePath: target.sourcePath,
        state: "generating",
      };
    }
    if (currentEntry) {
      return {
        cachedSourceHash: currentEntry.sourceHash,
        error: null,
        generatedAt: currentEntry.generatedAt,
        imageKind: "rendered",
        projectId: this.projectId,
        sceneName: target.scene.name,
        sourceHash: target.scene.sourceHash,
        sourcePath: target.sourcePath,
        state: "current",
      };
    }
    const priorEntry = await this.firstReadableEntry(manifest);
    const failed = attemptMatchesTarget(manifest.lastAttempt, target) && manifest.lastAttempt?.error;
    return {
      cachedSourceHash: priorEntry?.sourceHash ?? null,
      error: failed || null,
      generatedAt: priorEntry?.generatedAt ?? null,
      imageKind: "semantic",
      projectId: this.projectId,
      sceneName: target.scene.name,
      sourceHash: target.scene.sourceHash,
      sourcePath: target.sourcePath,
      state: failed ? "failed" : priorEntry ? "stale" : "missing",
    };
  }

  async asset(): Promise<ThumbnailAsset> {
    const [manifest, target] = await Promise.all([this.loadManifest(), this.target()]);
    if (!target) {
      return {
        body: Buffer.from("", "utf8"),
        kind: "empty",
        mediaType: "image/svg+xml; charset=utf-8",
        state: "missing",
        status: 404,
      };
    }
    const entry = await this.currentEntry(manifest, target);
    if (entry) {
      try {
        return {
          body: await readFile(join(this.cacheDirectory, entry.fileName)),
          kind: "rendered",
          mediaType: "image/png",
          state: this.generation?.key === targetKey(target) ? "generating" : "current",
          status: 200,
        };
      } catch (error) {
        this.logger.warn("thumbnail.cache_image_unreadable", { error });
      }
    }
    const priorEntry = await this.firstReadableEntry(manifest);
    const failed = attemptMatchesTarget(manifest.lastAttempt, target) && manifest.lastAttempt?.error;
    return {
      body: Buffer.from(renderManimSceneThumbnailSvg(target.scene.runtimeSceneState), "utf8"),
      kind: "semantic",
      mediaType: "image/svg+xml; charset=utf-8",
      state: this.generation?.key === targetKey(target)
        ? "generating"
        : failed
          ? "failed"
          : priorEntry
            ? "stale"
            : "missing",
      status: 200,
    };
  }

  async generate(commandAvailable: () => Promise<boolean>) {
    const target = await this.target();
    if (!target) throw new HttpError("No importable Manim Scene is available for a thumbnail.", 409);
    if (this.generation) {
      if (this.generation.key !== targetKey(target)) {
        throw new HttpError("A thumbnail for an earlier source snapshot is still rendering.", 409);
      }
      return this.status();
    }
    if (!await commandAvailable()) {
      await this.recordAttempt(target, `Manim command ${JSON.stringify(this.command)} is not available.`);
      throw new HttpError(
        `Manim command ${JSON.stringify(this.command)} is not available. Configure POIETRA_MANIM_COMMAND and restart Studio.`,
        503,
      );
    }
    const generation: ThumbnailGeneration = {
      child: null,
      key: targetKey(target),
      promise: Promise.resolve(),
      target,
    };
    this.generation = generation;
    generation.promise = this.render(generation)
      .catch((error: unknown) => {
        this.logger.warn("thumbnail.render_failed", { error });
      })
      .finally(() => {
        if (this.generation === generation) this.generation = null;
      });
    return this.status();
  }

  private async recordAttempt(target: ManimThumbnailTarget, error: string | null) {
    const manifest = await this.loadManifest();
    await this.persistManifest({
      ...manifest,
      lastAttempt: {
        error,
        finishedAt: new Date().toISOString(),
        sceneName: target.scene.name,
        sourceHash: target.scene.sourceHash,
        sourcePath: target.sourcePath,
      },
    });
  }

  private async render(generation: ThumbnailGeneration) {
    const target = generation.target;
    let temporaryRoot: string | null = null;
    const progress: ThumbnailProcessProgress = {
      logTail: "",
      progress: 0,
      updatedAt: new Date().toISOString(),
    };
    try {
      temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-manim-thumbnail-"));
      const sourcePath = join(temporaryRoot, basename(target.sourcePath));
      const mediaRoot = join(temporaryRoot, "media");
      await mkdir(mediaRoot, { recursive: true });
      await writeFile(sourcePath, target.source, { encoding: "utf8", mode: 0o600 });
      const [executable, ...prefix] = this.command;
      const child = spawn(executable, [
        ...prefix,
        "-ql",
        "-s",
        "--disable_caching",
        "--media_dir",
        mediaRoot,
        sourcePath,
        target.scene.name,
      ], {
        cwd: this.projectRoot,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          PYTHONPATH: [this.projectRoot, process.env.PYTHONPATH]
            .filter(Boolean)
            .join(process.platform === "win32" ? ";" : ":"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      generation.child = child;
      child.stdout?.on("data", (chunk: Buffer) => appendRenderLog(progress, chunk));
      child.stderr?.on("data", (chunk: Buffer) => appendRenderLog(progress, chunk));
      const exit = await waitForRenderExit(child, this.renderTimeoutMs);
      generation.child = null;
      if (exit.code !== 0) {
        throw new Error(`Manim exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}.`);
      }
      const renderedImage = await findRenderedImage(mediaRoot, target.scene.name);
      if (!renderedImage) throw new Error("Manim completed without producing a PNG thumbnail.");
      const metadata = await lstat(renderedImage);
      if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size <= 0
        || metadata.size > MAX_IMAGE_BYTES
      ) {
        throw new Error("Manim produced an invalid or oversized PNG thumbnail.");
      }
      await this.storeImage(target, await readFile(renderedImage));
      await this.recordAttempt(target, null);
    } catch (error) {
      generation.child = null;
      await this.recordAttempt(target, boundedError(error));
      throw error;
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
    }
  }

  private async storeImage(target: ManimThumbnailTarget, image: Buffer) {
    const manifest = await this.loadManifest();
    await mkdir(this.cacheDirectory, { mode: 0o700, recursive: true });
    const fileName = cacheFileName(target);
    const temporaryPath = join(this.cacheDirectory, `.thumbnail-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, image, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, join(this.cacheDirectory, fileName));
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const entry: CacheEntry = {
      fileName,
      generatedAt: new Date().toISOString(),
      sceneName: target.scene.name,
      sourceHash: target.scene.sourceHash,
      sourcePath: target.sourcePath,
    };
    const entries = [entry, ...manifest.entries.filter((candidate) => candidate.fileName !== fileName)]
      .slice(0, MAX_CACHE_ENTRIES);
    const retainedFiles = new Set(entries.map((candidate) => candidate.fileName));
    await Promise.all(manifest.entries
      .filter((candidate) => !retainedFiles.has(candidate.fileName))
      .map((candidate) => rm(join(this.cacheDirectory, candidate.fileName), { force: true })));
    await this.persistManifest({ ...manifest, entries });
  }

  async close() {
    const generation = this.generation;
    if (!generation) return;
    stopRenderProcess(generation.child);
    await waitForRenderProcessStop(generation.child);
    await generation.promise;
  }

  async remove() {
    await this.close();
    await rm(this.cacheDirectory, { force: true, recursive: true });
  }
}

export type { ThumbnailAsset };

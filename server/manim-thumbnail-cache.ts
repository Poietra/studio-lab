import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  MANIM_PROJECT_ID_PATTERN,
  type ManimThumbnailStatus,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/contracts";
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
import { discoverManimThumbnailTarget, type ManimThumbnailTarget } from "./manim-workspace";

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 500;
const TARGET_CACHE_TTL_MS = 1_000;
const THUMBNAIL_OUTPUT_STEM = "poietra-thumbnail";
const THUMBNAIL_OUTPUT_FILE = `${THUMBNAIL_OUTPUT_STEM}.png`;
const PUBLIC_COMMAND_UNAVAILABLE_ERROR = [
  "The Manim renderer is unavailable.",
  "Check the Studio server logs for configuration details.",
].join(" ");
const PUBLIC_DISCOVERY_ERROR = [
  "The workspace could not be inspected for a preview.",
  "Check the Studio server logs for details.",
].join(" ");
const PUBLIC_RENDER_ERROR = [
  "The rendered preview could not be generated.",
  "Check the Studio server logs for details.",
].join(" ");
const CACHE_FILE_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{16}\.png$/;
const TEMP_FILE_PATTERN = /^\.(?:manifest|thumbnail)-[0-9a-f-]+\.tmp$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const cacheEntrySchema = z
  .object({
    fileName: z.string().regex(CACHE_FILE_PATTERN),
    generatedAt: z.string().datetime(),
    sceneName: manimSceneNameSchema,
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourcePath: manimSourcePathSchema,
  })
  .strict();

const attemptSchema = z
  .object({
    error: z.string().max(MAX_ERROR_LENGTH).nullable(),
    finishedAt: z.string().datetime(),
    sceneName: manimSceneNameSchema,
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourcePath: manimSourcePathSchema,
  })
  .strict();

const cacheManifestSchema = z
  .object({
    entries: z.array(cacheEntrySchema).max(MAX_CACHE_ENTRIES),
    lastAttempt: attemptSchema.nullable(),
    version: z.literal(CACHE_VERSION),
  })
  .strict();

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
  aborted: boolean;
  child: ChildProcess | null;
  key: string;
  promise: Promise<void>;
  target: ManimThumbnailTarget;
};

type ThumbnailDiscovery =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ error: string; kind: "unavailable" }>
  | Readonly<{ kind: "target"; target: ManimThumbnailTarget }>;

const EMPTY_MANIFEST: CacheManifest = {
  entries: [],
  lastAttempt: null,
  version: CACHE_VERSION,
};

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isSameFileVersion(first: BigIntStats, second: BigIntStats) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function pathIsInside(parent: string, candidate: string) {
  const fromParent = relative(parent, candidate);
  return fromParent.length > 0 && fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function targetKey(target: ManimThumbnailTarget) {
  return `${target.scene.sourceHash}\0${target.sourcePath}\0${target.scene.name}`;
}

function entryMatchesTarget(entry: CacheEntry, target: ManimThumbnailTarget) {
  return (
    entry.sourceHash === target.scene.sourceHash &&
    entry.sourcePath === target.sourcePath &&
    entry.sceneName === target.scene.name
  );
}

function attemptMatchesTarget(attempt: CacheManifest["lastAttempt"], target: ManimThumbnailTarget) {
  return Boolean(
    attempt &&
      attempt.sourceHash === target.scene.sourceHash &&
      attempt.sourcePath === target.sourcePath &&
      attempt.sceneName === target.scene.name,
  );
}

function cacheFileName(target: ManimThumbnailTarget) {
  const identity = createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 16);
  return `${target.scene.sourceHash}-${identity}.png`;
}

async function readStablePrivateFile(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0 || before.size > BigInt(maxBytes)) return null;
    const body = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!isSameFileVersion(before, after) || body.byteLength > maxBytes) return null;
    return body;
  } finally {
    await handle.close();
  }
}

export class ManimThumbnailCache {
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly cacheDirectory: string;
  private readonly cacheRoot: string;
  private cacheRootRequest: Promise<string> | null = null;
  private closeRequest: Promise<void> | null = null;
  private closing = false;
  private readonly command: readonly string[];
  private generation: ThumbnailGeneration | null = null;
  private generationRequest: Promise<ManimThumbnailStatus> | null = null;
  private manifest: CacheManifest | null = null;
  private manifestRequest: Promise<CacheManifest> | null = null;
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly logger: StructuredLogger;
  private readonly projectId: string;
  private readonly projectRoot: string;
  private readonly renderTimeoutMs: number;
  private runtimeFailedAttempt: CacheManifest["lastAttempt"] = null;
  private targetCache: Readonly<{ checkedAt: number; discovery: ThumbnailDiscovery }> | null = null;
  private targetRequest: Promise<ThumbnailDiscovery> | null = null;

  constructor(
    options: Readonly<{
      cacheRoot: string;
      command: readonly string[];
      frame: Readonly<{ height: number; width: number }>;
      logger?: StructuredLogger;
      projectId: string;
      projectRoot: string;
      renderTimeoutMs: number;
    }>,
  ) {
    if (!MANIM_PROJECT_ID_PATTERN.test(options.projectId)) {
      throw new TypeError("Manim thumbnail project ID must be an opaque lower-case identifier.");
    }
    this.cacheRoot = resolve(options.cacheRoot);
    this.cacheDirectory = join(this.cacheRoot, options.projectId);
    if (!pathIsInside(this.cacheRoot, this.cacheDirectory)) {
      throw new TypeError("The thumbnail cache directory must be inside its cache root.");
    }
    this.command = Object.freeze([...options.command]);
    this.frame = options.frame;
    this.logger = options.logger ?? nullLogger;
    this.projectId = options.projectId;
    this.projectRoot = resolve(options.projectRoot);
    this.renderTimeoutMs = options.renderTimeoutMs;
  }

  private assertOpen() {
    if (this.closing) throw new HttpError("The thumbnail cache is shutting down.", 503);
  }

  private trackOperation<T>(operation: () => Promise<T>) {
    this.assertOpen();
    const request = Promise.resolve().then(operation);
    this.activeOperations.add(request);
    void request.finally(() => this.activeOperations.delete(request)).catch(() => undefined);
    return request;
  }

  isBusy() {
    return (
      this.activeOperations.size > 0 ||
      this.generationRequest !== null ||
      this.generation !== null ||
      this.targetRequest !== null ||
      this.manifestRequest !== null
    );
  }

  isGenerating() {
    return this.generation !== null;
  }

  async waitForIdle() {
    while (this.activeOperations.size > 0 || this.generation) {
      const pending = new Set(this.activeOperations);
      if (this.generation) pending.add(this.generation.promise);
      await Promise.allSettled(pending);
    }
  }

  invalidateTarget() {
    this.targetCache = null;
  }

  private canonicalCacheRoot() {
    this.cacheRootRequest ??= (async () => {
      await mkdir(this.cacheRoot, { mode: 0o700, recursive: true });
      const [metadata, canonicalRoot] = await Promise.all([lstat(this.cacheRoot), realpath(this.cacheRoot)]);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonicalRoot !== this.cacheRoot) {
        throw new TypeError("The thumbnail cache root must be a real private directory.");
      }
      return canonicalRoot;
    })();
    const request = this.cacheRootRequest;
    return request.finally(() => {
      if (this.cacheRootRequest === request) this.cacheRootRequest = null;
    });
  }

  private async ensureCacheDirectory() {
    const canonicalRoot = await this.canonicalCacheRoot();
    const expectedDirectory = join(canonicalRoot, this.projectId);
    await mkdir(this.cacheDirectory, { mode: 0o700, recursive: true });
    const [metadata, canonicalDirectory] = await Promise.all([
      lstat(this.cacheDirectory),
      realpath(this.cacheDirectory),
    ]);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      canonicalDirectory !== expectedDirectory ||
      !pathIsInside(canonicalRoot, canonicalDirectory)
    ) {
      throw new TypeError("The thumbnail cache must be a real private child directory.");
    }
    return canonicalDirectory;
  }

  private async cleanupCacheDirectory(directory: string, manifest: CacheManifest) {
    const retainedFiles = new Set(manifest.entries.map((entry) => entry.fileName));
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const isTemporary = TEMP_FILE_PATTERN.test(entry.name);
          const isOrphan = CACHE_FILE_PATTERN.test(entry.name) && !retainedFiles.has(entry.name);
          if ((!isTemporary && !isOrphan) || entry.isDirectory()) return;
          await rm(join(directory, entry.name), { force: true });
        }),
      );
    } catch (error) {
      this.logger.warn("thumbnail.cache_cleanup_failed", { error });
    }
  }

  private async loadManifest() {
    if (this.manifest) return this.manifest;
    this.manifestRequest ??= (async () => {
      const directory = await this.ensureCacheDirectory();
      let manifest = EMPTY_MANIFEST;
      try {
        const body = await readStablePrivateFile(join(directory, "manifest.json"), MAX_MANIFEST_BYTES);
        if (!body) {
          this.logger.warn("thumbnail.cache_manifest_invalid");
        } else {
          const parsed = cacheManifestSchema.safeParse(JSON.parse(body.toString("utf8")));
          if (parsed.success) manifest = parsed.data;
          else this.logger.warn("thumbnail.cache_manifest_invalid");
        }
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) {
          this.logger.warn("thumbnail.cache_manifest_unreadable", { error });
        }
      }
      await this.cleanupCacheDirectory(directory, manifest);
      return manifest;
    })();
    const request = this.manifestRequest;
    try {
      this.manifest = await request;
      return this.manifest;
    } finally {
      if (this.manifestRequest === request) this.manifestRequest = null;
    }
  }

  private async persistManifest(next: CacheManifest) {
    const parsed = cacheManifestSchema.safeParse(next);
    if (!parsed.success) throw new TypeError("The thumbnail cache manifest violates its schema.");
    const payload = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
    if (payload.byteLength > MAX_MANIFEST_BYTES) throw new TypeError("The thumbnail cache manifest is too large.");
    const directory = await this.ensureCacheDirectory();
    const temporaryPath = join(directory, `.manifest-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, payload, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, join(directory, "manifest.json"));
      this.manifest = parsed.data;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async discover(now = Date.now()) {
    if (this.targetCache && now - this.targetCache.checkedAt < TARGET_CACHE_TTL_MS) {
      return this.targetCache.discovery;
    }
    this.targetRequest ??= (async (): Promise<ThumbnailDiscovery> => {
      try {
        const target = await discoverManimThumbnailTarget(this.projectRoot, this.frame);
        return target ? { kind: "target", target } : { kind: "empty" };
      } catch (error) {
        this.logger.warn("thumbnail.discovery_failed", { error });
        return { error: PUBLIC_DISCOVERY_ERROR, kind: "unavailable" };
      }
    })();
    const request = this.targetRequest;
    try {
      const discovery = await request;
      if (this.targetRequest === request) this.targetCache = { checkedAt: Date.now(), discovery };
      return discovery;
    } finally {
      if (this.targetRequest === request) this.targetRequest = null;
    }
  }

  private async readableEntry(entry: CacheEntry) {
    try {
      const handle = await open(
        join(this.cacheDirectory, entry.fileName),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size < PNG_SIGNATURE.length || metadata.size > MAX_IMAGE_BYTES) {
          return false;
        }
        const signature = Buffer.alloc(PNG_SIGNATURE.length);
        const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
        return bytesRead === signature.length && signature.equals(PNG_SIGNATURE);
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  private async readEntry(entry: CacheEntry) {
    try {
      const body = await readStablePrivateFile(join(this.cacheDirectory, entry.fileName), MAX_IMAGE_BYTES);
      if (
        !body ||
        body.length < PNG_SIGNATURE.length ||
        !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ) {
        return null;
      }
      return body;
    } catch {
      return null;
    }
  }

  private async currentEntry(manifest: CacheManifest, target: ManimThumbnailTarget) {
    const entry = manifest.entries.find((candidate) => entryMatchesTarget(candidate, target)) ?? null;
    return entry && (await this.readableEntry(entry)) ? entry : null;
  }

  private async firstReadableEntry(manifest: CacheManifest) {
    for (const entry of manifest.entries) {
      if (await this.readableEntry(entry)) return entry;
    }
    return null;
  }

  private cachedFields(entry: CacheEntry | null) {
    return {
      cachedSourceHash: entry?.sourceHash ?? null,
      generatedAt: entry?.generatedAt ?? null,
    };
  }

  private async readStatus(): Promise<ManimThumbnailStatus> {
    const [manifest, discovery] = await Promise.all([this.loadManifest(), this.discover()]);
    const priorEntry = await this.firstReadableEntry(manifest);
    if (discovery.kind === "unavailable") {
      return {
        ...this.cachedFields(priorEntry),
        error: discovery.error,
        imageKind: "empty",
        projectId: this.projectId,
        sceneName: null,
        sourceHash: null,
        sourcePath: null,
        state: "unavailable",
      };
    }
    if (discovery.kind === "empty") {
      return {
        ...this.cachedFields(priorEntry),
        error: null,
        imageKind: "empty",
        projectId: this.projectId,
        sceneName: null,
        sourceHash: null,
        sourcePath: null,
        state: "missing",
      };
    }
    const target = discovery.target;
    const currentEntry = await this.currentEntry(manifest, target);
    const generationMatches = this.generation?.key === targetKey(target);
    const lastAttempt = this.runtimeFailedAttempt ?? manifest.lastAttempt;
    const failed = attemptMatchesTarget(lastAttempt, target) && lastAttempt?.error;
    const cachedEntry = currentEntry ?? priorEntry;
    const targetFields = {
      projectId: this.projectId,
      sceneName: target.scene.name,
      sourceHash: target.scene.sourceHash,
      sourcePath: target.sourcePath,
    };
    if (generationMatches) {
      return {
        ...this.cachedFields(cachedEntry),
        ...targetFields,
        error: null,
        imageKind: currentEntry ? "rendered" : "semantic",
        state: "generating",
      };
    }
    if (failed) {
      return {
        ...this.cachedFields(cachedEntry),
        ...targetFields,
        error: failed,
        imageKind: currentEntry ? "rendered" : "semantic",
        state: "failed",
      };
    }
    if (currentEntry) {
      return {
        ...this.cachedFields(currentEntry),
        ...targetFields,
        error: null,
        imageKind: "rendered",
        state: "current",
      };
    }
    return {
      ...this.cachedFields(priorEntry),
      ...targetFields,
      error: null,
      imageKind: "semantic",
      state: priorEntry ? "stale" : "missing",
    };
  }

  status() {
    return this.trackOperation(() => this.readStatus());
  }

  private emptyAsset(state: "missing" | "unavailable"): ThumbnailAsset {
    return {
      body: Buffer.from("", "utf8"),
      kind: "empty",
      mediaType: "image/svg+xml; charset=utf-8",
      state,
      status: 404,
    };
  }

  private async readAsset(): Promise<ThumbnailAsset> {
    const [manifest, discovery] = await Promise.all([this.loadManifest(), this.discover()]);
    if (discovery.kind === "unavailable") return this.emptyAsset("unavailable");
    if (discovery.kind === "empty") return this.emptyAsset("missing");
    const target = discovery.target;
    const entry = await this.currentEntry(manifest, target);
    const lastAttempt = this.runtimeFailedAttempt ?? manifest.lastAttempt;
    const failed = attemptMatchesTarget(lastAttempt, target) && lastAttempt?.error;
    if (entry) {
      const body = await this.readEntry(entry);
      if (body) {
        return {
          body,
          kind: "rendered",
          mediaType: "image/png",
          state: this.generation?.key === targetKey(target) ? "generating" : failed ? "failed" : "current",
          status: 200,
        };
      }
      this.logger.warn("thumbnail.cache_image_unreadable");
    }
    const priorEntry = await this.firstReadableEntry(manifest);
    return {
      body: Buffer.from(renderManimSceneThumbnailSvg(target.scene.runtimeSceneState), "utf8"),
      kind: "semantic",
      mediaType: "image/svg+xml; charset=utf-8",
      state:
        this.generation?.key === targetKey(target)
          ? "generating"
          : failed
            ? "failed"
            : priorEntry
              ? "stale"
              : "missing",
      status: 200,
    };
  }

  asset() {
    return this.trackOperation(() => this.readAsset());
  }

  generate(commandAvailable: () => Promise<boolean>) {
    this.assertOpen();
    if (this.generationRequest) return this.generationRequest;
    const request = this.trackOperation(() => this.prepareGeneration(commandAvailable));
    this.generationRequest = request;
    void request
      .finally(() => {
        if (this.generationRequest === request) this.generationRequest = null;
      })
      .catch(() => undefined);
    return request;
  }

  private async prepareGeneration(commandAvailable: () => Promise<boolean>) {
    const discovery = await this.discover();
    this.assertOpen();
    if (discovery.kind === "empty") {
      throw new HttpError("No importable Manim Scene is available for a thumbnail.", 409);
    }
    if (discovery.kind === "unavailable") {
      throw new HttpError(`The Manim workspace is unavailable: ${discovery.error}`, 503);
    }
    const target = discovery.target;
    if (this.generation) {
      if (this.generation.key !== targetKey(target)) {
        throw new HttpError("A thumbnail for an earlier source snapshot is still rendering.", 409);
      }
      return this.readStatus();
    }
    if (!(await commandAvailable())) {
      this.assertOpen();
      this.logger.warn("thumbnail.command_unavailable");
      await this.recordAttempt(target, PUBLIC_COMMAND_UNAVAILABLE_ERROR);
      throw new HttpError(PUBLIC_COMMAND_UNAVAILABLE_ERROR, 503);
    }
    this.assertOpen();
    const generation: ThumbnailGeneration = {
      aborted: false,
      child: null,
      key: targetKey(target),
      promise: Promise.resolve(),
      target,
    };
    this.generation = generation;
    const rendering = this.trackOperation(() => this.render(generation));
    generation.promise = rendering
      .catch((error: unknown) => {
        if (!generation.aborted) this.logger.warn("thumbnail.render_failed", { error });
      })
      .finally(() => {
        if (this.generation === generation) this.generation = null;
      });
    return this.readStatus();
  }

  private async recordAttempt(target: ManimThumbnailTarget, error: string) {
    const attempt: NonNullable<CacheManifest["lastAttempt"]> = {
      error,
      finishedAt: new Date().toISOString(),
      sceneName: target.scene.name,
      sourceHash: target.scene.sourceHash,
      sourcePath: target.sourcePath,
    };
    this.runtimeFailedAttempt = attempt;
    try {
      const manifest = await this.loadManifest();
      await this.persistManifest({ ...manifest, lastAttempt: attempt });
    } catch (persistError) {
      this.logger.warn("thumbnail.failure_manifest_persist_failed", { error: persistError });
    }
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
      if (generation.aborted || this.closing) throw new Error("Thumbnail generation was cancelled.");
      const [executable, ...prefix] = this.command;
      const child = spawn(
        executable,
        [
          ...prefix,
          "-ql",
          "-s",
          "--disable_caching",
          "--output_file",
          THUMBNAIL_OUTPUT_STEM,
          "--media_dir",
          mediaRoot,
          sourcePath,
          target.scene.name,
        ],
        {
          cwd: this.projectRoot,
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            PYTHONPATH: [this.projectRoot, process.env.PYTHONPATH]
              .filter(Boolean)
              .join(process.platform === "win32" ? ";" : ":"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      generation.child = child;
      if (generation.aborted || this.closing) stopRenderProcess(child);
      child.stdout?.on("data", (chunk: Buffer) => appendRenderLog(progress, chunk));
      child.stderr?.on("data", (chunk: Buffer) => appendRenderLog(progress, chunk));
      const exit = await waitForRenderExit(child, this.renderTimeoutMs);
      generation.child = null;
      if (exit.code !== 0) {
        throw new Error(
          `Manim exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}.`,
        );
      }
      const renderedImage = await findRenderedImage(mediaRoot, THUMBNAIL_OUTPUT_FILE);
      if (!renderedImage) throw new Error(`Manim completed without producing ${THUMBNAIL_OUTPUT_FILE}.`);
      const image = await readStablePrivateFile(renderedImage, MAX_IMAGE_BYTES);
      if (
        !image ||
        image.length < PNG_SIGNATURE.length ||
        !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ) {
        throw new Error("Manim produced an invalid, oversized, or not a PNG thumbnail.");
      }
      await this.storeImage(target, image);
    } catch (error) {
      generation.child = null;
      if (!generation.aborted && !this.closing) await this.recordAttempt(target, PUBLIC_RENDER_ERROR);
      throw error;
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
    }
  }

  private async removeFilesBestEffort(fileNames: readonly string[]) {
    const results = await Promise.allSettled(
      fileNames.map((fileName) => rm(join(this.cacheDirectory, fileName), { force: true })),
    );
    if (results.some((result) => result.status === "rejected")) {
      this.logger.warn("thumbnail.cache_gc_failed");
    }
  }

  private async storeImage(target: ManimThumbnailTarget, image: Buffer) {
    const manifest = await this.loadManifest();
    const directory = await this.ensureCacheDirectory();
    const fileName = cacheFileName(target);
    const temporaryPath = join(directory, `.thumbnail-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, image, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, join(directory, fileName));
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
    const entries = [entry, ...manifest.entries.filter((candidate) => candidate.fileName !== fileName)].slice(
      0,
      MAX_CACHE_ENTRIES,
    );
    const retainedFiles = new Set(entries.map((candidate) => candidate.fileName));
    const obsoleteFiles = manifest.entries
      .filter((candidate) => !retainedFiles.has(candidate.fileName))
      .map((candidate) => candidate.fileName);
    await this.persistManifest({
      entries,
      lastAttempt: {
        error: null,
        finishedAt: entry.generatedAt,
        sceneName: entry.sceneName,
        sourceHash: entry.sourceHash,
        sourcePath: entry.sourcePath,
      },
      version: CACHE_VERSION,
    });
    this.runtimeFailedAttempt = null;
    await this.removeFilesBestEffort(obsoleteFiles);
  }

  private async drainOperations() {
    while (this.activeOperations.size > 0 || this.generation) {
      const generation = this.generation;
      if (generation) {
        generation.aborted = true;
        stopRenderProcess(generation.child);
      }
      const pending = new Set(this.activeOperations);
      if (generation) pending.add(generation.promise);
      await Promise.allSettled(pending);
      if (generation?.child) await waitForRenderProcessStop(generation.child);
    }
  }

  close() {
    if (!this.closeRequest) {
      this.closing = true;
      this.closeRequest = this.drainOperations();
    }
    return this.closeRequest;
  }

  private async existingCanonicalCacheRoot() {
    let metadata;
    try {
      metadata = await lstat(this.cacheRoot);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    }
    const canonicalRoot = await realpath(this.cacheRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonicalRoot !== this.cacheRoot) {
      throw new TypeError("Refusing to remove a thumbnail cache through a non-canonical root.");
    }
    return canonicalRoot;
  }

  private async removeCacheDirectory() {
    const canonicalRoot = await this.existingCanonicalCacheRoot();
    if (!canonicalRoot) return;
    const expectedDirectory = join(canonicalRoot, this.projectId);
    let metadata;
    try {
      metadata = await lstat(expectedDirectory);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    const canonicalDirectory = await realpath(expectedDirectory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      canonicalDirectory !== expectedDirectory ||
      !pathIsInside(canonicalRoot, canonicalDirectory)
    ) {
      throw new TypeError("Refusing to remove a thumbnail cache outside its canonical root.");
    }
    const quarantine = join(canonicalRoot, `.removing-${this.projectId}-${randomUUID()}`);
    await rename(expectedDirectory, quarantine);
    const [rootAfterRename, quarantineMetadata, canonicalQuarantine] = await Promise.all([
      realpath(this.cacheRoot),
      lstat(quarantine),
      realpath(quarantine),
    ]);
    if (
      rootAfterRename !== canonicalRoot ||
      !quarantineMetadata.isDirectory() ||
      quarantineMetadata.isSymbolicLink() ||
      canonicalQuarantine !== quarantine ||
      !pathIsInside(canonicalRoot, canonicalQuarantine)
    ) {
      throw new TypeError("Thumbnail cache quarantine validation failed; no recursive deletion was attempted.");
    }
    await rm(quarantine, { recursive: true });
  }

  async remove() {
    await this.close();
    await this.removeCacheDirectory();
  }
}

export type { ThumbnailAsset };

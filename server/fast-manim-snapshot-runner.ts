import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

import {
  assertFastManimSnapshotDiagnosticsSafeV1,
  digestFastManimSnapshotRuntimeConfigV1,
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_FALLBACK_V1,
  FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
  FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  FastManimSnapshotContractError,
  fastManimSnapshotProducerRequestV1Schema,
  type FastManimSnapshotProducerRequestV1,
  type FastManimSnapshotQueryV1,
  type FastManimSnapshotRunFailureCodeV1,
  fastManimSnapshotRunRequestV1Schema,
  type FastManimSnapshotRunRequestV1,
  fastManimSnapshotRunViewV1Schema,
  type FastManimSnapshotRunViewV1,
  fastManimSnapshotSceneIdV1,
  type FastManimSnapshotRuntimeCapabilityV1,
  type FastManimSnapshotRuntimeConfigV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
  type VerifiedFastManimSnapshotResultV1,
} from "./fast-manim-snapshot-contract";
import {
  type FastManimSnapshotAdmissionController,
  type FastManimSnapshotPublicationStore,
  processAdmissionController,
  processPublicationStore,
} from "./fast-manim-snapshot-publication";
import {
  abortError,
  defaultKillProcessGroup,
  type ProducerGroupKill,
  type ProducerProcessTimings,
  resolveProducerProcessTimings,
  superviseProducerProcess,
} from "./fast-manim-snapshot-producer-process";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import { ManimSourceStore, type ManimSourceReadHooks } from "./manim-source-store";

// Publication accounting and admission control live in
// ./fast-manim-snapshot-publication; the subprocess supervision state machine
// lives in ./fast-manim-snapshot-producer-process. Both are re-exported below
// so the public surface of this module is unchanged.
export {
  FastManimSnapshotAdmissionController,
  FastManimSnapshotPublicationStore,
} from "./fast-manim-snapshot-publication";
export type { ProducerGroupKill } from "./fast-manim-snapshot-producer-process";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 20_000;
const MAX_SNAPSHOT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONCURRENT_SNAPSHOT_RUNS = 2;
const DEFAULT_MAX_PUBLISHED_SNAPSHOTS = 16;
const DEFAULT_MAX_PUBLISHED_BYTES = 16 * 1024 * 1024;
const DEFAULT_PUBLISH_RETENTION_MS = 30 * 60_000;

const runtimeDirectoryCleanupError = () =>
  new HttpError("The Scene snapshot runtime directory could not be cleaned up.", 500);

/** Environment variables a producer may inherit from the server process. */
const PRODUCER_ENV_ALLOWLIST = ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "TZ", "VIRTUAL_ENV"] as const;

const FAILURE_MESSAGES: Readonly<Record<FastManimSnapshotRunFailureCodeV1, string>> = {
  "capability-unsupported": "The compiled Scene requires capabilities outside the server runtime allowlist.",
  "producer-exit": "The fast-manim snapshot producer exited without a usable result.",
  "producer-output-overflow": "The fast-manim snapshot producer exceeded the raw stdout/stderr byte budget.",
  "producer-spawn-failed": "The fast-manim snapshot producer could not be started.",
  "producer-timeout": "The fast-manim snapshot producer did not complete within its execution deadline.",
  "producer-unconfigured":
    "No fast-manim snapshot producer is configured; use the server-authoritative render pipeline.",
  "result-rejected": "The fast-manim snapshot result failed server verification.",
  "runtime-config-changed": "The server runtime capability configuration changed during the snapshot run.",
  "snapshot-too-large": "The verified snapshot exceeds the server publication byte budget.",
  "source-changed": "The Python source changed while the snapshot producer was running.",
  "source-correlation-stale": "The request source hash no longer matches the Python source on disk.",
};

function sceneKey(sourcePath: string, sceneName: string) {
  return `${sourcePath}\u0000${sceneName}`;
}

export class FastManimSnapshotRunner {
  private readonly activeChildren = new Map<ChildProcess, () => void>();
  private readonly activeKeys = new Set<string>();
  private readonly activeLookups = new Set<Promise<unknown>>();
  private readonly activeRuns = new Set<Promise<unknown>>();
  private readonly admissionController: FastManimSnapshotAdmissionController;
  private readonly capabilities: readonly FastManimSnapshotRuntimeCapabilityV1[];
  private cleanupFailed = false;
  private closing = false;
  private readonly command: readonly string[] | null;
  private readonly enabled: boolean;
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly killProcessGroup: ProducerGroupKill;
  private readonly logger: StructuredLogger;
  private readonly maxConcurrentRuns: number;
  private readonly maxPublishedBytes: number;
  private readonly maxPublishedSnapshots: number;
  private readonly ownerId: number;
  private readonly producerEnv: Readonly<Record<string, string>>;
  private readonly projectId: string;
  private readonly producerProcessTimings: ProducerProcessTimings;
  private readonly publicationStore: FastManimSnapshotPublicationStore;
  private readonly publishRetentionMs: number;
  private readonly runtimeDirectoryRemover: (runtimeDir: string) => Promise<void>;
  private readonly sourceStore: ManimSourceStore;
  private readonly timeoutMs: number;

  constructor(
    options: Readonly<{
      admissionController?: FastManimSnapshotAdmissionController;
      capabilities?: readonly FastManimSnapshotRuntimeCapabilityV1[];
      command?: readonly string[] | null;
      /**
       * Explicit dev/test opt-in. Until the OS/network sandbox hardening issue
       * (Poietra/studio-lab#80) lands, running workspace Python via the
       * snapshot producer is restricted to development: with this flag off
       * (the default) the runner fails closed as producer-unconfigured even
       * when a command is configured.
       */
      enabled?: boolean;
      frame: Readonly<{ height: number; width: number }>;
      killProcessGroup?: ProducerGroupKill;
      logger?: StructuredLogger;
      maxConcurrentRuns?: number;
      maxPublishedBytes?: number;
      maxPublishedSnapshots?: number;
      producerEnv?: Readonly<Record<string, string>>;
      /** Test/embedding seam; production keeps the hardened default grace windows. */
      producerProcessTimings?: Partial<ProducerProcessTimings>;
      projectId: string;
      projectRoot: string;
      publicationStore?: FastManimSnapshotPublicationStore;
      publishRetentionMs?: number;
      /** Test seam for proving cleanup-failure behavior without leaking a real directory. */
      runtimeDirectoryRemover?: (runtimeDir: string) => Promise<void>;
      sourceReadHooks?: ManimSourceReadHooks;
      timeoutMs?: number;
    }>,
  ) {
    if (options.command && (options.command.length === 0 || options.command.some((entry) => entry.length === 0))) {
      throw new TypeError("The fast-manim snapshot command must contain a non-empty executable and arguments.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SNAPSHOT_TIMEOUT_MS) {
      throw new TypeError(`Snapshot timeout must be a positive integer of at most ${MAX_SNAPSHOT_TIMEOUT_MS}ms.`);
    }
    const maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_SNAPSHOT_RUNS;
    if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns <= 0) {
      throw new TypeError("Maximum concurrent snapshot runs must be a positive integer.");
    }
    const maxPublishedSnapshots = options.maxPublishedSnapshots ?? DEFAULT_MAX_PUBLISHED_SNAPSHOTS;
    if (!Number.isSafeInteger(maxPublishedSnapshots) || maxPublishedSnapshots <= 0) {
      throw new TypeError("Maximum published snapshots must be a positive integer.");
    }
    const maxPublishedBytes = options.maxPublishedBytes ?? DEFAULT_MAX_PUBLISHED_BYTES;
    if (!Number.isSafeInteger(maxPublishedBytes) || maxPublishedBytes <= 0) {
      throw new TypeError("Maximum published snapshot bytes must be a positive integer.");
    }
    const publishRetentionMs = options.publishRetentionMs ?? DEFAULT_PUBLISH_RETENTION_MS;
    if (!Number.isSafeInteger(publishRetentionMs) || publishRetentionMs <= 0) {
      throw new TypeError("Published snapshot retention must be a positive integer of milliseconds.");
    }
    // The producer executes with a private runtime directory as its working
    // directory and no PYTHONPATH, so only the immutable request sourceText
    // plus installed/trusted runtime modules are importable. Server-controlled
    // producerEnv must not be able to reintroduce the project root onto any
    // search path (relative entries resolve against the private cwd, so only
    // absolute entries can reach it).
    const canonicalProjectRoot = resolve(options.projectRoot);
    for (const [key, value] of Object.entries(options.producerEnv ?? {})) {
      // Mutual determinism contract: the producer always runs under
      // PYTHONHASHSEED=0 (matching the pinned runtimeConfig randomSeed) and
      // producerEnv cannot override it.
      if (key === "PYTHONHASHSEED" && value !== "0") {
        throw new TypeError('The producerEnv PYTHONHASHSEED value is pinned to "0" and cannot be overridden.');
      }
      for (const segment of value.split(delimiter)) {
        if (!isAbsolute(segment)) continue;
        const resolved = resolve(segment);
        if (resolved === canonicalProjectRoot || resolved.startsWith(`${canonicalProjectRoot}${sep}`)) {
          throw new TypeError(`The producerEnv value for ${key} must not point into the Manim project root.`);
        }
      }
    }
    this.capabilities = Object.freeze([...(options.capabilities ?? FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1)]);
    this.command = options.command?.length ? Object.freeze([...options.command]) : null;
    this.enabled = options.enabled ?? false;
    this.frame = Object.freeze({ height: options.frame.height, width: options.frame.width });
    this.killProcessGroup = options.killProcessGroup ?? defaultKillProcessGroup;
    this.logger = options.logger ?? nullLogger;
    this.maxConcurrentRuns = maxConcurrentRuns;
    this.maxPublishedBytes = maxPublishedBytes;
    this.maxPublishedSnapshots = maxPublishedSnapshots;
    this.producerEnv = Object.freeze({ ...options.producerEnv });
    this.producerProcessTimings = resolveProducerProcessTimings(options.producerProcessTimings);
    this.projectId = options.projectId;
    this.admissionController = options.admissionController ?? processAdmissionController;
    this.publicationStore = options.publicationStore ?? processPublicationStore;
    this.ownerId = this.publicationStore.registerOwner();
    this.publishRetentionMs = publishRetentionMs;
    this.runtimeDirectoryRemover =
      options.runtimeDirectoryRemover ??
      ((runtimeDir) => rm(runtimeDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 }));
    this.sourceStore = new ManimSourceStore(options.projectRoot, options.sourceReadHooks);
    this.timeoutMs = timeoutMs;
    // Fail fast on an invalid capability allowlist or frame instead of at run time.
    digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig());
  }

  get busy() {
    // Publication lookups revalidate asynchronously, so they hold the runner
    // busy too: unregister/close must never race a held GET.
    return this.activeKeys.size > 0 || this.activeLookups.size > 0;
  }

  private runtimeConfig(): FastManimSnapshotRuntimeConfigV1 {
    return {
      capabilities: [...this.capabilities],
      frame: { height: this.frame.height, width: this.frame.width },
      randomSeed: 0,
      schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
      snapshotVersion: 1,
      version: 1,
    };
  }

  /**
   * Explicit allowlist only: the producer never inherits the server's full
   * environment (no credential leak), HOME/temp point at the private per-run
   * directory, and no PYTHONPATH is set. Combined with the private runtime
   * directory as cwd (see produce()), only the immutable request sourceText
   * plus installed/trusted runtime modules are importable — project-local
   * helpers cannot silently feed a snapshot correlated solely by sourceHash.
   * Extra variables come only via producerEnv, which the constructor refuses
   * when it points back into the project root.
   *
   * Trusted-runtime residual (#80): the resolved command, the interpreter on
   * PATH, and its site-packages are operator-trusted and NOT hashed. sourceHash
   * covers only the selected source text, never the producer binary or its
   * runtime modules; that deployment-trust boundary is closed by the OS
   * sandbox and a pinned runtime, not by runtime hashing here.
   */
  private producerEnvironment(runtimeDir: string): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of PRODUCER_ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    environment.HOME = runtimeDir;
    environment.TEMP = runtimeDir;
    environment.TMP = runtimeDir;
    environment.TMPDIR = runtimeDir;
    // Applied after the producerEnv spread: the deterministic hash seed that
    // pairs with the pinned runtimeConfig randomSeed can never be overridden.
    return { ...environment, ...this.producerEnv, PYTHONHASHSEED: "0" };
  }

  async run(requestValue: FastManimSnapshotRunRequestV1, signal?: AbortSignal): Promise<FastManimSnapshotRunViewV1> {
    const request = fastManimSnapshotRunRequestV1Schema.parse(requestValue);
    signal?.throwIfAborted();
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    if (request.projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    const key = sceneKey(request.sourcePath, request.sceneName);
    if (this.activeKeys.has(key)) {
      throw new HttpError("A Scene snapshot run is already in progress for this source and Scene.", 409);
    }
    if (this.activeKeys.size >= this.maxConcurrentRuns) {
      throw new HttpError("Too many concurrent Scene snapshot runs.", 429);
    }
    this.activeKeys.add(key);
    const pending = this.runLocked(request, signal);
    this.activeRuns.add(pending);
    pending.catch(() => undefined);
    try {
      return fastManimSnapshotRunViewV1Schema.parse(await pending);
    } finally {
      this.activeKeys.delete(key);
      this.activeRuns.delete(pending);
    }
  }

  private async runLocked(
    request: FastManimSnapshotRunRequestV1,
    signal?: AbortSignal,
  ): Promise<FastManimSnapshotRunViewV1> {
    const throwIfHalted = () => {
      if (signal?.aborted || this.closing) throw abortError();
    };
    const runtimeConfigHash = digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig());
    const base = {
      projectId: request.projectId,
      requestId: request.requestId,
      runtimeConfigHash,
      sceneName: request.sceneName,
      schema: FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
      sourcePath: request.sourcePath,
      version: 1,
    } as const;
    const failed = (
      code: FastManimSnapshotRunFailureCodeV1,
      contractCode?: FastManimSnapshotContractError["code"],
    ): FastManimSnapshotRunViewV1 => {
      this.logger.warn("snapshot.run_failed", { code, contractCode, requestId: request.requestId });
      return {
        ...base,
        failure: {
          code,
          ...(contractCode === undefined ? {} : { contractCode }),
          message: FAILURE_MESSAGES[code],
        },
        fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1,
        status: "failed",
      };
    };

    if (!this.command) return failed("producer-unconfigured");
    if (!this.enabled) {
      // Fail closed pending OS/network sandboxing (Poietra/studio-lab#80).
      this.logger.warn("snapshot.producer_disabled", { requestId: request.requestId });
      return failed("producer-unconfigured");
    }

    // Verified read: the bytes handed to the producer come from a single
    // opened descriptor whose inode is proven to live inside the project
    // root, immune to validate-then-open pathname swaps. Platforms that
    // cannot prove this fail closed (HTTP 501) before any Python runs.
    let before: Awaited<ReturnType<ManimSourceStore["readVerified"]>>;
    try {
      before = await this.sourceStore.readVerified(request.sourcePath);
    } catch (error) {
      throwIfHalted();
      throw error;
    }
    throwIfHalted();
    if (request.sourceHash !== undefined && request.sourceHash !== before.hash) {
      return failed("source-correlation-stale");
    }

    const expected: ExpectedFastManimSnapshotCorrelationV1 = {
      frame: { height: this.frame.height, width: this.frame.width },
      projectId: request.projectId,
      requestId: request.requestId,
      runtimeConfigHash,
      sceneId: fastManimSnapshotSceneIdV1(request.sourcePath, request.sceneName),
      sceneName: request.sceneName,
      sourceHash: before.hash,
      sourcePath: request.sourcePath,
    };
    // Scene existence is the producer's authority: a Python-side base-class
    // check here would false-negative legitimate transitive Scene subclasses.
    // The producer request carries the canonical runtime config object plus
    // the immutable source text, so the producer recomputes runtimeConfigHash
    // and sourceHash instead of echoing them and never re-opens sourcePath.
    // The expected frame is server-side verification state only; the wire
    // request carries the frame inside the canonical runtimeConfig object.
    const { frame: _serverFrame, ...wireCorrelation } = expected;
    const producerRequest = fastManimSnapshotProducerRequestV1Schema.parse({
      ...wireCorrelation,
      runtimeConfig: this.runtimeConfig(),
      schema: FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
      snapshotVersion: 1,
      sourceText: before.source,
      version: 1,
    } satisfies FastManimSnapshotProducerRequestV1);

    const produced = await this.produce(producerRequest, signal);
    throwIfHalted();
    if (produced.kind !== "ok") return failed(produced.code);

    let sealed: VerifiedFastManimSnapshotResultV1;
    try {
      sealed = await parseAndSealFastManimSnapshotProducerJsonV1(produced.stdout, expected);
      // Defense in depth behind the structural static-profile normalization.
      assertFastManimSnapshotDiagnosticsSafeV1(sealed, {
        projectRoot: this.sourceStore.projectRoot,
        sourceAbsolutePath: before.absolutePath,
        sourceText: before.source,
      });
    } catch (cause) {
      throwIfHalted();
      if (cause instanceof FastManimSnapshotContractError) return failed("result-rejected", cause.code);
      this.logger.warn("snapshot.result_rejected", {
        name: cause instanceof Error ? cause.name : typeof cause,
        requestId: request.requestId,
      });
      return failed("result-rejected");
    }
    throwIfHalted();

    // Correlate source and runtime capability again after execution: the file
    // may have been rewritten while the producer ran, and a snapshot must only
    // publish against the exact inputs it was correlated with beforehand. A
    // change-and-restore swap during the run is benign because the producer
    // compiled the immutable request text, never the file.
    let after: Awaited<ReturnType<ManimSourceStore["readVerified"]>>;
    try {
      after = await this.sourceStore.readVerified(request.sourcePath);
    } catch {
      throwIfHalted();
      return failed("source-changed");
    }
    throwIfHalted();
    if (after.hash !== expected.sourceHash) return failed("source-changed");
    if (digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig()) !== runtimeConfigHash) {
      return failed("runtime-config-changed");
    }

    if (sealed.kind === "unsupported") {
      return { ...base, fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1, issues: sealed.issues, status: "unsupported" };
    }

    const unsupportedCapabilities = sealed.bundle.scene.requiredCapabilities.filter(
      (capability) => !this.capabilities.includes(capability),
    );
    if (unsupportedCapabilities.length > 0) {
      this.logger.warn("snapshot.capability_unsupported", {
        requestId: request.requestId,
        unsupportedCapabilities,
      });
      return failed("capability-unsupported");
    }

    const encodedBytes = Buffer.byteLength(JSON.stringify(sealed), "utf8");
    if (encodedBytes > this.maxPublishedBytes || !this.publicationStore.fitsSingleEntry(encodedBytes)) {
      return failed("snapshot-too-large");
    }

    throwIfHalted();
    const key = sceneKey(request.sourcePath, request.sceneName);
    const { publishedAt, revision } = this.publish(key, expected, sealed, encodedBytes);
    this.logger.info("snapshot.published", { requestId: request.requestId, revision });
    return { ...base, publishedAt, revision, snapshot: sealed, status: "verified" };
  }

  private evictExpired(now: number) {
    for (const [key, entry] of this.publicationStore.entriesOf(this.ownerId)) {
      if (now - entry.publishedAtEpochMs > this.publishRetentionMs) this.publicationStore.delete(this.ownerId, key);
    }
  }

  private publish(
    key: string,
    expected: ExpectedFastManimSnapshotCorrelationV1,
    result: VerifiedCompiledFastManimSnapshotResultV1,
    encodedBytes: number,
  ) {
    const now = Date.now();
    this.evictExpired(now);
    // Revisions come from the shared store's single monotonic sequence, so
    // neither eviction, TTL expiry, nor another tenant's publications can
    // ever make a republished Scene appear older than a cached copy.
    const revision = this.publicationStore.nextRevision();
    const publishedAt = new Date(now).toISOString();
    const evicted = this.publicationStore.publish(
      this.ownerId,
      key,
      { encodedBytes, expected, publishedAt, publishedAtEpochMs: now, result, revision },
      { maxBytes: this.maxPublishedBytes, maxEntries: this.maxPublishedSnapshots },
    );
    if (evicted > 0) this.logger.info("snapshot.evicted", { evicted });
    return { publishedAt, revision };
  }

  /**
   * Awaited on every path (success, failure, abort, timeout, close, spawn
   * errors) so neither run() nor close() resolves before the private HOME/TMP
   * directory is gone. A failure is surfaced as a sanitized error and log
   * record — error class and errno code only, never the path or contents.
   */
  private async removeRuntimeDir(runtimeDir: string) {
    try {
      await this.runtimeDirectoryRemover(runtimeDir);
    } catch (error) {
      this.cleanupFailed = true;
      this.logger.error("snapshot.runtime_dir_cleanup_failed", {
        code: error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : null,
        name: error instanceof Error ? error.name : typeof error,
      });
      throw runtimeDirectoryCleanupError();
    }
  }

  private async produce(
    producerRequest: FastManimSnapshotProducerRequestV1,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{ code: FastManimSnapshotRunFailureCodeV1; kind: "failed" }> | Readonly<{ kind: "ok"; stdout: Uint8Array }>
  > {
    const command = this.command;
    if (!command) return { code: "producer-unconfigured", kind: "failed" };
    if (signal?.aborted || this.closing) throw abortError();
    // Server-wide admission control: no producer spawns above the shared cap,
    // regardless of how many runners and projects are configured.
    const releaseAdmission = this.admissionController.tryAcquire();
    if (!releaseAdmission) {
      throw new HttpError("Too many concurrent Scene snapshot runs on this server.", 429);
    }
    let runtimeDir: string;
    try {
      runtimeDir = await mkdtemp(join(tmpdir(), "poietra-producer-"));
      if (signal?.aborted || this.closing) {
        await this.removeRuntimeDir(runtimeDir);
        throw abortError();
      }
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    // Admission and the private runtime directory are this orchestrator's
    // resources; the subprocess supervision state machine owns everything from
    // spawn to settlement. Both are reclaimed here on every path (return or
    // throw) so run()/close() never resolve before the private HOME/TMP is
    // gone or before the admission slot is returned.
    try {
      return await superviseProducerProcess({
        command,
        cwd: runtimeDir,
        env: this.producerEnvironment(runtimeDir),
        isHalted: () => Boolean(signal?.aborted) || this.closing,
        killProcessGroup: this.killProcessGroup,
        logger: this.logger,
        onSettled: (child) => this.activeChildren.delete(child),
        onSpawned: (child, requestStop) => this.activeChildren.set(child, requestStop),
        requestId: producerRequest.requestId,
        requestJson: JSON.stringify(producerRequest),
        signal,
        timings: this.producerProcessTimings,
        timeoutMs: this.timeoutMs,
      });
    } finally {
      releaseAdmission();
      await this.removeRuntimeDir(runtimeDir);
    }
  }

  async snapshot(query: FastManimSnapshotQueryV1): Promise<FastManimSnapshotRunViewV1> {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    // Lookups are tracked like runs: close() awaits them, and busy reports
    // them, so owner release can never race a held revalidation into serving
    // a verified view after shutdown began.
    const pending = this.lookupLocked(query);
    this.activeLookups.add(pending);
    pending.catch(() => undefined);
    try {
      return await pending;
    } finally {
      this.activeLookups.delete(pending);
    }
  }

  private async lookupLocked(query: FastManimSnapshotQueryV1): Promise<FastManimSnapshotRunViewV1> {
    // A lookup holds its entry across async revalidation and a verified
    // freshness read, so a concurrent same-key republish can supersede it
    // mid-flight. Every terminal action below is entry-conditional
    // (compare-and-delete, compare-before-return); when the held entry is no
    // longer current the lookup retries against the fresh publication instead
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = await this.lookupCurrentEntry(query);
      if (view !== null) return view;
    }
    throw new HttpError("The published Scene snapshot kept changing during the lookup; retry the request.", 503);
  }

  private async lookupCurrentEntry(query: FastManimSnapshotQueryV1): Promise<FastManimSnapshotRunViewV1 | null> {
    const throwIfClosing = () => {
      if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    };
    const key = sceneKey(query.sourcePath, query.sceneName);
    const entry = this.publicationStore.get(this.ownerId, key);
    if (!entry) throw new HttpError("No verified Scene snapshot has been published for this Scene.", 404);
    const entryIsCurrent = () => this.publicationStore.peek(this.ownerId, key) === entry;
    const deleteIfCurrent = () => {
      if (entryIsCurrent()) this.publicationStore.delete(this.ownerId, key);
    };
    if (Date.now() - entry.publishedAtEpochMs > this.publishRetentionMs) {
      if (!entryIsCurrent()) return null;
      deleteIfCurrent();
      throw new HttpError("No verified Scene snapshot has been published for this Scene.", 404);
    }
    let revalidated: VerifiedCompiledFastManimSnapshotResultV1;
    try {
      const parsed = await parseVerifiedFastManimSnapshotResultV1(entry.result, entry.expected);
      if (parsed.kind !== "compiled") {
        throw new FastManimSnapshotContractError(
          "profile-violation",
          "A published Scene snapshot must be a compiled result.",
        );
      }
      revalidated = parsed;
    } catch (error) {
      throwIfClosing();
      if (!entryIsCurrent()) return null;
      deleteIfCurrent();
      this.logger.error("snapshot.reverification_failed", { error });
      throw new HttpError("The published Scene snapshot failed re-verification.", 500);
    }
    throwIfClosing();
    const base = {
      projectId: this.projectId,
      requestId: entry.expected.requestId,
      runtimeConfigHash: entry.expected.runtimeConfigHash,
      sceneName: query.sceneName,
      schema: FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
      sourcePath: query.sourcePath,
      version: 1,
    } as const;
    const staleView = (): FastManimSnapshotRunViewV1 | null => {
      // Close beats stale: a lookup whose freshness read failed while (or
      // after) shutdown began must surface 503 rather than unpublish and
      // return a stale view once the GET-vs-close boundary has been crossed.
      throwIfClosing();
      // Stale only applies to the entry this lookup actually validated: if a
      // republish superseded it, the fresh entry must survive and the lookup
      // retries instead of reporting the dead revision.
      if (!entryIsCurrent()) return null;
      this.publicationStore.delete(this.ownerId, key);
      return fastManimSnapshotRunViewV1Schema.parse({
        ...base,
        fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1,
        revision: entry.revision,
        status: "stale",
      });
    };
    // Freshness uses the same hardened verified read as the run path: a
    // pathname swapped to a symlink, FIFO, outside file, or torn rewrite must
    // not vouch for the published snapshot. Any verified-read failure stales
    // and unpublishes rather than serving against unproven bytes.
    let current: Awaited<ReturnType<ManimSourceStore["readVerified"]>>;
    try {
      current = await this.sourceStore.readVerified(query.sourcePath);
    } catch {
      return staleView();
    }
    if (
      current.hash !== entry.expected.sourceHash ||
      digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig()) !== entry.expected.runtimeConfigHash
    ) {
      return staleView();
    }
    throwIfClosing();
    // Never serve a revision that a concurrent republish already superseded.
    if (!entryIsCurrent()) return null;
    return fastManimSnapshotRunViewV1Schema.parse({
      ...base,
      publishedAt: entry.publishedAt,
      revision: entry.revision,
      snapshot: revalidated,
      status: "verified",
    });
  }

  async close() {
    this.closing = true;
    for (const requestStop of this.activeChildren.values()) requestStop();
    // Wait for every in-flight run and publication lookup to settle so
    // nothing publishes or serves after close, then return this runner's
    // publication accounting to the shared budget.
    await Promise.allSettled([...this.activeRuns, ...this.activeLookups]);
    this.publicationStore.releaseOwner(this.ownerId);
    if (this.cleanupFailed) throw runtimeDirectoryCleanupError();
  }
}

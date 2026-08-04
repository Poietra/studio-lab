import type {
  DurableFastManimSnapshotRunnerFactoryV1,
  DurableFastManimSnapshotRunnerHandleV1,
} from "./durable-fast-manim-snapshot-service";
import { verifyFastManimGatedOciReleaseV1 } from "./fast-manim-gated-oci-release";
import {
  createFastManimProductionSandboxClientV1,
  type FastManimProductionSandboxClientOptionsV1,
} from "./fast-manim-production-sandbox-client";
import {
  digestFastManimSnapshotRuntimeConfigV1,
  type FastManimSnapshotProfileVersionV1,
} from "./fast-manim-snapshot-contract";
import { DurableFastManimSnapshotPngProviderV1 } from "./fast-manim-snapshot-durable-png-provider";
import { fastManimSnapshotRuntimeConfigForProfileV1 } from "./fast-manim-snapshot-profile-selection";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import type { ProjectPngBlobStoreV1, ProjectPngRepositoryV1 } from "./storage/project-png-storage";

export type FastManimProductionSnapshotRunnerFactoryOptionsV1 = Readonly<{
  client: FastManimProductionSandboxClientOptionsV1;
  frame: Readonly<{ height: number; width: number }>;
  projectPngRepository?: Pick<ProjectPngRepositoryV1, "readHead">;
  projectPngs?: Pick<ProjectPngBlobStoreV1, "read">;
  snapshotVersion?: FastManimSnapshotProfileVersionV1;
  tenantId: string;
  timeoutMs?: number;
}>;

class SnapshotRunnerCreationCleanupErrorV1 extends AggregateError {
  readonly cleanupErrors: readonly unknown[];

  constructor(error: unknown, cleanupErrors: readonly unknown[]) {
    super([error, ...cleanupErrors], "Snapshot runner construction and cleanup failed.");
    this.name = "SnapshotRunnerCreationCleanupErrorV1";
    this.cleanupErrors = cleanupErrors;
  }
}

/** Creates one independently owned production broker client per durable project runner. */
export class FastManimProductionSnapshotRunnerFactoryV1 implements DurableFastManimSnapshotRunnerFactoryV1 {
  readonly #activeReadiness = new Set<Promise<SnapshotRunnerReadinessOutcomeV1>>();
  readonly #cleanupFailures: unknown[] = [];
  readonly #options: FastManimProductionSnapshotRunnerFactoryOptionsV1;
  readonly #runtimeConfigHash: string | null;
  readonly #runtimeDigest: string;
  #closeRequest: Promise<void> | null = null;
  #closed = false;

  constructor(options: FastManimProductionSnapshotRunnerFactoryOptionsV1) {
    if ((options.projectPngRepository === undefined) !== (options.projectPngs === undefined)) {
      throw new TypeError("Production snapshot PNG repository and blob store must be configured together.");
    }
    if (options.snapshotVersion === 4 && (!options.projectPngRepository || !options.projectPngs)) {
      throw new TypeError("Hermetic PNG snapshot profile V4 requires durable project PNG storage.");
    }
    this.#options = options;
    this.#runtimeConfigHash =
      options.snapshotVersion === undefined
        ? null
        : digestFastManimSnapshotRuntimeConfigV1(
            fastManimSnapshotRuntimeConfigForProfileV1(options.snapshotVersion, options.frame),
          );
    this.#runtimeDigest = verifyFastManimGatedOciReleaseV1(
      options.client.signedRelease,
      options.client.publicKeys,
    ).descriptor().runtimeDigest;
  }

  get runtimeDigest() {
    return this.#runtimeDigest;
  }

  get runtimeConfigHash() {
    return this.#runtimeConfigHash;
  }

  async create(
    input: Parameters<DurableFastManimSnapshotRunnerFactoryV1["create"]>[0],
  ): Promise<DurableFastManimSnapshotRunnerHandleV1> {
    if (this.#closed) throw new Error("The production snapshot runner factory is closed.");
    const client = await createFastManimProductionSandboxClientV1(this.#options.client);
    if (client.runtimeDigest !== this.#runtimeDigest) {
      const invalid = new TypeError("The production snapshot client runtime digest does not match its factory.");
      try {
        await client.backend.close();
      } catch (cleanupError) {
        throw new SnapshotRunnerCreationCleanupErrorV1(invalid, [cleanupError]);
      }
      throw invalid;
    }
    if (this.#closed) {
      const closed = new Error("The production snapshot runner factory is closed.");
      try {
        await client.backend.close();
      } catch (cleanupError) {
        throw new SnapshotRunnerCreationCleanupErrorV1(closed, [cleanupError]);
      }
      throw closed;
    }
    try {
      const pngProvider =
        this.#options.projectPngRepository && this.#options.projectPngs
          ? new DurableFastManimSnapshotPngProviderV1({
              blobs: this.#options.projectPngs,
              projectId: input.projectId,
              repository: this.#options.projectPngRepository,
              tenantId: this.#options.tenantId,
            })
          : undefined;
      return {
        profileDigest: client.profileDigest,
        runner: new FastManimSnapshotRunner({
          attestationVerifier: client.attestationVerifier,
          backend: client.backend,
          deployment: "production",
          frame: this.#options.frame,
          ...(pngProvider === undefined ? {} : { pngProvider }),
          projectId: input.projectId,
          sourceProvider: input.sourceProvider,
          ...(this.#options.snapshotVersion === undefined ? {} : { snapshotVersion: this.#options.snapshotVersion }),
          tenantId: this.#options.tenantId,
          ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
        }),
        runtimeConfigHash: this.#runtimeConfigHash,
        runtimeDigest: client.runtimeDigest,
      };
    } catch (error) {
      const cleanup = await client.backend.close().then(
        () => [],
        (cleanupError: unknown) => [cleanupError],
      );
      if (cleanup.length > 0) {
        throw new SnapshotRunnerCreationCleanupErrorV1(error, cleanup);
      }
      throw error;
    }
  }

  async #probeReadiness(signal?: AbortSignal): Promise<SnapshotRunnerReadinessOutcomeV1> {
    let handle: DurableFastManimSnapshotRunnerHandleV1;
    try {
      handle = await this.create({
        projectId: "snapshot-readiness",
        sourceProvider: {
          readVerified: async () => {
            throw new Error("Readiness must not read project source.");
          },
        },
      });
    } catch (error) {
      const cleanupError =
        error instanceof SnapshotRunnerCreationCleanupErrorV1
          ? new AggregateError(error.cleanupErrors, "Snapshot runner construction cleanup failed.")
          : undefined;
      if (cleanupError !== undefined) this.#cleanupFailures.push(cleanupError);
      return { ...(cleanupError === undefined ? {} : { cleanupError }), healthy: false, readinessError: error };
    }
    let healthy = false;
    let readinessError: unknown;
    try {
      healthy = await handle.runner.ready(signal);
    } catch (error) {
      readinessError = error;
    }
    let cleanupError: unknown;
    try {
      await handle.runner.close();
    } catch (error) {
      cleanupError = error;
      this.#cleanupFailures.push(error);
    }
    return {
      ...(cleanupError === undefined ? {} : { cleanupError }),
      healthy,
      ...(readinessError === undefined ? {} : { readinessError }),
    };
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closed) return false;
    const probe = this.#probeReadiness(signal);
    this.#activeReadiness.add(probe);
    void probe.finally(() => this.#activeReadiness.delete(probe)).catch(() => undefined);
    const { cleanupError, healthy, readinessError } = await probe;
    if (signal?.aborted) {
      let abortReason: unknown;
      try {
        signal.throwIfAborted();
      } catch (error) {
        abortReason = error;
      }
      if (cleanupError !== undefined) {
        throw new AggregateError([abortReason, cleanupError], "Snapshot readiness cancellation and cleanup failed.");
      }
      throw abortReason;
    }
    return !this.#closed && readinessError === undefined && cleanupError === undefined && healthy;
  }

  close() {
    this.#closed = true;
    this.#closeRequest ??= (async () => {
      await Promise.all([...this.#activeReadiness]);
      const errors = [...this.#cleanupFailures];
      if (errors.length > 0) {
        throw new AggregateError(errors, "Could not close all active snapshot readiness runners.");
      }
    })();
    return this.#closeRequest;
  }
}

type SnapshotRunnerReadinessOutcomeV1 = Readonly<{
  cleanupError?: unknown;
  healthy: boolean;
  readinessError?: unknown;
}>;

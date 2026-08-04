import { createHash, randomUUID } from "node:crypto";

import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import {
  deriveHermeticMathTexMorphV5Plan,
  deriveHermeticMathTexV3TransformPlan,
  deriveHermeticPngV4TransformPlan,
  deriveMixedDynamicMathTexV7TransformPlan,
  deriveWarpSquareV9TransformPlan,
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_FALLBACK_V1,
  FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
  type FastManimSnapshotQueryV1,
  type FastManimSnapshotRunRequestV1,
  type FastManimSnapshotRunViewV1,
  fastManimSnapshotQueryV1Schema,
  fastManimSnapshotRunRequestV1Schema,
  type VerifiedCompiledFastManimSnapshotResultV1,
} from "./fast-manim-snapshot-contract";
import type { FastManimSnapshotRunner, FastManimUnpublishedSnapshotRunViewV1 } from "./fast-manim-snapshot-runner";
import {
  DurableFastManimSnapshotSourceProviderV1,
  type FastManimSnapshotSourceProviderV1,
} from "./fast-manim-snapshot-source-provider";
import { HttpError } from "./http/json";
import { manimTenantIdSchema } from "./manim-request-principal";
import type { SnapshotArtifactPublisherV1 } from "./storage/snapshot-artifact-publisher";
import { LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 } from "./storage/snapshot-publication-repository";
import {
  type SourceContentBlobStoreV1,
  sameSourceBlobReceiptV1,
  type WorkspaceSourceHeadV1,
  type WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

const SHA256 = /^[0-9a-f]{64}$/;

export type DurableFastManimSnapshotRunnerHandleV1 = Readonly<{
  profileDigest: string;
  runner: FastManimSnapshotRunner;
  runtimeConfigHash: string;
  runtimeDigest: string;
}>;

export interface DurableFastManimSnapshotRunnerFactoryV1 {
  readonly runtimeConfigHash: string;
  readonly runtimeDigest: string;
  close(): Promise<void>;
  create(
    input: Readonly<{ projectId: string; sourceProvider: FastManimSnapshotSourceProviderV1 }>,
  ): Promise<DurableFastManimSnapshotRunnerHandleV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export type DurableFastManimSnapshotServiceOptionsV1 = Readonly<{
  blobs: SourceContentBlobStoreV1;
  factory: DurableFastManimSnapshotRunnerFactoryV1;
  publicationIdFactory?: () => string;
  publisher: SnapshotArtifactPublisherV1;
  sourceRepository: WorkspaceSourceRepositoryV1;
  tenantId: string;
}>;

type ProjectRunnerEntry = {
  closeRequest: Promise<void> | null;
  disposed: boolean;
  handle: Promise<DurableFastManimSnapshotRunnerHandleV1> | null;
  references: number;
};

function sameSourceHead(left: WorkspaceSourceHeadV1, right: WorkspaceSourceHeadV1) {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.sourcePath === right.sourcePath &&
    left.generation === right.generation &&
    sameSourceBlobReceiptV1(left.blob, right.blob)
  );
}

function sourceChanged(view: Extract<FastManimUnpublishedSnapshotRunViewV1, { status: "verified" }>) {
  return {
    failure: {
      code: "source-changed",
      message: "The Python source changed while the snapshot producer was running.",
    },
    fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1,
    projectId: view.projectId,
    requestId: view.requestId,
    runtimeConfigHash: view.runtimeConfigHash,
    sceneName: view.sceneName,
    schema: view.schema,
    sourcePath: view.sourcePath,
    status: "failed",
    version: view.version,
  } as const satisfies FastManimSnapshotRunViewV1;
}

function revision(generation: bigint) {
  const value = Number(generation);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("The durable snapshot publication generation is outside the API revision range.");
  }
  return value;
}

/**
 * Publishes verified sandbox snapshots through version-pinned durable storage.
 * Runner instances are project-scoped; source and artifact stores remain
 * tenant-scoped and are owned by the surrounding durable runtime.
 */
export class DurableFastManimSnapshotServiceV1 {
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #cleanupFailures = new Set<unknown>();
  readonly #factory: DurableFastManimSnapshotRunnerFactoryV1;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #projects = new Map<string, ProjectRunnerEntry>();
  readonly #publicationIdFactory: () => string;
  readonly #publisher: SnapshotArtifactPublisherV1;
  readonly #runtimeConfigHash: string;
  readonly #runtimeDigest: string;
  readonly #sourceRepository: WorkspaceSourceRepositoryV1;
  readonly #tenantId: string;
  #closeRequest: Promise<void> | null = null;
  #closing = false;

  constructor(options: DurableFastManimSnapshotServiceOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("The durable snapshot tenant ID is invalid.");
    const runtimeDigest = options.factory.runtimeDigest;
    const runtimeConfigHash = options.factory.runtimeConfigHash;
    if (!SHA256.test(runtimeDigest) || runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
      throw new TypeError("The durable snapshot factory runtime digest is invalid.");
    }
    if (!SHA256.test(runtimeConfigHash)) {
      throw new TypeError("The durable snapshot factory runtime-config hash is invalid.");
    }
    this.#tenantId = tenant.data;
    this.#blobs = options.blobs;
    this.#factory = options.factory;
    this.#publisher = options.publisher;
    this.#runtimeConfigHash = runtimeConfigHash;
    this.#runtimeDigest = runtimeDigest;
    this.#sourceRepository = options.sourceRepository;
    this.#publicationIdFactory = options.publicationIdFactory ?? randomUUID;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closing) return false;
    const [factoryReady, publisherReady] = await Promise.all([
      this.#factory.ready(signal),
      this.#publisher.ready(signal),
    ]);
    signal?.throwIfAborted();
    return !this.#closing && factoryReady && publisherReady;
  }

  #track<T>(operation: Promise<T>) {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  #assertOpen() {
    if (this.#closing) throw new HttpError("The durable Scene snapshot service is shutting down.", 503);
  }

  #acquireProject(projectId: string) {
    this.#assertOpen();
    const existing = this.#projects.get(projectId);
    if (existing) {
      existing.references += 1;
      return existing;
    }
    const entry: ProjectRunnerEntry = { closeRequest: null, disposed: false, handle: null, references: 1 };
    this.#projects.set(projectId, entry);
    return entry;
  }

  #releaseProjectReference(projectId: string, entry: ProjectRunnerEntry) {
    entry.references -= 1;
    if (entry.references === 0 && entry.handle === null && this.#projects.get(projectId) === entry) {
      this.#projects.delete(projectId);
    }
  }

  #assertProjectActive(projectId: string, entry: ProjectRunnerEntry) {
    this.#assertOpen();
    if (entry.disposed || this.#projects.get(projectId) !== entry) {
      throw new HttpError("The durable Scene snapshot runner was released.", 503);
    }
  }

  #dispose(entry: ProjectRunnerEntry) {
    entry.disposed = true;
    entry.closeRequest ??=
      entry.handle === null
        ? Promise.resolve()
        : entry.handle.then(
            (handle) => handle.runner.close(),
            () => undefined,
          );
    return entry.closeRequest;
  }

  async #runner(projectId: string, entry: ProjectRunnerEntry) {
    this.#assertProjectActive(projectId, entry);
    let pending = entry.handle;
    if (pending === null) {
      const sourceProvider = new DurableFastManimSnapshotSourceProviderV1({
        blobs: this.#blobs,
        projectId,
        repository: this.#sourceRepository,
        tenantId: this.#tenantId,
      });
      pending = Promise.resolve()
        .then(() => this.#factory.create({ projectId, sourceProvider }))
        .then(async (handle) => {
          if (
            !SHA256.test(handle.profileDigest) ||
            handle.runtimeConfigHash !== this.#runtimeConfigHash ||
            handle.runtimeDigest !== this.#runtimeDigest
          ) {
            const invalid = new TypeError("The durable snapshot runner identity is invalid.");
            try {
              await handle.runner.close();
            } catch (cleanupError) {
              throw new AggregateError(
                [invalid, cleanupError],
                "The invalid durable snapshot runner could not be closed.",
              );
            }
            throw invalid;
          }
          return handle;
        });
      entry.handle = pending;
      void pending.catch(() => {
        entry.disposed = true;
        if (this.#projects.get(projectId) === entry) this.#projects.delete(projectId);
      });
    }
    const handle = await pending;
    if (entry.disposed || this.#closing || this.#projects.get(projectId) !== entry) {
      await this.#dispose(entry);
      throw new HttpError("The durable Scene snapshot runner was released.", 503);
    }
    return handle;
  }

  run(requestValue: FastManimSnapshotRunRequestV1, signal?: AbortSignal) {
    const request = fastManimSnapshotRunRequestV1Schema.parse(requestValue);
    this.#assertOpen();
    const entry = this.#acquireProject(request.projectId);
    const operation = this.#run(request, entry, signal).finally(() =>
      this.#releaseProjectReference(request.projectId, entry),
    );
    return this.#track(operation);
  }

  async #run(
    request: FastManimSnapshotRunRequestV1,
    entry: ProjectRunnerEntry,
    signal?: AbortSignal,
  ): Promise<FastManimSnapshotRunViewV1> {
    signal?.throwIfAborted();
    const before = await this.#sourceRepository.readSourceHead(
      this.#tenantId,
      request.projectId,
      request.sourcePath,
      signal,
    );
    this.#assertProjectActive(request.projectId, entry);
    signal?.throwIfAborted();
    const handle = await this.#runner(request.projectId, entry);
    this.#assertProjectActive(request.projectId, entry);
    signal?.throwIfAborted();
    const view = await handle.runner.runUnpublished(request, signal);
    this.#assertProjectActive(request.projectId, entry);
    if (view.status !== "verified") return view;
    if (view.runtimeConfigHash !== this.#runtimeConfigHash) {
      throw new Error("The verified durable snapshot does not match the active runtime configuration.");
    }
    signal?.throwIfAborted();
    const after = await this.#sourceRepository.readSourceHead(
      this.#tenantId,
      request.projectId,
      request.sourcePath,
      signal,
    );
    this.#assertProjectActive(request.projectId, entry);
    // A concrete runner only emits `verified` after the asynchronous bundle
    // digest verifier and server seal succeed. The public wire type keeps the
    // bundle unknown because Zod cannot express that async refinement.
    const snapshot = view.snapshot as VerifiedCompiledFastManimSnapshotResultV1;
    const scene = snapshot.bundle.scene;
    if (scene.source.kind !== "imported-manim-server-snapshot") {
      throw new Error("A verified fast-manim snapshot must retain imported source evidence.");
    }
    if (!sameSourceHead(before, after) || before.blob.digest !== snapshot.sourceHash) {
      return sourceChanged(view);
    }
    let hermeticMathTexV3Plan: ExpectedFastManimSnapshotCorrelationV1["hermeticMathTexV3Plan"];
    let hermeticPngV4Plan: ExpectedFastManimSnapshotCorrelationV1["hermeticPngV4Plan"];
    let hermeticMathTexMorphV5Plan: ExpectedFastManimSnapshotCorrelationV1["hermeticMathTexMorphV5Plan"];
    let warpSquareV9Plan: ExpectedFastManimSnapshotCorrelationV1["warpSquareV9Plan"];
    if (
      scene.source.snapshotVersion === 3 ||
      scene.source.snapshotVersion === 4 ||
      scene.source.snapshotVersion === 5 ||
      scene.source.snapshotVersion === 7 ||
      scene.source.snapshotVersion === 9
    ) {
      signal?.throwIfAborted();
      const source = await this.#blobs.readSource(this.#tenantId, before.blob, signal);
      this.#assertProjectActive(request.projectId, entry);
      signal?.throwIfAborted();
      if (
        Buffer.byteLength(source, "utf8") !== before.blob.byteSize ||
        createHash("sha256").update(source, "utf8").digest("hex") !== before.blob.digest
      ) {
        throw new Error("The durable hermetic snapshot source does not match its version-pinned blob receipt.");
      }
      if (scene.source.snapshotVersion === 3) {
        hermeticMathTexV3Plan = deriveHermeticMathTexV3TransformPlan(source, view.sceneName);
      } else if (scene.source.snapshotVersion === 4) {
        hermeticPngV4Plan = deriveHermeticPngV4TransformPlan(source, view.sceneName);
      } else if (scene.source.snapshotVersion === 5) {
        hermeticMathTexMorphV5Plan = deriveHermeticMathTexMorphV5Plan(source, view.sceneName);
      } else if (scene.source.snapshotVersion === 7) {
        hermeticMathTexV3Plan = deriveMixedDynamicMathTexV7TransformPlan(source, view.sceneName);
      } else {
        warpSquareV9Plan = deriveWarpSquareV9TransformPlan(source, view.sceneName);
      }
    }
    const expected: ExpectedFastManimSnapshotCorrelationV1 = {
      frame: { height: scene.camera.view.frameHeight, width: scene.camera.view.frameWidth },
      ...(hermeticMathTexV3Plan ? { hermeticMathTexV3Plan } : {}),
      ...(hermeticMathTexMorphV5Plan ? { hermeticMathTexMorphV5Plan } : {}),
      ...(hermeticPngV4Plan ? { hermeticPngV4Plan } : {}),
      ...(warpSquareV9Plan ? { warpSquareV9Plan } : {}),
      projectId: view.projectId,
      requestId: view.requestId,
      runtimeConfigHash: view.runtimeConfigHash,
      snapshotVersion: scene.source.snapshotVersion,
      sceneId: scene.sceneId,
      sceneName: view.sceneName,
      sourceHash: snapshot.sourceHash,
      sourcePath: view.sourcePath,
    };
    this.#assertProjectActive(request.projectId, entry);
    signal?.throwIfAborted();
    const published = await this.#publisher.publish(
      {
        expected,
        expectedSourceGeneration: before.generation,
        profileDigest: handle.profileDigest,
        projectId: view.projectId,
        publicationId: this.#publicationIdFactory(),
        runtimeConfigHash: this.#runtimeConfigHash,
        sceneName: view.sceneName,
        snapshot,
        sourcePath: view.sourcePath,
        sourceRuntimeIdentity: view.sourceRuntimeIdentity ?? null,
        runtimeDigest: this.#runtimeDigest,
        tenantId: this.#tenantId,
      },
      signal,
    );
    if (published.kind === "source-stale") return sourceChanged(view);
    return {
      ...view,
      publishedAt: published.publication.publishedAt.toISOString(),
      revision: revision(published.publication.generation),
    };
  }

  snapshot(projectIdValue: string, queryValue: FastManimSnapshotQueryV1, signal?: AbortSignal) {
    const projectId = manimProjectIdSchema.parse(projectIdValue);
    const query = fastManimSnapshotQueryV1Schema.parse(queryValue);
    this.#assertOpen();
    return this.#track(this.#snapshot(projectId, query, signal));
  }

  async #snapshot(
    projectId: string,
    query: FastManimSnapshotQueryV1,
    signal?: AbortSignal,
  ): Promise<FastManimSnapshotRunViewV1> {
    signal?.throwIfAborted();
    const result = await this.#publisher.readCurrent(
      {
        projectId,
        runtimeConfigHash: this.#runtimeConfigHash,
        runtimeDigest: this.#runtimeDigest,
        sceneName: query.sceneName,
        sourcePath: query.sourcePath,
        tenantId: this.#tenantId,
      },
      signal,
    );
    this.#assertOpen();
    if (result.kind === "stale" && result.reason === "concurrently-superseded") {
      throw new HttpError("The published Scene snapshot kept changing during the lookup; retry the request.", 503);
    }
    if (result.kind !== "published") {
      throw new HttpError("No verified Scene snapshot has been published for this Scene.", 404);
    }
    const { document, publication } = result;
    return {
      projectId: document.expected.projectId,
      publishedAt: publication.publishedAt.toISOString(),
      requestId: document.expected.requestId,
      revision: revision(publication.generation),
      runtimeConfigHash: document.expected.runtimeConfigHash,
      sceneName: document.expected.sceneName,
      schema: FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
      snapshot: document.snapshot,
      ...(document.sourceRuntimeIdentity === null ? {} : { sourceRuntimeIdentity: document.sourceRuntimeIdentity }),
      sourcePath: document.expected.sourcePath,
      status: "verified",
      version: 1,
    };
  }

  releaseProject(projectIdValue: string, signal?: AbortSignal) {
    const projectId = manimProjectIdSchema.parse(projectIdValue);
    this.#assertOpen();
    return this.#track(this.#releaseProject(projectId, signal));
  }

  async #releaseProject(projectId: string, signal?: AbortSignal) {
    await this.#publisher.softDeleteProject(this.#tenantId, projectId, signal);
    const entry = this.#projects.get(projectId);
    if (!entry) return;
    this.#projects.delete(projectId);
    const cleanup = await Promise.allSettled([this.#dispose(entry)]);
    if (cleanup[0]?.status === "rejected") this.#cleanupFailures.add(cleanup[0].reason);
  }

  close() {
    this.#closeRequest ??= this.#close();
    return this.#closeRequest;
  }

  async #close() {
    this.#closing = true;
    const entries = [...this.#projects.values()];
    this.#projects.clear();
    const runnerResults = await Promise.allSettled(entries.map((entry) => this.#dispose(entry)));
    await Promise.allSettled([...this.#operations]);
    const cleanupFailures = [...this.#cleanupFailures];
    this.#cleanupFailures.clear();
    const ownerResults = await Promise.allSettled([this.#factory.close(), this.#publisher.close()]);
    const errors = [
      ...cleanupFailures,
      ...[...runnerResults, ...ownerResults].flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (errors.length > 0)
      throw new AggregateError(errors, "Could not fully close the durable Scene snapshot service.");
  }
}

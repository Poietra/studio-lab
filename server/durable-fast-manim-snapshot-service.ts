import { randomUUID } from "node:crypto";

import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import {
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
import type { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import {
  DurableFastManimSnapshotSourceProviderV1,
  type FastManimSnapshotSourceProviderV1,
} from "./fast-manim-snapshot-source-provider";
import { HttpError } from "./http/json";
import { manimTenantIdSchema } from "./manim-request-principal";
import type { SnapshotArtifactPublisherV1 } from "./storage/snapshot-artifact-publisher";
import type {
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

const SHA256 = /^[0-9a-f]{64}$/;

export type DurableFastManimSnapshotRunnerHandleV1 = Readonly<{
  profileDigest: string;
  runner: FastManimSnapshotRunner;
}>;

export interface DurableFastManimSnapshotRunnerFactoryV1 {
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
  handle: Promise<DurableFastManimSnapshotRunnerHandleV1>;
};

function sameSourceHead(left: WorkspaceSourceHeadV1, right: WorkspaceSourceHeadV1) {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.sourcePath === right.sourcePath &&
    left.generation === right.generation &&
    left.blob.byteSize === right.blob.byteSize &&
    left.blob.digest === right.blob.digest &&
    left.blob.etag === right.blob.etag &&
    left.blob.objectKey === right.blob.objectKey &&
    left.blob.versionId === right.blob.versionId
  );
}

function sourceChanged(view: Extract<FastManimSnapshotRunViewV1, { status: "verified" }>) {
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
  readonly #factory: DurableFastManimSnapshotRunnerFactoryV1;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #projects = new Map<string, ProjectRunnerEntry>();
  readonly #publicationIdFactory: () => string;
  readonly #publisher: SnapshotArtifactPublisherV1;
  readonly #sourceRepository: WorkspaceSourceRepositoryV1;
  readonly #tenantId: string;
  #closeRequest: Promise<void> | null = null;
  #closing = false;

  constructor(options: DurableFastManimSnapshotServiceOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("The durable snapshot tenant ID is invalid.");
    this.#tenantId = tenant.data;
    this.#blobs = options.blobs;
    this.#factory = options.factory;
    this.#publisher = options.publisher;
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

  #projectEntry(projectId: string) {
    this.#assertOpen();
    const existing = this.#projects.get(projectId);
    if (existing) return existing;
    const sourceProvider = new DurableFastManimSnapshotSourceProviderV1({
      blobs: this.#blobs,
      projectId,
      repository: this.#sourceRepository,
      tenantId: this.#tenantId,
    });
    const pending = this.#factory.create({ projectId, sourceProvider }).then(async (handle) => {
      if (!SHA256.test(handle.profileDigest)) {
        const invalid = new TypeError("The durable snapshot runner profile digest is invalid.");
        try {
          await handle.runner.close();
        } catch (cleanupError) {
          throw new AggregateError([invalid, cleanupError], "The invalid durable snapshot runner could not be closed.");
        }
        throw invalid;
      }
      return handle;
    });
    const entry: ProjectRunnerEntry = { closeRequest: null, disposed: false, handle: pending };
    this.#projects.set(projectId, entry);
    void entry.handle.catch(() => {
      if (this.#projects.get(projectId) === entry) this.#projects.delete(projectId);
    });
    return entry;
  }

  #dispose(entry: ProjectRunnerEntry) {
    entry.disposed = true;
    entry.closeRequest ??= entry.handle.then(
      (handle) => handle.runner.close(),
      () => undefined,
    );
    return entry.closeRequest;
  }

  async #runner(projectId: string) {
    const entry = this.#projectEntry(projectId);
    const handle = await entry.handle;
    if (entry.disposed || this.#closing) {
      await this.#dispose(entry);
      throw new HttpError("The durable Scene snapshot runner was released.", 503);
    }
    return handle;
  }

  run(requestValue: FastManimSnapshotRunRequestV1, signal?: AbortSignal) {
    const request = fastManimSnapshotRunRequestV1Schema.parse(requestValue);
    this.#assertOpen();
    return this.#track(this.#run(request, signal));
  }

  async #run(request: FastManimSnapshotRunRequestV1, signal?: AbortSignal): Promise<FastManimSnapshotRunViewV1> {
    signal?.throwIfAborted();
    const handle = await this.#runner(request.projectId);
    signal?.throwIfAborted();
    const before = await this.#sourceRepository.readSourceHead(
      this.#tenantId,
      request.projectId,
      request.sourcePath,
      signal,
    );
    const view = await handle.runner.run(request, signal);
    this.#assertOpen();
    if (view.status !== "verified") return view;
    signal?.throwIfAborted();
    const after = await this.#sourceRepository.readSourceHead(
      this.#tenantId,
      request.projectId,
      request.sourcePath,
      signal,
    );
    this.#assertOpen();
    // A concrete runner only emits `verified` after the asynchronous bundle
    // digest verifier and server seal succeed. The public wire type keeps the
    // bundle unknown because Zod cannot express that async refinement.
    const snapshot = view.snapshot as VerifiedCompiledFastManimSnapshotResultV1;
    const scene = snapshot.bundle.scene;
    if (!sameSourceHead(before, after) || before.blob.digest !== snapshot.sourceHash) {
      return sourceChanged(view);
    }
    const expected: ExpectedFastManimSnapshotCorrelationV1 = {
      frame: { height: scene.camera.view.frameHeight, width: scene.camera.view.frameWidth },
      projectId: view.projectId,
      requestId: view.requestId,
      runtimeConfigHash: view.runtimeConfigHash,
      sceneId: scene.sceneId,
      sceneName: view.sceneName,
      sourceHash: snapshot.sourceHash,
      sourcePath: view.sourcePath,
    };
    this.#assertOpen();
    signal?.throwIfAborted();
    const published = await this.#publisher.publish(
      {
        expected,
        expectedSourceGeneration: before.generation,
        profileDigest: handle.profileDigest,
        projectId: view.projectId,
        publicationId: this.#publicationIdFactory(),
        sceneName: view.sceneName,
        snapshot,
        sourcePath: view.sourcePath,
        sourceRuntimeIdentity: view.sourceRuntimeIdentity ?? null,
        tenantId: this.#tenantId,
      },
      signal,
    );
    this.#assertOpen();
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
      { projectId, sceneName: query.sceneName, sourcePath: query.sourcePath, tenantId: this.#tenantId },
      signal,
    );
    this.#assertOpen();
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

  async releaseProject(projectIdValue: string) {
    const projectId = manimProjectIdSchema.parse(projectIdValue);
    const entry = this.#projects.get(projectId);
    if (!entry) return;
    this.#projects.delete(projectId);
    await this.#dispose(entry);
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
    const ownerResults = await Promise.allSettled([this.#factory.close(), this.#publisher.close()]);
    const errors = [...runnerResults, ...ownerResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0)
      throw new AggregateError(errors, "Could not fully close the durable Scene snapshot service.");
  }
}

import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import { HttpError } from "./http/json";
import { manimTenantIdSchema } from "./manim-request-principal";
import { type ManimSourceReadHooks, ManimSourceStore } from "./manim-source-store";
import {
  type SourceBlobReceiptV1,
  type SourceContentBlobStoreV1,
  sameSourceBlobReceiptV1,
  sourceBlobLocatorIdentityV1,
  type WorkspaceSourceHeadV1,
  type WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

export type FastManimSnapshotSourceReadV1 = Readonly<{
  absolutePath?: string;
  hash: string;
  source: string;
  sourceGeneration?: bigint;
  versionToken: string;
}>;

export interface FastManimSnapshotSourceProviderV1 {
  readonly diagnosticProjectRoot?: string;
  readVerified(sourcePath: string, signal?: AbortSignal): Promise<FastManimSnapshotSourceReadV1>;
}

function sameBlob(left: SourceBlobReceiptV1, right: SourceBlobReceiptV1) {
  return sameSourceBlobReceiptV1(left, right);
}

function sameHead(left: WorkspaceSourceHeadV1, right: WorkspaceSourceHeadV1) {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.sourcePath === right.sourcePath &&
    left.generation === right.generation &&
    sameBlob(left.blob, right.blob)
  );
}

/** Adapts the hardened local descriptor read without changing local semantics. */
export class FileSystemFastManimSnapshotSourceProviderV1 implements FastManimSnapshotSourceProviderV1 {
  readonly diagnosticProjectRoot: string;
  readonly #store: ManimSourceStore;

  constructor(projectRoot: string, hooks?: ManimSourceReadHooks) {
    this.#store = new ManimSourceStore(projectRoot, hooks);
    this.diagnosticProjectRoot = this.#store.projectRoot;
  }

  async readVerified(sourcePath: string) {
    const snapshot = await this.#store.readVerified(sourcePath);
    return { ...snapshot, versionToken: snapshot.hash };
  }
}

/** Reads one exact durable source version and rejects a concurrent head change. */
export class DurableFastManimSnapshotSourceProviderV1 implements FastManimSnapshotSourceProviderV1 {
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #projectId: string;
  readonly #repository: WorkspaceSourceRepositoryV1;
  readonly #tenantId: string;

  constructor(
    options: Readonly<{
      blobs: SourceContentBlobStoreV1;
      projectId: string;
      repository: WorkspaceSourceRepositoryV1;
      tenantId: string;
    }>,
  ) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    const project = manimProjectIdSchema.safeParse(options.projectId);
    if (!tenant.success || !project.success) throw new TypeError("Durable snapshot source identity is invalid.");
    this.#blobs = options.blobs;
    this.#projectId = project.data;
    this.#repository = options.repository;
    this.#tenantId = tenant.data;
  }

  async readVerified(sourcePath: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const before = await this.#repository.readSourceHead(this.#tenantId, this.#projectId, sourcePath, signal);
    const source = await this.#blobs.readSource(this.#tenantId, before.blob, signal);
    signal?.throwIfAborted();
    const after = await this.#repository.readSourceHead(this.#tenantId, this.#projectId, sourcePath, signal);
    if (!sameHead(before, after)) throw new HttpError("The selected Python source changed while it was read.", 409);
    return {
      hash: before.blob.digest,
      source,
      sourceGeneration: before.generation,
      versionToken: `${before.generation}:${before.blob.digest}:${sourceBlobLocatorIdentityV1(before.blob)}`,
    };
  }
}

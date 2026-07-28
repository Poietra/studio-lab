export const MAX_SNAPSHOT_ARTIFACT_BYTES_V1 = 16 * 1024 * 1024;

export class SnapshotArtifactReadErrorV1 extends Error {
  readonly code: "corrupt" | "missing";

  constructor(code: "corrupt" | "missing") {
    super(code === "missing" ? "The snapshot artifact version is missing." : "The snapshot artifact is corrupt.");
    this.name = "SnapshotArtifactReadErrorV1";
    this.code = code;
  }
}

export type SnapshotArtifactReceiptV1 = Readonly<{
  byteSize: number;
  etag: string;
  objectKey: string;
  profileDigest: string;
  resultDigest: string;
  runtimeConfigHash: string;
  sourceDigest: string;
  versionId: string;
}>;

export type SnapshotPublicationIdentityV1 = Readonly<{
  projectId: string;
  sceneName: string;
  sourcePath: string;
  tenantId: string;
}>;

export type SnapshotPublicationV1 = SnapshotPublicationIdentityV1 &
  Readonly<{
    artifact: SnapshotArtifactReceiptV1;
    generation: bigint;
    publicationId: string;
    publishedAt: Date;
    requestId: string;
    snapshotHash: string;
    sourceGeneration: bigint;
  }>;

export type SnapshotPublicationReadV1 =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ generation: bigint; kind: "stale" }>
  | Readonly<{ kind: "published"; publication: SnapshotPublicationV1 }>;

export type SnapshotArtifactVersionV1 = Readonly<{
  artifact: SnapshotArtifactReceiptV1;
  lastModified: Date;
}>;

export type SnapshotArtifactVersionPageV1 = Readonly<{
  nextCursor: string | null;
  versions: readonly SnapshotArtifactVersionV1[];
}>;

export type SnapshotArtifactDeletionV1 = Readonly<{
  artifact: SnapshotArtifactReceiptV1;
  deletionId: string;
  tenantId: string;
}>;

export interface SnapshotPublicationRepositoryV1 {
  acknowledgeArtifactDeletion(tenantId: string, deletionId: string, signal?: AbortSignal): Promise<void>;
  clearHeadIfGeneration(
    identity: SnapshotPublicationIdentityV1,
    generation: bigint,
    signal?: AbortSignal,
  ): Promise<boolean>;
  close(): Promise<void>;
  confirmCurrent(publication: SnapshotPublicationV1, signal?: AbortSignal): Promise<boolean>;
  isArtifactPublished(tenantId: string, artifact: SnapshotArtifactReceiptV1, signal?: AbortSignal): Promise<boolean>;
  pendingArtifactDeletions(
    tenantId: string,
    maximum: number,
    signal?: AbortSignal,
  ): Promise<readonly SnapshotArtifactDeletionV1[]>;
  publish(
    input: SnapshotPublicationIdentityV1 &
      Readonly<{
        artifact: SnapshotArtifactReceiptV1;
        expectedSourceDigest: string;
        expectedSourceGeneration: bigint;
        publicationId: string;
        requestId: string;
        snapshotHash: string;
      }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ kind: "source-stale" }> | Readonly<{ kind: "published"; publication: SnapshotPublicationV1 }>>;
  readCurrent(identity: SnapshotPublicationIdentityV1, signal?: AbortSignal): Promise<SnapshotPublicationReadV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
  queueArtifactDeletion(
    tenantId: string,
    artifact: SnapshotArtifactReceiptV1,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactDeletionV1 | null>;
}

export interface SnapshotArtifactStoreV1 {
  close(): Promise<void>;
  deleteVersion(tenantId: string, artifact: SnapshotArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactVersionPageV1>;
  put(
    tenantId: string,
    input: Readonly<{
      bytes: Uint8Array;
      profileDigest: string;
      runtimeConfigHash: string;
      sourceDigest: string;
    }>,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactReceiptV1>;
  read(tenantId: string, artifact: SnapshotArtifactReceiptV1, signal?: AbortSignal): Promise<Uint8Array>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

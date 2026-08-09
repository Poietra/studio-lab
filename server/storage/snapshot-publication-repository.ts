import {
  type ImmutableSnapshotArtifactReceiptV1,
  parseImmutableSnapshotArtifactReceiptV1,
} from "./immutable-snapshot-artifact-store";
import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  type SnapshotArtifactIdentityV1,
  snapshotArtifactObjectKeyV1,
} from "./snapshot-artifact-contract";

export {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  type SnapshotArtifactIdentityV1,
  SnapshotArtifactReadErrorV1,
  snapshotArtifactObjectKeyV1,
} from "./snapshot-artifact-contract";

export type VersionedSnapshotArtifactReceiptV1 = SnapshotArtifactIdentityV1 &
  Readonly<{
    byteSize: number;
    etag: string;
    objectKey: string;
    versionId: string;
  }>;

export type SnapshotArtifactReceiptV1 = VersionedSnapshotArtifactReceiptV1 | ImmutableSnapshotArtifactReceiptV1;

export type SnapshotArtifactLocatorV1 =
  | Readonly<{ kind: "immutable"; objectGeneration: string; objectKey: string }>
  | Readonly<{ kind: "versioned"; objectKey: string; versionId: string }>;

const SNAPSHOT_ARTIFACT_RECEIPT_FIELDS_V1 =
  "byteSize etag objectKey profileDigest resultDigest runtimeConfigHash runtimeDigest sourceDigest versionId".split(
    " ",
  ) as readonly (keyof VersionedSnapshotArtifactReceiptV1)[];

export function parseVersionedSnapshotArtifactReceiptV1(
  tenantId: string,
  value: unknown,
): VersionedSnapshotArtifactReceiptV1 {
  if (!value || typeof value !== "object") throw new TypeError("Snapshot artifact receipt is invalid.");
  const candidate = value as Record<string, unknown>;
  const receipt = Object.fromEntries(
    SNAPSHOT_ARTIFACT_RECEIPT_FIELDS_V1.map((field) => [field, candidate[field]]),
  ) as VersionedSnapshotArtifactReceiptV1;
  if (
    receipt.objectKey !== snapshotArtifactObjectKeyV1(tenantId, receipt) ||
    !Number.isSafeInteger(receipt.byteSize) ||
    receipt.byteSize < 1 ||
    receipt.byteSize > MAX_SNAPSHOT_ARTIFACT_BYTES_V1 ||
    typeof receipt.versionId !== "string" ||
    receipt.versionId.length < 1 ||
    receipt.versionId.length > 1_024 ||
    typeof receipt.etag !== "string" ||
    receipt.etag.length < 1 ||
    receipt.etag.length > 512
  ) {
    throw new TypeError("Snapshot artifact receipt is invalid.");
  }
  return receipt;
}

export function parseSnapshotArtifactReceiptV1(tenantId: string, value: unknown): SnapshotArtifactReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Snapshot artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const hasVersionId = Object.hasOwn(candidate, "versionId");
  const hasObjectGeneration = Object.hasOwn(candidate, "objectGeneration");
  if (hasVersionId === hasObjectGeneration) throw new TypeError("Snapshot artifact receipt locator is ambiguous.");
  return hasVersionId
    ? parseVersionedSnapshotArtifactReceiptV1(tenantId, candidate)
    : parseImmutableSnapshotArtifactReceiptV1(tenantId, candidate);
}

export function snapshotArtifactIdentityV1(receipt: SnapshotArtifactReceiptV1): SnapshotArtifactIdentityV1 {
  if ("versionId" in receipt) {
    const { profileDigest, resultDigest, runtimeConfigHash, runtimeDigest, sourceDigest } = receipt;
    return { profileDigest, resultDigest, runtimeConfigHash, runtimeDigest, sourceDigest };
  }
  const { identity } = receipt;
  return {
    profileDigest: identity.profileDigest,
    resultDigest: identity.resultDigest,
    runtimeConfigHash: identity.runtimeConfigHash,
    runtimeDigest: identity.kind === "legacy" ? LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 : identity.runtimeDigest,
    sourceDigest: identity.sourceDigest,
  };
}

export function snapshotArtifactLocatorV1(receipt: SnapshotArtifactReceiptV1): SnapshotArtifactLocatorV1 {
  return "versionId" in receipt
    ? { kind: "versioned", objectKey: receipt.objectKey, versionId: receipt.versionId }
    : { kind: "immutable", objectGeneration: receipt.objectGeneration, objectKey: receipt.objectKey };
}

export function sameSnapshotArtifactReceiptV1(left: SnapshotArtifactReceiptV1, right: SnapshotArtifactReceiptV1) {
  const leftIdentity = snapshotArtifactIdentityV1(left);
  const rightIdentity = snapshotArtifactIdentityV1(right);
  const leftLocator = snapshotArtifactLocatorV1(left);
  const rightLocator = snapshotArtifactLocatorV1(right);
  return (
    left.byteSize === right.byteSize &&
    left.etag === right.etag &&
    leftIdentity.profileDigest === rightIdentity.profileDigest &&
    leftIdentity.resultDigest === rightIdentity.resultDigest &&
    leftIdentity.runtimeConfigHash === rightIdentity.runtimeConfigHash &&
    leftIdentity.runtimeDigest === rightIdentity.runtimeDigest &&
    leftIdentity.sourceDigest === rightIdentity.sourceDigest &&
    leftLocator.kind === rightLocator.kind &&
    leftLocator.objectKey === rightLocator.objectKey &&
    (leftLocator.kind === "versioned"
      ? rightLocator.kind === "versioned" && leftLocator.versionId === rightLocator.versionId
      : rightLocator.kind === "immutable" && leftLocator.objectGeneration === rightLocator.objectGeneration)
  );
}

export function sameSnapshotArtifactContentV1(left: SnapshotArtifactReceiptV1, right: SnapshotArtifactReceiptV1) {
  const leftIdentity = snapshotArtifactIdentityV1(left);
  const rightIdentity = snapshotArtifactIdentityV1(right);
  return (
    left.byteSize === right.byteSize &&
    leftIdentity.profileDigest === rightIdentity.profileDigest &&
    leftIdentity.resultDigest === rightIdentity.resultDigest &&
    leftIdentity.runtimeConfigHash === rightIdentity.runtimeConfigHash &&
    leftIdentity.runtimeDigest === rightIdentity.runtimeDigest &&
    leftIdentity.sourceDigest === rightIdentity.sourceDigest
  );
}

export type SnapshotPublicationIdentityV1 = Readonly<{
  projectId: string;
  runtimeConfigHash: string;
  runtimeDigest: string;
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

export type SnapshotArtifactVersionV1<Receipt extends SnapshotArtifactReceiptV1 = SnapshotArtifactReceiptV1> =
  Readonly<{
    artifact: Receipt;
    lastModified: Date;
  }>;

export type SnapshotArtifactVersionPageV1<Receipt extends SnapshotArtifactReceiptV1 = SnapshotArtifactReceiptV1> =
  Readonly<{
    nextCursor: string | null;
    versions: readonly SnapshotArtifactVersionV1<Receipt>[];
  }>;

export type SnapshotArtifactDeletionV1 = Readonly<{
  artifact: SnapshotArtifactReceiptV1;
  deletionId: string;
  tenantId: string;
}>;

export type SnapshotPublicationTombstoneCompactionResultV1 = Readonly<{
  compacted: number;
  deferredForPendingArtifactDeletions: boolean;
}>;

export interface SnapshotPublicationRepositoryV1 {
  acknowledgeArtifactDeletion(tenantId: string, deletionId: string, signal?: AbortSignal): Promise<void>;
  compactPublicationTombstones(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    signal?: AbortSignal,
  ): Promise<SnapshotPublicationTombstoneCompactionResultV1>;
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
  softDeleteProject(tenantId: string, projectId: string, signal?: AbortSignal): Promise<void>;
  queueArtifactDeletion(
    tenantId: string,
    artifact: SnapshotArtifactReceiptV1,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactDeletionV1 | null>;
}

export type SnapshotArtifactWriteInputV1 = Readonly<{
  bytes: Uint8Array;
  profileDigest: string;
  runtimeConfigHash: string;
  runtimeDigest: string;
  sourceDigest: string;
}>;

export interface SnapshotArtifactStoreV1<Receipt extends SnapshotArtifactReceiptV1 = SnapshotArtifactReceiptV1> {
  close(): Promise<void>;
  deleteVersion(tenantId: string, artifact: Receipt, signal?: AbortSignal): Promise<void>;
  listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactVersionPageV1<Receipt>>;
  put(tenantId: string, input: SnapshotArtifactWriteInputV1, signal?: AbortSignal): Promise<Receipt>;
  read(tenantId: string, artifact: Receipt, signal?: AbortSignal): Promise<Uint8Array>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

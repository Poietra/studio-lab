import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_SNAPSHOT_ARTIFACT_BYTES_V1 = 16 * 1024 * 1024;
export const LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 = "0".repeat(64);

const SNAPSHOT_SHA256_PATTERN_V1 = /^[0-9a-f]{64}$/;

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
  runtimeDigest: string;
  sourceDigest: string;
  versionId: string;
}>;

type SnapshotArtifactIdentityV1 = Pick<
  SnapshotArtifactReceiptV1,
  "profileDigest" | "resultDigest" | "runtimeConfigHash" | "runtimeDigest" | "sourceDigest"
>;

const SNAPSHOT_ARTIFACT_RECEIPT_FIELDS_V1 =
  "byteSize etag objectKey profileDigest resultDigest runtimeConfigHash runtimeDigest sourceDigest versionId".split(
    " ",
  ) as readonly (keyof SnapshotArtifactReceiptV1)[];

function snapshotDigestV1(value: unknown, name: string) {
  if (typeof value !== "string" || !SNAPSHOT_SHA256_PATTERN_V1.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

export function snapshotArtifactObjectKeyV1(tenantValue: string, identity: SnapshotArtifactIdentityV1) {
  const tenant = manimTenantIdSchema.safeParse(tenantValue);
  if (!tenant.success) throw new TypeError("Tenant ID is invalid.");
  const source = snapshotDigestV1(identity?.sourceDigest, "Snapshot source digest");
  const runtime = snapshotDigestV1(identity?.runtimeConfigHash, "Snapshot runtime-config hash");
  const profile = snapshotDigestV1(identity?.profileDigest, "Snapshot profile digest");
  const runtimeDigest = snapshotDigestV1(identity?.runtimeDigest, "Snapshot runtime digest");
  const result = snapshotDigestV1(identity?.resultDigest, "Snapshot result digest");
  if (runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
    return `tenants/${tenant.data}/snapshots/${source}/${runtime}/${profile}/${result}`;
  }
  return `tenants/${tenant.data}/snapshots/${source}/${runtime}/${profile}/${runtimeDigest}/${result}`;
}

export function parseSnapshotArtifactReceiptV1(tenantId: string, value: unknown): SnapshotArtifactReceiptV1 {
  if (!value || typeof value !== "object") throw new TypeError("Snapshot artifact receipt is invalid.");
  const candidate = value as Record<string, unknown>;
  const receipt = Object.fromEntries(
    SNAPSHOT_ARTIFACT_RECEIPT_FIELDS_V1.map((field) => [field, candidate[field]]),
  ) as SnapshotArtifactReceiptV1;
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

export function sameSnapshotArtifactReceiptV1(left: SnapshotArtifactReceiptV1, right: SnapshotArtifactReceiptV1) {
  return SNAPSHOT_ARTIFACT_RECEIPT_FIELDS_V1.every((field) => left[field] === right[field]);
}

export type SnapshotPublicationIdentityV1 = Readonly<{
  projectId: string;
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
  softDeleteProject(tenantId: string, projectId: string, signal?: AbortSignal): Promise<void>;
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
      runtimeDigest: string;
      sourceDigest: string;
    }>,
    signal?: AbortSignal,
  ): Promise<SnapshotArtifactReceiptV1>;
  read(tenantId: string, artifact: SnapshotArtifactReceiptV1, signal?: AbortSignal): Promise<Uint8Array>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

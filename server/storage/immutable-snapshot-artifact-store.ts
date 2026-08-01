import { manimTenantIdSchema } from "../manim-request-principal";
import {
  immutableObjectGenerationV1,
  immutableObjectKeyV1,
  parseImmutableObjectLocatorV1,
} from "./immutable-object-contract";
import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  snapshotArtifactObjectKeyV1,
} from "./snapshot-publication-repository";

export const IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1 = "poietra.immutable-snapshot-artifact-receipt" as const;
export const IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1 = "poietra.immutable-snapshot-artifact-deletion" as const;
export const IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1 = "application/octet-stream" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RECEIPT_FIELDS = ["byteSize", "etag", "identity", "objectGeneration", "objectKey", "schema", "version"] as const;
const LEGACY_IDENTITY_FIELDS = ["kind", "profileDigest", "resultDigest", "runtimeConfigHash", "sourceDigest"] as const;
const RUNTIME_IDENTITY_FIELDS = [...LEGACY_IDENTITY_FIELDS, "runtimeDigest"] as const;
const LEGACY_UPLOAD_FIELDS = ["kind", "profileDigest", "runtimeConfigHash", "sourceDigest"] as const;
const RUNTIME_UPLOAD_FIELDS = [...LEGACY_UPLOAD_FIELDS, "runtimeDigest"] as const;
const DELETION_FIELDS = ["identity", "objectGeneration", "objectKey", "schema", "tenantId", "version"] as const;

type SnapshotArtifactDigestFieldsV1 = Readonly<{
  profileDigest: string;
  resultDigest: string;
  runtimeConfigHash: string;
  sourceDigest: string;
}>;

export type ImmutableSnapshotArtifactIdentityV1 =
  | (SnapshotArtifactDigestFieldsV1 & Readonly<{ kind: "legacy" }>)
  | (SnapshotArtifactDigestFieldsV1 & Readonly<{ kind: "runtime-digest"; runtimeDigest: string }>);

type SnapshotArtifactUploadDigestFieldsV1 = Omit<SnapshotArtifactDigestFieldsV1, "resultDigest">;

export type ImmutableSnapshotArtifactUploadIdentityV1 =
  | (SnapshotArtifactUploadDigestFieldsV1 & Readonly<{ kind: "legacy" }>)
  | (SnapshotArtifactUploadDigestFieldsV1 & Readonly<{ kind: "runtime-digest"; runtimeDigest: string }>);

export type ImmutableSnapshotArtifactReceiptV1 = Readonly<{
  byteSize: number;
  etag: string;
  identity: ImmutableSnapshotArtifactIdentityV1;
  objectGeneration: string;
  objectKey: string;
  schema: typeof IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1;
  version: 1;
}>;

/** Provider-neutral payload suitable for a future database-owned tombstone. */
export type ImmutableSnapshotArtifactDeletionTargetV1 = Readonly<{
  identity: ImmutableSnapshotArtifactIdentityV1;
  objectGeneration: string;
  objectKey: string;
  schema: typeof IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1;
  tenantId: string;
  version: 1;
}>;

export type ImmutableSnapshotArtifactOrphanCandidateV1 = Readonly<{
  artifact: ImmutableSnapshotArtifactReceiptV1;
  lastModified: Date;
}>;

export type ImmutableSnapshotArtifactOrphanPageV1 = Readonly<{
  candidates: readonly ImmutableSnapshotArtifactOrphanCandidateV1[];
  nextCursor: string | null;
}>;

export interface ImmutableSnapshotArtifactStoreV1 {
  close(): Promise<void>;
  deletionTarget(
    tenantId: string,
    artifact: ImmutableSnapshotArtifactReceiptV1,
  ): ImmutableSnapshotArtifactDeletionTargetV1;
  deleteTarget(
    tenantId: string,
    target: ImmutableSnapshotArtifactDeletionTargetV1,
    signal?: AbortSignal,
  ): Promise<void>;
  head(
    tenantId: string,
    artifact: ImmutableSnapshotArtifactReceiptV1,
    signal?: AbortSignal,
  ): Promise<ImmutableSnapshotArtifactReceiptV1>;
  listOrphanCandidates(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ImmutableSnapshotArtifactOrphanPageV1>;
  put(
    tenantId: string,
    input: Readonly<{ bytes: Uint8Array; identity: ImmutableSnapshotArtifactUploadIdentityV1 }>,
    signal?: AbortSignal,
  ): Promise<ImmutableSnapshotArtifactReceiptV1>;
  read(tenantId: string, artifact: ImmutableSnapshotArtifactReceiptV1, signal?: AbortSignal): Promise<Uint8Array>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid.`);
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} is invalid.`);
  }
  return candidate;
}

export function immutableSnapshotArtifactTenantIdV1(value: unknown) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Immutable snapshot artifact tenant ID is invalid.");
  return parsed.data;
}

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function activeRuntimeDigest(value: unknown) {
  const runtimeDigest = digest(value, "Immutable snapshot runtime digest");
  if (runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
    throw new TypeError("The reserved legacy snapshot runtime digest is not an active runtime identity.");
  }
  return runtimeDigest;
}

function digestFields(candidate: Record<string, unknown>): SnapshotArtifactDigestFieldsV1 {
  return {
    profileDigest: digest(candidate.profileDigest, "Immutable snapshot profile digest"),
    resultDigest: digest(candidate.resultDigest, "Immutable snapshot result digest"),
    runtimeConfigHash: digest(candidate.runtimeConfigHash, "Immutable snapshot runtime-config hash"),
    sourceDigest: digest(candidate.sourceDigest, "Immutable snapshot source digest"),
  };
}

export function parseImmutableSnapshotArtifactIdentityV1(value: unknown): ImmutableSnapshotArtifactIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable snapshot artifact identity is invalid.");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "legacy") {
    const candidate = exactRecord(value, LEGACY_IDENTITY_FIELDS, "Immutable legacy snapshot identity");
    return { ...digestFields(candidate), kind };
  }
  if (kind === "runtime-digest") {
    const candidate = exactRecord(value, RUNTIME_IDENTITY_FIELDS, "Immutable runtime snapshot identity");
    return { ...digestFields(candidate), kind, runtimeDigest: activeRuntimeDigest(candidate.runtimeDigest) };
  }
  throw new TypeError("Immutable snapshot artifact identity is invalid.");
}

export function parseImmutableSnapshotArtifactUploadIdentityV1(
  value: unknown,
): ImmutableSnapshotArtifactUploadIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable snapshot artifact upload identity is invalid.");
  }
  const candidateValue = value as Record<string, unknown>;
  const kind = candidateValue.kind;
  if (kind !== "legacy" && kind !== "runtime-digest") {
    throw new TypeError("Immutable snapshot artifact upload identity is invalid.");
  }
  const candidate = exactRecord(
    value,
    kind === "legacy" ? LEGACY_UPLOAD_FIELDS : RUNTIME_UPLOAD_FIELDS,
    "Immutable snapshot artifact upload identity",
  );
  const shared = {
    profileDigest: digest(candidate.profileDigest, "Immutable snapshot profile digest"),
    runtimeConfigHash: digest(candidate.runtimeConfigHash, "Immutable snapshot runtime-config hash"),
    sourceDigest: digest(candidate.sourceDigest, "Immutable snapshot source digest"),
  };
  return kind === "legacy"
    ? { ...shared, kind }
    : { ...shared, kind, runtimeDigest: activeRuntimeDigest(candidate.runtimeDigest) };
}

export function completeImmutableSnapshotArtifactIdentityV1(
  uploadIdentity: unknown,
  resultDigestValue: unknown,
): ImmutableSnapshotArtifactIdentityV1 {
  const identity = parseImmutableSnapshotArtifactUploadIdentityV1(uploadIdentity);
  const resultDigest = digest(resultDigestValue, "Immutable snapshot result digest");
  return identity.kind === "legacy"
    ? { ...identity, resultDigest }
    : { ...identity, resultDigest, runtimeDigest: identity.runtimeDigest };
}

export function immutableSnapshotArtifactContentAddressedKeyV1(tenantValue: unknown, identityValue: unknown) {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  const identity = parseImmutableSnapshotArtifactIdentityV1(identityValue);
  return snapshotArtifactObjectKeyV1(tenantId, {
    ...identity,
    runtimeDigest: identity.kind === "legacy" ? LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 : identity.runtimeDigest,
  });
}

export function immutableSnapshotArtifactObjectKeyV1(
  tenantValue: unknown,
  identityValue: unknown,
  objectGenerationValue: unknown,
) {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  const identity = parseImmutableSnapshotArtifactIdentityV1(identityValue);
  const objectGeneration = immutableObjectGenerationV1(objectGenerationValue);
  return immutableObjectKeyV1({
    contentAddressedKey: immutableSnapshotArtifactContentAddressedKeyV1(tenantId, identity),
    contentDigest: identity.resultDigest,
    objectGeneration,
    tenantId,
  });
}

export function parseImmutableSnapshotArtifactObjectKeyV1(tenantValue: unknown, value: unknown) {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  if (typeof value !== "string") throw new TypeError("Immutable snapshot artifact object key is invalid.");
  const prefix = `tenants/${tenantId}/snapshots/`;
  if (!value.startsWith(prefix)) throw new TypeError("Immutable snapshot artifact object key is invalid.");
  const parts = value.slice(prefix.length).split("/");
  if ((parts.length !== 6 && parts.length !== 7) || parts.at(-2) !== "g") {
    throw new TypeError("Immutable snapshot artifact object key is invalid.");
  }
  const objectGeneration = immutableObjectGenerationV1(parts.at(-1));
  const identity = parseImmutableSnapshotArtifactIdentityV1(
    parts.length === 6
      ? {
          kind: "legacy",
          profileDigest: parts[2],
          resultDigest: parts[3],
          runtimeConfigHash: parts[1],
          sourceDigest: parts[0],
        }
      : {
          kind: "runtime-digest",
          profileDigest: parts[2],
          resultDigest: parts[4],
          runtimeConfigHash: parts[1],
          runtimeDigest: parts[3],
          sourceDigest: parts[0],
        },
  );
  const objectKey = immutableSnapshotArtifactObjectKeyV1(tenantId, identity, objectGeneration);
  if (objectKey !== value) throw new TypeError("Immutable snapshot artifact object key is invalid.");
  return { identity, objectGeneration, objectKey } as const;
}

function boundedEtag(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new TypeError("Immutable snapshot artifact ETag is invalid.");
  }
  return value;
}

function boundedByteSize(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
    throw new TypeError("Immutable snapshot artifact byte size is invalid.");
  }
  return value as number;
}

export function parseImmutableSnapshotArtifactReceiptV1(
  tenantValue: unknown,
  value: unknown,
): ImmutableSnapshotArtifactReceiptV1 {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  const candidate = exactRecord(value, RECEIPT_FIELDS, "Immutable snapshot artifact receipt");
  if (candidate.schema !== IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1 || candidate.version !== 1) {
    throw new TypeError("Immutable snapshot artifact receipt is invalid.");
  }
  const identity = parseImmutableSnapshotArtifactIdentityV1(candidate.identity);
  const locator = parseImmutableObjectLocatorV1(
    {
      contentAddressedKey: immutableSnapshotArtifactContentAddressedKeyV1(tenantId, identity),
      contentDigest: identity.resultDigest,
      tenantId,
    },
    { objectGeneration: candidate.objectGeneration, objectKey: candidate.objectKey },
  );
  return {
    byteSize: boundedByteSize(candidate.byteSize),
    etag: boundedEtag(candidate.etag),
    identity,
    ...locator,
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
    version: 1,
  };
}

export function immutableSnapshotArtifactMetadataV1(
  tenantValue: unknown,
  identityValue: unknown,
  objectGenerationValue: unknown,
) {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  const identity = parseImmutableSnapshotArtifactIdentityV1(identityValue);
  const objectGeneration = immutableObjectGenerationV1(objectGenerationValue);
  return {
    "artifact-schema": IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
    "identity-kind": identity.kind,
    "object-generation": objectGeneration,
    "profile-digest": identity.profileDigest,
    "result-digest": identity.resultDigest,
    "runtime-config-hash": identity.runtimeConfigHash,
    ...(identity.kind === "runtime-digest" ? { "runtime-digest": identity.runtimeDigest } : {}),
    "source-digest": identity.sourceDigest,
    "tenant-id": tenantId,
  } as const;
}

export function immutableSnapshotArtifactDeletionTargetV1(
  tenantValue: unknown,
  receiptValue: unknown,
): ImmutableSnapshotArtifactDeletionTargetV1 {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  const receipt = parseImmutableSnapshotArtifactReceiptV1(tenantId, receiptValue);
  return {
    identity: receipt.identity,
    objectGeneration: receipt.objectGeneration,
    objectKey: receipt.objectKey,
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1,
    tenantId,
    version: 1,
  };
}

export function parseImmutableSnapshotArtifactDeletionTargetV1(
  tenantValue: unknown,
  value: unknown,
): ImmutableSnapshotArtifactDeletionTargetV1 {
  const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
  const candidate = exactRecord(value, DELETION_FIELDS, "Immutable snapshot artifact deletion target");
  if (
    candidate.schema !== IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1 ||
    candidate.version !== 1 ||
    candidate.tenantId !== tenantId
  ) {
    throw new TypeError("Immutable snapshot artifact deletion target is invalid.");
  }
  const identity = parseImmutableSnapshotArtifactIdentityV1(candidate.identity);
  const objectGeneration = immutableObjectGenerationV1(candidate.objectGeneration);
  const objectKey = immutableSnapshotArtifactObjectKeyV1(tenantId, identity, objectGeneration);
  if (candidate.objectKey !== objectKey) throw new TypeError("Immutable snapshot artifact deletion target is invalid.");
  return {
    identity,
    objectGeneration,
    objectKey,
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1,
    tenantId,
    version: 1,
  };
}

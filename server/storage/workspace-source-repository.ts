import type { ManimProjectListView } from "../../src/render-pipeline/contracts";
import { immutableObjectKeyV1 } from "./immutable-object-contract";
import type { ProjectPngBlobReceiptV1 } from "./project-png-storage";
import {
  type ApplicationImmutableObjectLocatorV1,
  isApplicationImmutableLocatorV1,
  type ProviderVersionedObjectLocatorV1,
  sameStorageObjectLocatorV1,
  storageObjectLocatorIdentityV1,
  storageObjectLocatorV1,
} from "./storage-object-locator";

export const MAX_MANAGED_PROJECTS_PER_TENANT_V1 = 64;
export const MAX_MANIM_SOURCE_BYTES_V1 = 2 * 1024 * 1024;

export type SourceDigestV1 = string;

type SourceBlobReceiptFieldsV1 = Readonly<{
  byteSize: number;
  digest: SourceDigestV1;
  etag: string;
  objectKey: string;
}>;

export type VersionedSourceBlobReceiptV1 = SourceBlobReceiptFieldsV1 & ProviderVersionedObjectLocatorV1;
export type ImmutableSourceBlobReceiptLikeV1 = SourceBlobReceiptFieldsV1 & ApplicationImmutableObjectLocatorV1;
export type SourceBlobReceiptV1 = VersionedSourceBlobReceiptV1 | ImmutableSourceBlobReceiptLikeV1;

export type WorkspaceSourceHeadV1 = Readonly<{
  blob: SourceBlobReceiptV1;
  generation: bigint;
  projectId: string;
  sourcePath: string;
  tenantId: string;
}>;

export type WorkspaceSourceProjectV1 = Readonly<{
  createdAt: Date;
  name: string;
  projectId: string;
  tenantId: string;
  updatedAt: Date;
}>;

export type BlobDeletionV1 = Readonly<{
  blob: SourceBlobReceiptV1;
  deletionId: string;
  tenantId: string;
}>;

export type SourceBlobVersionV1 = Readonly<{
  blob: SourceBlobReceiptV1;
  lastModified: Date;
}>;

/** Opaque, store-owned position for a bounded source-version scan. */
export type SourceBlobVersionCursorV1 = string;

export type SourceBlobVersionPageV1 = Readonly<{
  nextCursor: SourceBlobVersionCursorV1 | null;
  versions: readonly SourceBlobVersionV1[];
}>;

export interface WorkspaceSourceRepositoryV1 {
  acknowledgeBlobDeletion(tenantId: string, deletionId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  compareAndSwapSource(
    input: Readonly<{
      candidate: SourceBlobReceiptV1;
      expectedDigest: SourceDigestV1;
      expectedGeneration: bigint;
      projectId: string;
      sourcePath: string;
      tenantId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<WorkspaceSourceHeadV1>;
  createManagedProject(
    input: Readonly<{
      name: string;
      projectPng?: ProjectPngBlobReceiptV1;
      projectId: string;
      source: Readonly<{ blob: SourceBlobReceiptV1; path: string }>;
      tenantId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<WorkspaceSourceProjectV1>;
  ensureTenant(tenantId: string, signal?: AbortSignal): Promise<void>;
  isBlobVersionPublished(tenantId: string, blob: SourceBlobReceiptV1, signal?: AbortSignal): Promise<boolean>;
  listProjects(tenantId: string, signal?: AbortSignal): Promise<ManimProjectListView>;
  listSourceHeads(tenantId: string, projectId: string, signal?: AbortSignal): Promise<readonly WorkspaceSourceHeadV1[]>;
  pendingBlobDeletions(tenantId: string, maximum: number, signal?: AbortSignal): Promise<readonly BlobDeletionV1[]>;
  queueOrphanedBlobDeletions(tenantId: string, graceMs: number, maximum: number, signal?: AbortSignal): Promise<number>;
  readProject(tenantId: string, projectId: string, signal?: AbortSignal): Promise<WorkspaceSourceProjectV1>;
  readSourceHead(
    tenantId: string,
    projectId: string,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSourceHeadV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
  renameProject(
    tenantId: string,
    projectId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSourceProjectV1>;
  softDeleteProject(tenantId: string, projectId: string, signal?: AbortSignal): Promise<void>;
  queueBlobDeletion(tenantId: string, blob: SourceBlobReceiptV1, signal?: AbortSignal): Promise<BlobDeletionV1 | null>;
}

export interface SourceContentBlobStoreV1 {
  close(): Promise<void>;
  deleteVersion(tenantId: string, blob: SourceBlobReceiptV1, signal?: AbortSignal): Promise<void>;
  listSourceVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: SourceBlobVersionCursorV1 | null,
    signal?: AbortSignal,
  ): Promise<SourceBlobVersionPageV1>;
  putSource(tenantId: string, source: string, signal?: AbortSignal): Promise<SourceBlobReceiptV1>;
  readSource(tenantId: string, blob: SourceBlobReceiptV1, signal?: AbortSignal): Promise<string>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export function assertSourceBlobReceiptV1(tenantId: string, value: SourceBlobReceiptV1): SourceBlobReceiptV1 {
  const digest = value?.digest;
  const baseKey = `tenants/${tenantId}/sources/${digest}`;
  let locator;
  try {
    locator = storageObjectLocatorV1(value);
  } catch {
    throw new TypeError("Source blob receipt is invalid.");
  }
  const expectedKey = isApplicationImmutableLocatorV1(locator)
    ? immutableObjectKeyV1({
        contentAddressedKey: baseKey,
        contentDigest: digest,
        objectLocatorToken: locator.objectGeneration,
        tenantId,
      })
    : baseKey;
  if (
    !/^[0-9a-f]{64}$/u.test(digest) ||
    value.objectKey !== expectedKey ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 ||
    value.byteSize > MAX_MANIM_SOURCE_BYTES_V1 ||
    typeof value.etag !== "string" ||
    value.etag.length < 1 ||
    Buffer.byteLength(value.etag, "utf8") > 512
  ) {
    throw new TypeError("Source blob receipt is invalid.");
  }
  const fields = { byteSize: value.byteSize, digest, etag: value.etag, objectKey: expectedKey };
  return isApplicationImmutableLocatorV1(locator)
    ? { ...fields, objectGeneration: locator.objectGeneration }
    : { ...fields, versionId: locator.versionId };
}

export function assertVersionedSourceBlobReceiptV1(
  tenantId: string,
  value: SourceBlobReceiptV1,
): VersionedSourceBlobReceiptV1 {
  const receipt = assertSourceBlobReceiptV1(tenantId, value);
  if ("objectGeneration" in receipt) throw new TypeError("A provider-versioned source blob receipt is required.");
  return receipt;
}

export function sameSourceBlobReceiptV1(left: SourceBlobReceiptV1, right: SourceBlobReceiptV1) {
  return (
    left.byteSize === right.byteSize &&
    left.digest === right.digest &&
    left.etag === right.etag &&
    left.objectKey === right.objectKey &&
    sameStorageObjectLocatorV1(left, right)
  );
}

export function sourceBlobLocatorIdentityV1(value: SourceBlobReceiptV1) {
  return storageObjectLocatorIdentityV1(value);
}

import type { ManimProjectListView } from "../../src/render-pipeline/contracts";

export const MAX_MANAGED_PROJECTS_PER_TENANT_V1 = 64;
export const MAX_MANIM_SOURCE_BYTES_V1 = 2 * 1024 * 1024;

export type SourceDigestV1 = string;

export type SourceBlobReceiptV1 = Readonly<{
  byteSize: number;
  digest: SourceDigestV1;
  etag: string;
  objectKey: string;
  versionId: string;
}>;

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
      projectId: string;
      source: Readonly<{ blob: SourceBlobReceiptV1; path: string }>;
      tenantId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<WorkspaceSourceProjectV1>;
  enqueueOrphanBlobDeletions(cutoff: Date, maximum: number, signal?: AbortSignal): Promise<readonly BlobDeletionV1[]>;
  ensureTenant(tenantId: string, signal?: AbortSignal): Promise<void>;
  isBlobVersionPublished(tenantId: string, blob: SourceBlobReceiptV1, signal?: AbortSignal): Promise<boolean>;
  listProjects(tenantId: string, signal?: AbortSignal): Promise<ManimProjectListView>;
  listSourceHeads(tenantId: string, projectId: string, signal?: AbortSignal): Promise<readonly WorkspaceSourceHeadV1[]>;
  pendingBlobDeletions(maximum: number, signal?: AbortSignal): Promise<readonly BlobDeletionV1[]>;
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
    signal?: AbortSignal,
  ): Promise<readonly SourceBlobVersionV1[]>;
  putSource(tenantId: string, source: string, signal?: AbortSignal): Promise<SourceBlobReceiptV1>;
  readSource(tenantId: string, blob: SourceBlobReceiptV1, signal?: AbortSignal): Promise<string>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

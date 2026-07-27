import type { SourceContentBlobStoreV1, WorkspaceSourceRepositoryV1 } from "./workspace-source-repository";

export async function runSourceBlobGcV1(
  options: Readonly<{
    blobs: SourceContentBlobStoreV1;
    cutoff: Date;
    maximum: number;
    repository: WorkspaceSourceRepositoryV1;
    signal?: AbortSignal;
    tenantId: string;
  }>,
) {
  if (!Number.isSafeInteger(options.maximum) || options.maximum <= 0 || options.maximum > 256) {
    throw new RangeError("maximum must be an integer between 1 and 256.");
  }
  options.signal?.throwIfAborted();
  const repositoryOrphans = await options.repository.enqueueOrphanBlobDeletions(
    options.cutoff,
    options.maximum,
    options.signal,
  );
  const versions = await options.blobs.listSourceVersions(
    options.tenantId,
    options.cutoff,
    options.maximum,
    options.signal,
  );
  let queued = repositoryOrphans.length;
  for (const { blob } of versions) {
    options.signal?.throwIfAborted();
    if (await options.repository.isBlobVersionPublished(options.tenantId, blob, options.signal)) continue;
    if (await options.repository.queueBlobDeletion(options.tenantId, blob, options.signal)) queued += 1;
  }

  const pending = await options.repository.pendingBlobDeletions(options.maximum, options.signal);
  let deleted = 0;
  for (const deletion of pending) {
    options.signal?.throwIfAborted();
    await options.blobs.deleteVersion(deletion.tenantId, deletion.blob, options.signal);
    await options.repository.acknowledgeBlobDeletion(deletion.tenantId, deletion.deletionId, options.signal);
    deleted += 1;
  }
  return { deleted, examined: versions.length, queued } as const;
}

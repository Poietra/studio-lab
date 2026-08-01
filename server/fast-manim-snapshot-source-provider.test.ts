import { describe, expect, it, vi } from "vitest";

import { DurableFastManimSnapshotSourceProviderV1 } from "./fast-manim-snapshot-source-provider";
import type {
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

const digest = "a".repeat(64);
const blob = {
  byteSize: 15,
  digest,
  etag: '"source"',
  objectKey: `tenants/tenant-a/sources/${digest}`,
  versionId: "source-version",
} as const;

function head(generation = 4n): WorkspaceSourceHeadV1 {
  return { blob, generation, projectId: "project-a", sourcePath: "scene.py", tenantId: "tenant-a" };
}

function provider(readSourceHead: WorkspaceSourceRepositoryV1["readSourceHead"]) {
  const blobs = {
    readSource: vi.fn(async () => "class ExampleScene: pass\n"),
  } as unknown as SourceContentBlobStoreV1;
  const repository = { readSourceHead } as unknown as WorkspaceSourceRepositoryV1;
  return new DurableFastManimSnapshotSourceProviderV1({
    blobs,
    projectId: "project-a",
    repository,
    tenantId: "tenant-a",
  });
}

describe("durable fast-manim snapshot source provider", () => {
  it("returns one exact version-addressed source generation", async () => {
    const readSourceHead = vi.fn(async () => head());
    await expect(provider(readSourceHead).readVerified("scene.py")).resolves.toEqual({
      hash: digest,
      source: "class ExampleScene: pass\n",
      sourceGeneration: 4n,
      versionToken: `4:${digest}:version:source-version`,
    });
    expect(readSourceHead).toHaveBeenCalledTimes(2);
  });

  it("rejects a concurrent source CAS even when the content digest is unchanged", async () => {
    const readSourceHead = vi.fn().mockResolvedValueOnce(head()).mockResolvedValueOnce(head(5n));
    await expect(provider(readSourceHead).readVerified("scene.py")).rejects.toMatchObject({ status: 409 });
  });
});

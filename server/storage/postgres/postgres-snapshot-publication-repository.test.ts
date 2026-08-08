import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ImmutableSnapshotArtifactReceiptV1 } from "../immutable-snapshot-artifact-store";
import type {
  SnapshotPublicationIdentityV1,
  VersionedSnapshotArtifactReceiptV1,
} from "../snapshot-publication-repository";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM } from "./immutable-object-generation-schema";
import { PROJECT_PNG_MIGRATION_V5_CHECKSUM } from "./postgres-project-png-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";
import {
  PostgresSnapshotPublicationRepositoryV1,
  SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM,
} from "./postgres-snapshot-publication-repository";
import { SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_CHECKSUM } from "./snapshot-publication-tombstone-retention-schema";
import { SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_CHECKSUM } from "./snapshot-runtime-config-head-schema";
import { SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM } from "./snapshot-runtime-digest-schema";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const SOURCE_PATH = "scenes/main.py";
const SCENE = "MainScene";
const PUBLICATION_ID = "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a1";
const RETRY_PUBLICATION_ID = "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8a2";
const DELETION_ID = "87654321-4321-4321-8321-cba987654321";
const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
const RUNTIME = "c".repeat(64);
const RUNTIME_DIGEST = "1".repeat(64);
const OTHER_RUNTIME_DIGEST = "2".repeat(64);
const PROFILE = "d".repeat(64);
const RESULT = "e".repeat(64);
const SNAPSHOT = "f".repeat(64);
const OBJECT_GENERATION = "00000000-0000-4000-8000-000000000001";
const PROJECT_PNG_DIGEST = "9".repeat(64);
const PROJECT_PNG_OBJECT_KEY = `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${PROJECT_PNG_DIGEST}`;

const identity: SnapshotPublicationIdentityV1 = {
  projectId: PROJECT,
  runtimeConfigHash: RUNTIME,
  runtimeDigest: RUNTIME_DIGEST,
  sceneName: SCENE,
  sourcePath: SOURCE_PATH,
  tenantId: TENANT,
};

function artifact(
  sourceDigest = SOURCE_A,
  runtimeDigest = RUNTIME_DIGEST,
  runtimeConfigHash = RUNTIME,
): VersionedSnapshotArtifactReceiptV1 {
  return {
    byteSize: 128,
    etag: "artifact-etag",
    objectKey: `tenants/${TENANT}/snapshots/${sourceDigest}/${runtimeConfigHash}/${PROFILE}/${runtimeDigest}/${RESULT}`,
    profileDigest: PROFILE,
    resultDigest: RESULT,
    runtimeConfigHash,
    runtimeDigest,
    sourceDigest,
    versionId: "artifact-version",
  };
}

function immutableArtifact(): ImmutableSnapshotArtifactReceiptV1 {
  return {
    byteSize: 128,
    etag: "immutable-artifact-etag",
    identity: {
      kind: "runtime-digest",
      profileDigest: PROFILE,
      resultDigest: RESULT,
      runtimeConfigHash: RUNTIME,
      runtimeDigest: RUNTIME_DIGEST,
      sourceDigest: SOURCE_A,
    },
    objectGeneration: OBJECT_GENERATION,
    objectKey: `${artifact().objectKey}/g/${OBJECT_GENERATION}`,
    schema: "poietra.immutable-snapshot-artifact-receipt",
    version: 1,
  };
}

function artifactRow(value = artifact()) {
  return {
    artifact_byte_size: value.byteSize,
    artifact_etag: value.etag,
    artifact_object_key: value.objectKey,
    artifact_object_generation: null,
    artifact_profile_digest: value.profileDigest,
    artifact_result_digest: value.resultDigest,
    artifact_runtime_config_hash: value.runtimeConfigHash,
    artifact_runtime_digest: value.runtimeDigest,
    artifact_source_digest: value.sourceDigest,
    artifact_tenant_id: TENANT,
    artifact_version_id: value.versionId,
  };
}

function immutableArtifactRow(value = immutableArtifact()) {
  return {
    artifact_byte_size: value.byteSize,
    artifact_etag: value.etag,
    artifact_object_generation: value.objectGeneration,
    artifact_object_key: value.objectKey,
    artifact_profile_digest: value.identity.profileDigest,
    artifact_result_digest: value.identity.resultDigest,
    artifact_runtime_config_hash: value.identity.runtimeConfigHash,
    artifact_runtime_digest: value.identity.kind === "legacy" ? "0".repeat(64) : value.identity.runtimeDigest,
    artifact_source_digest: value.identity.sourceDigest,
    artifact_tenant_id: TENANT,
    artifact_version_id: null,
  };
}

function deletionRow(value = artifact(), deletedAt: Date | null = null) {
  return {
    ...artifactRow(value),
    deleted_at: deletedAt,
    deletion_id: DELETION_ID,
  };
}

function sourceRow(sourceDigest = SOURCE_A, generation = "4") {
  return {
    digest: sourceDigest,
    generation,
    project_id: PROJECT,
    source_path: SOURCE_PATH,
    tenant_id: TENANT,
  };
}

function projectPngHeadRow(generation = "1") {
  return {
    byte_size: 256,
    digest: PROJECT_PNG_DIGEST,
    etag: '"project-png-etag"',
    generation,
    object_generation: null,
    object_key: PROJECT_PNG_OBJECT_KEY,
    project_id: PROJECT,
    tenant_id: TENANT,
    version_id: "project-png-version",
  };
}

function publicationRow(
  options: Readonly<{ generation?: string; sourceDigest?: string; sourceGeneration?: string }> = {},
) {
  const storedArtifact = artifact(options.sourceDigest);
  return {
    ...artifactRow(storedArtifact),
    project_id: PROJECT,
    publication_generation: options.generation ?? "2",
    publication_id: PUBLICATION_ID,
    publication_profile_digest: storedArtifact.profileDigest,
    publication_result_digest: storedArtifact.resultDigest,
    publication_runtime_config_hash: storedArtifact.runtimeConfigHash,
    publication_runtime_digest: storedArtifact.runtimeDigest,
    publication_source_digest: storedArtifact.sourceDigest,
    published_at: new Date("2026-07-28T00:00:00.000Z"),
    request_id: "request-a",
    scene_name: SCENE,
    snapshot_hash: SNAPSHOT,
    source_generation: options.sourceGeneration ?? "4",
    source_path: SOURCE_PATH,
    tenant_id: TENANT,
  };
}

function sceneHeadRow(
  options: Readonly<{
    generation?: string;
    publication?: ReturnType<typeof publicationRow> | null;
  }> = {},
) {
  const publication = options.publication === undefined ? publicationRow() : options.publication;
  return {
    ...(publication ?? {}),
    head_generation: options.generation ?? "2",
    head_project_id: PROJECT,
    head_publication_id: publication?.publication_id ?? null,
    head_runtime_config_hash: RUNTIME,
    head_runtime_digest: RUNTIME_DIGEST,
    head_scene_name: SCENE,
    head_source_path: SOURCE_PATH,
    head_tenant_id: TENANT,
  };
}

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakePool(handle: (text: string, values: readonly unknown[]) => Promise<QueryResult> | QueryResult) {
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config(")) {
      return { rowCount: null, rows: [] };
    }
    if (text.trim().startsWith("SELECT pg_advisory_xact_lock(hashtextextended")) {
      return { rowCount: 1, rows: [{}] };
    }
    return handle(text, values);
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
    options: {
      connectionTimeoutMillis: 5_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  } as unknown as Pool;
  return { pool, query, release };
}

function publishInput(sourceDigest = SOURCE_A, sourceGeneration = 4n) {
  return {
    ...identity,
    artifact: artifact(sourceDigest),
    expectedSourceDigest: sourceDigest,
    expectedSourceGeneration: sourceGeneration,
    publicationId: PUBLICATION_ID,
    requestId: "request-a",
    snapshotHash: SNAPSHOT,
  };
}

describe("PostgresSnapshotPublicationRepositoryV1", () => {
  it("rolls back project deletion without mutations when non-snapshot work is retained", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_projects") && text.includes("FOR UPDATE")) {
        expect(values).toEqual([TENANT, PROJECT]);
        return { rowCount: 1, rows: [{ project_id: PROJECT }] };
      }
      if (text.startsWith("SELECT 1") && text.includes("FROM public.workspace_project_references")) {
        expect(text).toContain("reference_kind <> 'snapshot-publication'");
        expect(values).toEqual([TENANT, PROJECT]);
        return { rowCount: 1, rows: [{ retained: true }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.softDeleteProject(TENANT, PROJECT)).rejects.toMatchObject({ status: 409 });

    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("UPDATE public.snapshot_scene_heads");
    expect(sql).not.toContain("DELETE FROM public.workspace_project_references");
    expect(sql).not.toContain("FROM public.project_png_heads");
    expect(sql).not.toContain("DELETE FROM public.project_png_heads");
    expect(sql).not.toContain("UPDATE public.project_png_generations");
    expect(sql).not.toContain("UPDATE public.workspace_projects");
    expect(fixture.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
  });

  it("atomically tombstones snapshot heads, observes no PNG head, and deletes the project", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_projects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ project_id: PROJECT }] };
      }
      if (text.startsWith("SELECT 1") && text.includes("FROM public.workspace_project_references")) {
        expect(text).toContain("reference_kind <> 'snapshot-publication'");
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) {
        expect(values).toEqual([TENANT, PROJECT]);
        return { rowCount: 2, rows: [] };
      }
      if (text.startsWith("DELETE FROM public.workspace_project_references")) {
        expect(text).toContain("reference_kind = 'snapshot-publication'");
        expect(values).toEqual([TENANT, PROJECT]);
        return { rowCount: 2, rows: [] };
      }
      if (text.startsWith("SELECT h.tenant_id")) {
        expect(text).toContain("FOR UPDATE OF h");
        expect(values).toEqual([TENANT, PROJECT]);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.workspace_projects")) {
        expect(values).toEqual([TENANT, PROJECT]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.softDeleteProject(TENANT, PROJECT)).resolves.toBeUndefined();

    const sql = fixture.query.mock.calls.map(([text]) => text);
    const mutationOrder = [
      "UPDATE public.snapshot_scene_heads",
      "DELETE FROM public.workspace_project_references",
      "SELECT h.tenant_id",
      "UPDATE public.workspace_projects",
    ].map((prefix) => sql.findIndex((text) => text.startsWith(prefix)));
    expect(mutationOrder).toEqual([...mutationOrder].sort((left, right) => left - right));
    expect(mutationOrder.every((index) => index >= 0)).toBe(true);
    expect(fixture.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });

  it("rolls back a detached PNG head when the final project tombstone fails", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_projects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ project_id: PROJECT }] };
      }
      if (text.startsWith("SELECT 1") && text.includes("FROM public.workspace_project_references")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) return { rowCount: 1, rows: [] };
      if (text.startsWith("DELETE FROM public.workspace_project_references")) return { rowCount: 1, rows: [] };
      if (text.startsWith("SELECT h.tenant_id")) {
        expect(text).toContain("FOR UPDATE OF h");
        return { rowCount: 1, rows: [projectPngHeadRow()] };
      }
      if (text.startsWith("DELETE FROM public.project_png_heads")) {
        expect(values).toEqual([TENANT, PROJECT, "1", PROJECT_PNG_DIGEST]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("UPDATE public.project_png_generations")) {
        expect(text).toContain("NOT EXISTS");
        expect(text).toContain("FROM public.render_sessions");
        expect(values).toEqual([TENANT, PROJECT, "1", PROJECT_PNG_DIGEST]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("UPDATE public.workspace_projects")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.softDeleteProject(TENANT, PROJECT)).rejects.toThrow(
      "The locked workspace project changed unexpectedly.",
    );

    const sql = fixture.query.mock.calls.map(([text]) => text);
    const mutationOrder = [
      "UPDATE public.snapshot_scene_heads",
      "DELETE FROM public.workspace_project_references",
      "DELETE FROM public.project_png_heads",
      "UPDATE public.project_png_generations",
      "UPDATE public.workspace_projects",
    ].map((prefix) => sql.findIndex((text) => text.startsWith(prefix)));
    expect(mutationOrder).toEqual([...mutationOrder].sort((left, right) => left - right));
    expect(mutationOrder.every((index) => index >= 0)).toBe(true);
    expect(fixture.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(sql).not.toContain("COMMIT");
  });

  it("rejects a stale locked source before registering an artifact or publication", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        expect(text).toContain("FOR UPDATE OF h, project");
        return { rowCount: 1, rows: [sourceRow(SOURCE_A, "5")] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.publish(publishInput())).resolves.toEqual({ kind: "source-stale" });

    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("INSERT INTO public.snapshot_artifact_objects");
    expect(sql).not.toContain("INSERT INTO public.snapshot_publications");
    expect(fixture.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });

  it("rejects an artifact from another runtime before opening a transaction", async () => {
    const fixture = fakePool((text) => {
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.publish({ ...publishInput(), artifact: artifact(SOURCE_A, OTHER_RUNTIME_DIGEST) }),
    ).rejects.toThrow("does not belong to the active runtime");
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("rejects an artifact from another runtime configuration before opening a transaction", async () => {
    const fixture = fakePool((text) => {
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.publish({ ...publishInput(), artifact: artifact(SOURCE_A, RUNTIME_DIGEST, "9".repeat(64)) }),
    ).rejects.toThrow("does not belong to the active runtime configuration");
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("keys current Scene heads by the active runtime digest and configuration", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        expect(text).toContain("h.runtime_digest = $5");
        expect(text).toContain("h.runtime_config_hash = $6");
        expect(values).toEqual([TENANT, PROJECT, SOURCE_PATH, SCENE, OTHER_RUNTIME_DIGEST, RUNTIME]);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.readCurrent({ ...identity, runtimeDigest: OTHER_RUNTIME_DIGEST })).resolves.toEqual({
      kind: "missing",
    });
  });

  it("increments a tombstoned Scene head instead of resetting its generation", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("SELECT 1 FROM public.snapshot_artifact_deletions")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.snapshot_artifact_objects")) {
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        return { rowCount: 1, rows: [sceneHeadRow({ generation: "7", publication: null })] };
      }
      if (text.startsWith("WITH inserted AS")) {
        expect(values[6]).toBe("8");
        return { rowCount: 1, rows: [publicationRow({ generation: "8" })] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) {
        expect(values).toEqual([
          TENANT,
          PROJECT,
          SOURCE_PATH,
          SCENE,
          RUNTIME_DIGEST,
          RUNTIME,
          "8",
          PUBLICATION_ID,
          "7",
          null,
        ]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.workspace_project_references")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    const result = await repository.publish(publishInput());

    expect(result.kind).toBe("published");
    if (result.kind === "published") expect(result.publication.generation).toBe(8n);
    expect(fixture.query.mock.calls.map(([text]) => text).join("\n")).not.toContain(
      "DELETE FROM public.workspace_project_references",
    );
  });

  it("returns an exact locked publication retry without consuming a generation or publication ID", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("SELECT 1 FROM public.snapshot_artifact_deletions")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.snapshot_artifact_objects")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        return { rowCount: 1, rows: [sceneHeadRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    const result = await repository.publish({ ...publishInput(), publicationId: RETRY_PUBLICATION_ID });

    expect(result).toMatchObject({
      kind: "published",
      publication: { generation: 2n, publicationId: PUBLICATION_ID, publishedAt: new Date("2026-07-28T00:00:00Z") },
    });
    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("INSERT INTO public.snapshot_publications");
    expect(sql).not.toContain("UPDATE public.snapshot_scene_heads");
    expect(sql).not.toContain("INSERT INTO public.workspace_project_references");
    expect(sql).not.toContain("DELETE FROM public.workspace_project_references");
  });

  it("keeps a legacy row canonical when an immutable upload has the same content", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_source_heads h")) return { rowCount: 1, rows: [sourceRow()] };
      if (text.includes("SELECT 1 FROM public.snapshot_artifact_deletions")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.snapshot_artifact_objects")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        return { rowCount: 1, rows: [sceneHeadRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    const result = await repository.publish({
      ...publishInput(),
      artifact: immutableArtifact(),
      publicationId: RETRY_PUBLICATION_ID,
    });

    expect(result).toMatchObject({
      kind: "published",
      publication: { artifact: { versionId: "artifact-version" }, publicationId: PUBLICATION_ID },
    });
    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("INSERT INTO public.snapshot_publications");
  });

  it("rolls back when an immutable artifact identity resolves to different metadata", async () => {
    const conflicting = artifactRow({ ...artifact(), etag: "different-etag" });
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("SELECT 1 FROM public.snapshot_artifact_deletions")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.snapshot_artifact_objects")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        return { rowCount: 1, rows: [conflicting] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.publish(publishInput())).rejects.toThrow(
      "stored snapshot artifact metadata conflicts with its immutable identity",
    );

    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("INSERT INTO public.snapshot_publications");
    expect(fixture.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
  });

  it("does not reuse an identical result digest registered by another runtime", async () => {
    const otherRuntimeRow = artifactRow(artifact(SOURCE_A, OTHER_RUNTIME_DIGEST));
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("SELECT 1 FROM public.snapshot_artifact_deletions")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.snapshot_artifact_objects")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        expect(text).toContain("a.result_digest = $2 AND a.runtime_digest = $3");
        expect(values.slice(0, 3)).toEqual([TENANT, RESULT, RUNTIME_DIGEST]);
        return { rowCount: 1, rows: [otherRuntimeRow] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.publish(publishInput())).rejects.toThrow(
      "stored snapshot artifact metadata conflicts with its immutable identity",
    );
  });

  it("tombstones only the stale publication generation and releases its project reference", async () => {
    const stalePublication = publicationRow({ sourceDigest: SOURCE_A, sourceGeneration: "4" });
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow(SOURCE_B, "5")] };
      }
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        return { rowCount: 1, rows: [sceneHeadRow({ generation: "2", publication: stalePublication })] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) {
        expect(values).toEqual([TENANT, PROJECT, SOURCE_PATH, SCENE, RUNTIME_DIGEST, RUNTIME, "2", PUBLICATION_ID]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("DELETE FROM public.workspace_project_references")) {
        expect(values).toEqual([TENANT, PROJECT, PUBLICATION_ID]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.readCurrent(identity)).resolves.toEqual({ generation: 2n, kind: "stale" });
  });

  it("cannot clear a newer Scene publication with an older generation", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        return {
          rowCount: 1,
          rows: [sceneHeadRow({ generation: "3", publication: publicationRow({ generation: "3" }) })],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.clearHeadIfGeneration(identity, 2n)).resolves.toBe(false);

    expect(fixture.query.mock.calls.map(([text]) => text).join("\n")).not.toContain(
      "UPDATE public.snapshot_scene_heads",
    );
  });

  it("confirms both the persisted publication and its current source head", async () => {
    const stored = publicationRow();
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("FROM public.snapshot_scene_heads h")) {
        return { rowCount: 1, rows: [sceneHeadRow({ publication: stored })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.confirmCurrent({
        ...identity,
        artifact: artifact(),
        generation: 2n,
        publicationId: PUBLICATION_ID,
        publishedAt: stored.published_at,
        requestId: "request-a",
        snapshotHash: SNAPSHOT,
        sourceGeneration: 4n,
      }),
    ).resolves.toBe(true);
  });

  it("uses only the exact current artifact lookup and verifies every directly required migration", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        expect(text).toContain("source.generation = p.source_generation");
        expect(values).toEqual([
          TENANT,
          RESULT,
          SOURCE_A,
          RUNTIME,
          PROFILE,
          RUNTIME_DIGEST,
          artifact().objectKey,
          "artifact-version",
          null,
          "artifact-etag",
          128,
        ]);
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("poietra_schema_migrations")) {
        expect(text).toContain("version IN (3, 5, 6, 10, 20, 25, 27)");
        expect(values).toEqual([]);
        return {
          rowCount: 7,
          rows: [
            { checksum: SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM, version: 3 },
            { checksum: PROJECT_PNG_MIGRATION_V5_CHECKSUM, version: 5 },
            { checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM, version: 6 },
            { checksum: SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM, version: 10 },
            { checksum: IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM, version: 20 },
            { checksum: SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_CHECKSUM, version: 25 },
            { checksum: SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_CHECKSUM, version: 27 },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.isArtifactPublished(TENANT, artifact())).resolves.toBe(true);
    await expect(repository.ready()).resolves.toBe(true);
  });

  it("looks up an immutable current artifact with an exact generation locator", async () => {
    const candidate = immutableArtifact();
    const fixture = fakePool((text, values) => {
      if (!text.includes("FROM public.snapshot_artifact_objects a")) throw new Error(`Unexpected query: ${text}`);
      expect(text).toContain("a.object_generation IS NOT DISTINCT FROM $9::uuid");
      expect(values).toEqual([
        TENANT,
        RESULT,
        SOURCE_A,
        RUNTIME,
        PROFILE,
        RUNTIME_DIGEST,
        candidate.objectKey,
        null,
        OBJECT_GENERATION,
        candidate.etag,
        candidate.byteSize,
      ]);
      return { rowCount: 1, rows: [immutableArtifactRow(candidate)] };
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.isArtifactPublished(TENANT, candidate)).resolves.toBe(true);
  });

  it.each([
    ["mixed", { ...immutableArtifactRow(), artifact_version_id: "also-versioned" }],
    ["missing", { ...immutableArtifactRow(), artifact_object_generation: null }],
  ])("fails closed on a %s stored artifact locator", async (_name, row) => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.snapshot_artifact_objects a")) return { rowCount: 1, rows: [row] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.isArtifactPublished(TENANT, immutableArtifact())).rejects.toThrow(/ambiguous/i);
  });

  it("is not ready when any directly required migration is missing", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("poietra_schema_migrations")) {
        return {
          rowCount: 4,
          rows: [
            { checksum: SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM, version: 3 },
            { checksum: PROJECT_PNG_MIGRATION_V5_CHECKSUM, version: 5 },
            { checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM, version: 6 },
            { checksum: SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM, version: 10 },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(false);
  });

  it("uses the deletion lock during publication and refuses an already queued object version", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_source_heads h")) {
        return { rowCount: 1, rows: [sourceRow()] };
      }
      if (text.includes("SELECT 1 FROM public.snapshot_artifact_deletions")) {
        return { rowCount: 1, rows: [{}] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.publish(publishInput())).rejects.toThrow("candidate is no longer available");

    const domainCalls = fixture.query.mock.calls.filter(([text]) => !text.startsWith("SELECT set_config("));
    expect(domainCalls[1]).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`snapshot-artifact:${TENANT}:${RUNTIME_DIGEST}:${RESULT}`],
    ]);
    expect(fixture.query.mock.calls.map(([text]) => text).join("\n")).not.toContain(
      "INSERT INTO public.snapshot_artifact_objects",
    );
  });

  it("refuses to queue an exact artifact while a fresh Scene head publishes it", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("JOIN public.snapshot_publications p")) {
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("FROM public.snapshot_artifact_deletions d")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueArtifactDeletion(TENANT, artifact())).resolves.toBeNull();

    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("DELETE FROM public.snapshot_publications");
    expect(sql).not.toContain("INSERT INTO public.snapshot_artifact_deletions");
  });

  it.each([
    ["registered artifact", true],
    ["raw upload orphan", false],
  ])("queues a non-current %s without touching unrelated metadata", async (_name, registered) => {
    const fixture = fakePool((text) => {
      if (text.includes("JOIN public.snapshot_publications p")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        return { rowCount: registered ? 1 : 0, rows: registered ? [artifactRow()] : [] };
      }
      if (text.includes("FROM public.snapshot_artifact_deletions d")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) return { rowCount: 1, rows: [] };
      if (text.startsWith("DELETE FROM public.workspace_project_references")) return { rowCount: 1, rows: [] };
      if (text.startsWith("DELETE FROM public.snapshot_publications")) return { rowCount: 1, rows: [] };
      if (text.startsWith("DELETE FROM public.snapshot_artifact_objects")) {
        return { rowCount: registered ? 1 : 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.snapshot_artifact_deletions")) {
        return { rowCount: 1, rows: [deletionRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueArtifactDeletion(TENANT, artifact())).resolves.toEqual({
      artifact: artifact(),
      deletionId: DELETION_ID,
      tenantId: TENANT,
    });

    const sql = fixture.query.mock.calls.map(([text]) => text);
    const ordered = [
      "UPDATE public.snapshot_scene_heads",
      "DELETE FROM public.workspace_project_references",
      "DELETE FROM public.snapshot_publications",
      "DELETE FROM public.snapshot_artifact_objects",
      "INSERT INTO public.snapshot_artifact_deletions",
    ].map((prefix) => sql.findIndex((text) => text.startsWith(prefix)));
    if (registered) {
      expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
      expect(ordered.every((index) => index >= 0)).toBe(true);
    } else {
      expect(ordered.slice(0, 4)).toEqual([-1, -1, -1, -1]);
      expect(ordered[4]).toBeGreaterThanOrEqual(0);
    }
  });

  it("queues an immutable duplicate without removing canonical legacy metadata", async () => {
    const candidate = immutableArtifact();
    const fixture = fakePool((text, values) => {
      if (text.includes("JOIN public.snapshot_publications p")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.snapshot_artifact_objects a")) return { rowCount: 1, rows: [artifactRow()] };
      if (text.includes("FROM public.snapshot_artifact_deletions d")) {
        expect(values).toEqual([TENANT, candidate.objectKey, null, OBJECT_GENERATION]);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) return { rowCount: 0, rows: [] };
      if (text.startsWith("DELETE FROM public.workspace_project_references")) return { rowCount: 0, rows: [] };
      if (text.startsWith("DELETE FROM public.snapshot_publications")) return { rowCount: 0, rows: [] };
      if (text.startsWith("DELETE FROM public.snapshot_artifact_objects")) {
        expect(text).toContain("object_generation IS NOT DISTINCT FROM $9::uuid");
        expect(values?.[8]).toBe(OBJECT_GENERATION);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.snapshot_artifact_deletions")) {
        expect(text).toContain("object_generation");
        expect(values?.[9]).toBe(OBJECT_GENERATION);
        return {
          rowCount: 1,
          rows: [{ ...immutableArtifactRow(candidate), deleted_at: null, deletion_id: DELETION_ID }],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueArtifactDeletion(TENANT, candidate)).resolves.toEqual({
      artifact: candidate,
      deletionId: DELETION_ID,
      tenantId: TENANT,
    });
    const sql = fixture.query.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toContain("DELETE FROM public.snapshot_publications");
    expect(sql).not.toContain("DELETE FROM public.snapshot_artifact_objects");
  });

  it("rejects conflicting queued metadata and treats an acknowledged exact receipt as complete", async () => {
    let queued = deletionRow({ ...artifact(), etag: "conflicting-etag" });
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.snapshot_artifact_objects a")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.snapshot_artifact_deletions d")) return { rowCount: 1, rows: [queued] };
      if (text.includes("JOIN public.snapshot_publications p")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueArtifactDeletion(TENANT, artifact())).rejects.toThrow("conflicts");

    queued = deletionRow(artifact(), new Date("2026-07-28T01:00:00.000Z"));
    await expect(repository.queueArtifactDeletion(TENANT, artifact())).resolves.toBeNull();
  });

  it("does not let an acknowledged older version block a re-upload of the same digest", async () => {
    const replacement = { ...artifact(), versionId: "version-2" };
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.snapshot_artifact_objects a")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.snapshot_artifact_deletions d")) {
        expect(values).toEqual([TENANT, replacement.objectKey, replacement.versionId, null]);
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("JOIN public.snapshot_publications p")) return { rowCount: 0, rows: [] };
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) return { rowCount: 0, rows: [] };
      if (text.startsWith("DELETE FROM public.workspace_project_references")) return { rowCount: 0, rows: [] };
      if (text.startsWith("DELETE FROM public.snapshot_publications")) return { rowCount: 0, rows: [] };
      if (text.startsWith("DELETE FROM public.snapshot_artifact_objects")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.snapshot_artifact_deletions")) {
        return { rowCount: 1, rows: [deletionRow(replacement)] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueArtifactDeletion(TENANT, replacement)).resolves.toMatchObject({
      artifact: replacement,
      tenantId: TENANT,
    });
  });

  it("lists a bounded tenant queue and acknowledges one deletion idempotently", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.snapshot_artifact_deletions d")) {
        expect(values).toEqual([TENANT, 2]);
        return { rowCount: 1, rows: [deletionRow()] };
      }
      if (text.startsWith("UPDATE public.snapshot_artifact_deletions")) {
        expect(values).toEqual([TENANT, DELETION_ID]);
        expect(text).toContain("COALESCE(deleted_at, clock_timestamp())");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.pendingArtifactDeletions(TENANT, 2)).resolves.toEqual([
      { artifact: artifact(), deletionId: DELETION_ID, tenantId: TENANT },
    ]);
    await expect(repository.pendingArtifactDeletions(TENANT, 0)).rejects.toThrow("between 1 and 256");
    await expect(repository.acknowledgeArtifactDeletion(TENANT, DELETION_ID)).resolves.toBeUndefined();
  });

  it("compacts old tenant publication tombstones idempotently behind active-work and GC fences", async () => {
    const cutoff = new Date("2026-07-01T00:00:00.000Z");
    let compacted = "4";
    const fixture = fakePool((text, values) => {
      if (!text.includes("WITH candidates AS MATERIALIZED")) throw new Error(`Unexpected query: ${text}`);
      expect(values).toEqual([TENANT, cutoff, 17]);
      expect(text).toContain("head.publication_id IS NULL");
      expect(text).toContain("head.updated_at < $2");
      expect(text).toContain("FOR UPDATE OF head SKIP LOCKED");
      expect(text).toContain("FROM public.workspace_project_references reference");
      expect(text).toContain("reference.reference_kind <> 'snapshot-publication'");
      expect(text).toContain("FROM public.snapshot_publications publication");
      expect(text).toContain("publication.generation = head.generation");
      expect(text).toContain("FROM public.snapshot_artifact_deletions deletion");
      expect(text).toContain("deletion.deleted_at IS NULL");
      return { rowCount: 1, rows: [{ compacted }] };
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.compactPublicationTombstones(TENANT, cutoff, 17)).resolves.toBe(4);
    compacted = "0";
    await expect(repository.compactPublicationTombstones(TENANT, cutoff, 17)).resolves.toBe(0);
    await expect(repository.compactPublicationTombstones("", cutoff, 17)).rejects.toThrow("Tenant ID");
    await expect(repository.compactPublicationTombstones(TENANT, new Date(Number.NaN), 17)).rejects.toThrow("cutoff");
    await expect(repository.compactPublicationTombstones(TENANT, cutoff, 257)).rejects.toThrow("between 1 and 256");
  });
});

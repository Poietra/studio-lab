import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { SnapshotArtifactReceiptV1, SnapshotPublicationIdentityV1 } from "../snapshot-publication-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";
import {
  PostgresSnapshotPublicationRepositoryV1,
  SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM,
} from "./postgres-snapshot-publication-repository";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const SOURCE_PATH = "scenes/main.py";
const SCENE = "MainScene";
const PUBLICATION_ID = "12345678-1234-4123-8123-123456789abc";
const DELETION_ID = "87654321-4321-4321-8321-cba987654321";
const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
const RUNTIME = "c".repeat(64);
const PROFILE = "d".repeat(64);
const RESULT = "e".repeat(64);
const SNAPSHOT = "f".repeat(64);

const identity: SnapshotPublicationIdentityV1 = {
  projectId: PROJECT,
  sceneName: SCENE,
  sourcePath: SOURCE_PATH,
  tenantId: TENANT,
};

function artifact(sourceDigest = SOURCE_A): SnapshotArtifactReceiptV1 {
  return {
    byteSize: 128,
    etag: "artifact-etag",
    objectKey: `tenants/${TENANT}/snapshots/${sourceDigest}/${RUNTIME}/${PROFILE}/${RESULT}`,
    profileDigest: PROFILE,
    resultDigest: RESULT,
    runtimeConfigHash: RUNTIME,
    sourceDigest,
    versionId: "artifact-version",
  };
}

function artifactRow(value = artifact()) {
  return {
    artifact_byte_size: value.byteSize,
    artifact_etag: value.etag,
    artifact_object_key: value.objectKey,
    artifact_profile_digest: value.profileDigest,
    artifact_result_digest: value.resultDigest,
    artifact_runtime_config_hash: value.runtimeConfigHash,
    artifact_source_digest: value.sourceDigest,
    artifact_tenant_id: TENANT,
    artifact_version_id: value.versionId,
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
    if (text.includes("pg_advisory_xact_lock(hashtextextended")) return { rowCount: 1, rows: [{}] };
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
        expect(values[5]).toBe("8");
        return { rowCount: 1, rows: [publicationRow({ generation: "8" })] };
      }
      if (text.startsWith("UPDATE public.snapshot_scene_heads")) {
        expect(values).toEqual([TENANT, PROJECT, SOURCE_PATH, SCENE, "8", PUBLICATION_ID, "7", null]);
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
        expect(values).toEqual([TENANT, PROJECT, SOURCE_PATH, SCENE, "2", PUBLICATION_ID]);
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

  it("uses only the exact current artifact lookup and verifies migration v3 readiness", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.snapshot_artifact_objects a")) {
        expect(text).toContain("source.generation = p.source_generation");
        expect(values).toEqual([
          TENANT,
          RESULT,
          SOURCE_A,
          RUNTIME,
          PROFILE,
          artifact().objectKey,
          "artifact-version",
          "artifact-etag",
          128,
        ]);
        return { rowCount: 1, rows: [artifactRow()] };
      }
      if (text.includes("poietra_schema_migrations")) {
        expect(values).toEqual([]);
        return { rowCount: 1, rows: [{ checksum: SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresSnapshotPublicationRepositoryV1({ pool: fixture.pool });

    await expect(repository.isArtifactPublished(TENANT, artifact())).resolves.toBe(true);
    await expect(repository.ready()).resolves.toBe(true);
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
      [`snapshot-artifact:${TENANT}:${RESULT}`],
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
  ])("queues a non-current %s after atomically removing historical metadata", async (_name, registered) => {
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
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    expect(ordered.every((index) => index >= 0)).toBe(true);
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
});

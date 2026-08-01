import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type ImmutableRenderArtifactReceiptV1,
  immutableRenderArtifactObjectKeyV1,
  type RenderArtifactKindV1,
  type RenderArtifactReceiptV1,
  renderArtifactObjectKeyV1,
} from "../render-artifact-repository";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
import { IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM } from "./immutable-object-generation-schema";
import { PostgresArtifactRepositoryV1, RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM } from "./postgres-artifact-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";
import { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
import { RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM } from "./render-session-usage-schema";

const TENANT = "tenant-a";
const SESSION = "00000000-0000-4000-8000-000000000001";
const SOURCE_DIGEST = "1".repeat(64);
const RUNTIME_DIGEST = "2".repeat(64);
const PROFILE_DIGEST = "3".repeat(64);
const REQUEST_DIGEST = "4".repeat(64);

function receipt(kind: RenderArtifactKindV1): RenderArtifactReceiptV1 {
  const artifactDigest = (kind === "video" ? "5" : "6").repeat(64);
  const identity = {
    artifactDigest,
    kind,
    profileDigest: PROFILE_DIGEST,
    requestDigest: REQUEST_DIGEST,
    runtimeDigest: RUNTIME_DIGEST,
    sourceDigest: SOURCE_DIGEST,
  } as const;
  return {
    ...identity,
    byteSize: 1,
    etag: `etag-${kind}`,
    mediaType: kind === "video" ? "video/mp4" : "image/png",
    objectKey: renderArtifactObjectKeyV1(TENANT, identity),
    versionId: `version-${kind}`,
  };
}

function immutableReceipt(kind: RenderArtifactKindV1 = "video"): ImmutableRenderArtifactReceiptV1 {
  const artifactDigest = (kind === "video" ? "5" : "6").repeat(64);
  const objectGeneration = "00000000-0000-4000-8000-0000000000aa";
  const identity = {
    artifactDigest,
    byteSize: 1,
    kind,
    mediaType: kind === "video" ? ("video/mp4" as const) : ("image/png" as const),
    profileDigest: PROFILE_DIGEST,
    requestDigest: REQUEST_DIGEST,
    runtimeDigest: RUNTIME_DIGEST,
    sourceDigest: SOURCE_DIGEST,
  };
  return {
    ...identity,
    etag: `etag-${kind}`,
    objectGeneration,
    objectKey: immutableRenderArtifactObjectKeyV1(TENANT, identity, objectGeneration),
  };
}

function injectedPool(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
    options: {
      connectionTimeoutMillis: 1_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 1_000,
      statement_timeout: 1_000,
    },
  } as unknown as Pool;
}

describe("Postgres render-artifact publication", () => {
  it("reports ready only when artifact, cancellation, and billing migrations match", async () => {
    const rows = [
      { checksum: RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM, version: 4 },
      { checksum: RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM, version: 7 },
      { checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM, version: 14 },
      { checksum: RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM, version: 15 },
      { checksum: IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM, version: 20 },
    ];
    const query = vi.fn(async (text: string) => {
      expect(text).toContain("version IN (4, 7, 14, 15, 20)");
      return { rowCount: rows.length, rows };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: POSTGRES_REPOSITORY_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresArtifactRepositoryV1({ pool, statementTimeoutMs: 1_000 });

    await expect(repository.ready()).resolves.toBe(true);
    for (const [index, row] of rows.entries()) {
      rows[index] = { ...row, checksum: "0".repeat(64) };
      await expect(repository.ready()).resolves.toBe(false);
      rows[index] = row;
    }
  });

  it("fails closed before inserting artifacts when cancellation delivery is pending", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("SELECT project_id, patched_digest, status")) {
        return {
          rowCount: 1,
          rows: [
            {
              deadline_current: true,
              fence_token: "1",
              lease_current: true,
              lease_owner: "worker-a",
              patched_digest: SOURCE_DIGEST,
              project_id: "project-a",
              session_created_at: new Date(),
              status: "rendering",
              version: "2",
            },
          ],
        };
      }
      if (text.includes("SELECT 1 FROM public.render_cancellation_intents")) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: POSTGRES_REPOSITORY_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresArtifactRepositoryV1({ pool, statementTimeoutMs: 1_000 });

    await expect(
      repository.publishSessionArtifacts({
        artifacts: {
          thumbnail: { artifactId: "00000000-0000-4000-8000-000000000003", receipt: receipt("thumbnail") },
          video: { artifactId: "00000000-0000-4000-8000-000000000002", receipt: receipt("video") },
        },
        expectedVersion: 2n,
        expirationMs: 60_000,
        fenceToken: 1n,
        logTail: "",
        ownerId: "worker-a",
        sessionId: SESSION,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(statements.some((statement) => statement.includes("INSERT INTO public.render_artifact_objects"))).toBe(
      false,
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists an immutable deletion tombstone with an exact XOR locator", async () => {
    const value = immutableReceipt();
    const deletionId = "00000000-0000-4000-8000-000000000099";
    const calls: Readonly<{ text: string; values: readonly unknown[] }>[] = [];
    const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("INSERT INTO public.render_artifact_deletions")) {
        return {
          rowCount: 1,
          rows: [
            {
              artifact_byte_size: value.byteSize,
              artifact_digest: value.artifactDigest,
              artifact_etag: value.etag,
              artifact_kind: value.kind,
              artifact_media_type: value.mediaType,
              artifact_object_generation: value.objectGeneration,
              artifact_object_key: value.objectKey,
              artifact_profile_digest: value.profileDigest,
              artifact_request_digest: value.requestDigest,
              artifact_runtime_digest: value.runtimeDigest,
              artifact_source_digest: value.sourceDigest,
              artifact_tenant_id: TENANT,
              artifact_version_id: null,
              deletion_id: deletionId,
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const repository = new PostgresArtifactRepositoryV1({
      pool: injectedPool(query),
      statementTimeoutMs: 1_000,
    });

    await expect(repository.queueDeletion(TENANT, value, 1)).resolves.toEqual({
      deletionId,
      receipt: value,
      tenantId: TENANT,
    });

    const exactQueries = calls.filter(
      ({ text }) => text.includes("render_artifact_deletions") || text.includes("render_artifact_objects artifact"),
    );
    expect(exactQueries.slice(0, 2).every(({ text }) => text.includes("version_id IS NOT DISTINCT FROM"))).toBe(true);
    expect(exactQueries.slice(0, 2).every(({ text }) => text.includes("object_generation IS NOT DISTINCT FROM"))).toBe(
      true,
    );
    const inserted = calls.find(({ text }) => text.includes("INSERT INTO public.render_artifact_deletions"));
    expect(inserted?.text).toContain("object_generation");
    expect(inserted?.values).toEqual([
      TENANT,
      expect.any(String),
      value.kind,
      value.mediaType,
      value.artifactDigest,
      value.sourceDigest,
      value.runtimeDigest,
      value.profileDigest,
      value.requestDigest,
      value.objectKey,
      null,
      value.objectGeneration,
      value.etag,
      value.byteSize,
    ]);
  });

  it("fails closed when PostgreSQL returns both locator modes", async () => {
    const value = immutableReceipt();
    const query = vi.fn(async (text: string) => ({
      rowCount: 1,
      rows: text.includes("FROM public.render_artifact_deletions")
        ? [
            {
              artifact_byte_size: value.byteSize,
              artifact_digest: value.artifactDigest,
              artifact_etag: value.etag,
              artifact_kind: value.kind,
              artifact_media_type: value.mediaType,
              artifact_object_generation: value.objectGeneration,
              artifact_object_key: value.objectKey,
              artifact_profile_digest: value.profileDigest,
              artifact_request_digest: value.requestDigest,
              artifact_runtime_digest: value.runtimeDigest,
              artifact_source_digest: value.sourceDigest,
              artifact_tenant_id: TENANT,
              artifact_version_id: "unexpected-version",
              deletion_id: "00000000-0000-4000-8000-000000000099",
            },
          ]
        : [],
    }));
    const repository = new PostgresArtifactRepositoryV1({
      pool: injectedPool(query),
      statementTimeoutMs: 1_000,
    });

    await expect(repository.pendingDeletions(TENANT, 1)).rejects.toThrow(/locator mode/i);
  });
});

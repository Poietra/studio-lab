import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type RenderArtifactKindV1,
  type RenderArtifactReceiptV1,
  renderArtifactObjectKeyV1,
} from "../render-artifact-repository";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
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

describe("Postgres render-artifact publication", () => {
  it("reports ready only when artifact, cancellation, and billing migrations match", async () => {
    const rows = [
      { checksum: RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM, version: 4 },
      { checksum: RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM, version: 7 },
      { checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM, version: 14 },
      { checksum: RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM, version: 15 },
    ];
    const query = vi.fn(async (text: string) => {
      expect(text).toContain("version IN (4, 7, 14, 15)");
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
});

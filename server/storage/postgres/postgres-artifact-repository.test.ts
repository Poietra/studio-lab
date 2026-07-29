import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type RenderArtifactKindV1,
  type RenderArtifactReceiptV1,
  renderArtifactObjectKeyV1,
} from "../render-artifact-repository";
import { PostgresArtifactRepositoryV1 } from "./postgres-artifact-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

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

import { S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createDurablePostgresS3ProductionRuntimeV1 } from "../durable-manim-production-composition";
import {
  RENDER_SESSION_MIGRATION_V2_SOURCE,
  renderSessionMigrationChecksumV2,
  WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
  workspaceSourceMigrationChecksumV1,
} from "./postgres/migrate";
import { RENDER_SESSION_MIGRATION_V2_CHECKSUM } from "./postgres/postgres-render-session-repository";
import {
  PostgresWorkspaceSourceRepositoryV1,
  WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM,
} from "./postgres/postgres-workspace-source-repository";
import { S3ContentBlobStoreV1 } from "./s3/s3-content-blob-store";

describe("durable storage configuration", () => {
  it("bundles the exact checksummed workspace/source migration", () => {
    expect(workspaceSourceMigrationChecksumV1(WORKSPACE_SOURCE_MIGRATION_V1_SOURCE)).toBe(
      WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM,
    );
    expect(renderSessionMigrationChecksumV2(RENDER_SESSION_MIGRATION_V2_SOURCE)).toBe(
      RENDER_SESSION_MIGRATION_V2_CHECKSUM,
    );
  });

  it("does not let production bypass endpoint validation with an injected S3 client", () => {
    const client = new S3Client({ region: "us-east-1" });
    try {
      expect(
        () =>
          new S3ContentBlobStoreV1({
            bucket: "poietra-private-sources",
            client,
            deployment: "production",
          }),
      ).toThrow(/inspectable client configuration/i);
    } finally {
      client.destroy();
    }
  });

  it("rejects unencrypted production object storage and unbounded PostgreSQL timeout input", () => {
    expect(
      () =>
        new S3ContentBlobStoreV1({
          bucket: "poietra-private-sources",
          clientConfig: {
            endpoint: "http://127.0.0.1:9000",
            ignoreConfiguredEndpointUrls: true,
            region: "us-east-1",
          },
          deployment: "production",
        }),
    ).toThrow(/only loopback tests/i);
    expect(
      () =>
        new PostgresWorkspaceSourceRepositoryV1({
          poolConfig: { query_timeout: -1 },
        }),
    ).toThrow(/query_timeout/i);
  });

  it("rejects production PostgreSQL connection strings and unverified transport", async () => {
    const runtime = createDurablePostgresS3ProductionRuntimeV1({
      database: {
        migrationPoolConfig: { connectionString: "postgresql://database.example/poietra" },
        runtimePoolConfig: { host: "database.example", ssl: { rejectUnauthorized: false } },
      },
      namespace: "production-primary",
      objectStorage: {
        bucket: "poietra-private-sources",
        clientConfig: { ignoreConfiguredEndpointUrls: true, region: "us-east-1" },
      },
      renderWorker: { onFailure: () => undefined },
      renderSandbox: {} as never,
      snapshot: {
        artifactGc: {
          batchSize: 64,
          graceMs: 60_000,
          intervalMs: 60_000,
          onFailure: () => undefined,
          sweepTimeoutMs: 30_000,
        },
        sandbox: {} as never,
      },
      sourceGc: {
        batchSize: 64,
        graceMs: 60_000,
        intervalMs: 60_000,
        onFailure: () => undefined,
        sweepTimeoutMs: 30_000,
      },
      tenantId: "tenant-a",
    });

    await expect(runtime).rejects.toThrow(/verified TLS/i);
  });

  it("rejects production S3 transport and configured-endpoint escape hatches", () => {
    const escapeHatches = [
      { ignoreConfiguredEndpointUrls: true, requestHandler: {} },
      { endpointProvider: async () => ({}), ignoreConfiguredEndpointUrls: true },
      { ignoreConfiguredEndpointUrls: true, urlParser: () => ({}) },
      { ignoreConfiguredEndpointUrls: true, tls: false },
      { forcePathStyle: async () => true, ignoreConfiguredEndpointUrls: true },
      { ignoreConfiguredEndpointUrls: false },
      {},
    ];
    for (const config of escapeHatches) {
      expect(
        () =>
          new S3ContentBlobStoreV1({
            bucket: "poietra-private-sources",
            clientConfig: { region: "us-east-1", ...config } as never,
            deployment: "production",
          }),
      ).toThrow(/verified-HTTPS transport|path-style/i);
    }
  });

  it("rejects an injected PostgreSQL pool that can bypass repository query bounds", async () => {
    const pool = new Pool();
    try {
      expect(() => new PostgresWorkspaceSourceRepositoryV1({ pool })).toThrow(/bounded connectionTimeoutMillis/i);
    } finally {
      await pool.end();
    }
  });

  it("rejects an injected PostgreSQL pool with a caller-controlled search path", async () => {
    const pool = new Pool({
      connectionTimeoutMillis: 5_000,
      options: "-c search_path=poietra,public",
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    try {
      expect(() => new PostgresWorkspaceSourceRepositoryV1({ pool })).toThrow(/fixed.*search_path/i);
    } finally {
      await pool.end();
    }
  });

  it("bounds S3 version scans even when every page contains only delete markers", async () => {
    let requests = 0;
    const client = {
      destroy() {},
      async send(command: Readonly<{ input: Readonly<{ MaxKeys?: number }> }>) {
        requests += 1;
        expect(command.input.MaxKeys).toBe(1);
        return {
          DeleteMarkers: [{}],
          IsTruncated: true,
          NextKeyMarker: `tenants/tenant-a/sources/${String(requests).padStart(64, "0")}`,
          NextVersionIdMarker: `version-${requests}`,
          Versions: [],
        };
      },
    } as unknown as S3Client;
    const store = new S3ContentBlobStoreV1({
      bucket: "poietra-private-sources",
      client,
      deployment: "test",
    });

    expect(await store.listSourceVersions("tenant-a", new Date(), 1)).toEqual({
      nextCursor: JSON.stringify([`tenants/tenant-a/sources/${"16".padStart(64, "0")}`, "version-16"]),
      versions: [],
    });
    expect(requests).toBe(16);
  });

  it("rejects incomplete privacy evidence and lifecycle configuration", async () => {
    const ready = async (responses: Readonly<{ acl: unknown; lifecycle: unknown; policy: unknown }>) => {
      const client = {
        destroy() {},
        async send(command: object) {
          switch (command.constructor.name) {
            case "HeadBucketCommand":
              return {};
            case "GetBucketVersioningCommand":
              return { Status: "Enabled" };
            case "GetBucketAclCommand":
              return responses.acl;
            case "GetBucketPolicyStatusCommand":
              return responses.policy;
            case "GetBucketLifecycleConfigurationCommand":
              return responses.lifecycle;
            default:
              throw new Error("Unexpected S3 readiness command.");
          }
        },
      } as unknown as S3Client;
      return new S3ContentBlobStoreV1({
        bucket: "poietra-private-sources",
        client,
        deployment: "test",
      }).ready();
    };
    const ownerAcl = {
      Grants: [{ Grantee: { Type: "CanonicalUser" }, Permission: "FULL_CONTROL" }],
      Owner: { ID: "" },
    };

    await expect(ready({ acl: {}, lifecycle: null, policy: { PolicyStatus: { IsPublic: false } } })).resolves.toBe(
      false,
    );
    await expect(ready({ acl: ownerAcl, lifecycle: null, policy: {} })).resolves.toBe(false);
    await expect(
      ready({ acl: ownerAcl, lifecycle: { Rules: [] }, policy: { PolicyStatus: { IsPublic: false } } }),
    ).resolves.toBe(false);
  });

  it("destroys a mismatched S3 response body before rejecting its receipt", async () => {
    const destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([0x78]);
      },
    };
    const client = {
      destroy() {},
      async send() {
        return { Body: body, ContentLength: 1, ETag: "etag", VersionId: "wrong-version" };
      },
    } as unknown as S3Client;
    const store = new S3ContentBlobStoreV1({
      bucket: "poietra-private-sources",
      client,
      deployment: "test",
    });
    const digest = "a".repeat(64);

    await expect(
      store.readSource("tenant-a", {
        byteSize: 1,
        digest,
        etag: "etag",
        objectKey: `tenants/tenant-a/sources/${digest}`,
        versionId: "expected-version",
      }),
    ).rejects.toThrow(/metadata does not match/i);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects a cycling S3 version cursor within its request bound", async () => {
    let requests = 0;
    const client = {
      destroy() {},
      async send() {
        requests += 1;
        return {
          DeleteMarkers: [{}],
          IsTruncated: true,
          NextKeyMarker: `tenants/tenant-a/sources/${"a".repeat(64)}`,
          NextVersionIdMarker: "same-version",
          Versions: [],
        };
      },
    } as unknown as S3Client;
    const store = new S3ContentBlobStoreV1({
      bucket: "poietra-private-sources",
      client,
      deployment: "test",
    });

    await expect(store.listSourceVersions("tenant-a", new Date(), 1)).rejects.toThrow(/cycling/i);
    expect(requests).toBe(2);
  });

  it("rejects a source-version cursor from another tenant before listing", async () => {
    const send = vi.fn();
    const store = new S3ContentBlobStoreV1({
      bucket: "poietra-private-sources",
      client: { destroy() {}, send } as unknown as S3Client,
      deployment: "test",
    });

    await expect(
      store.listSourceVersions(
        "tenant-a",
        new Date(),
        1,
        JSON.stringify([`tenants/tenant-b/sources/${"a".repeat(64)}`, "version-a"]),
      ),
    ).rejects.toThrow(/cursor is invalid/i);
    expect(send).not.toHaveBeenCalled();
  });
});

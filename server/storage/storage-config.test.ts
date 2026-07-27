import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import { S3ContentBlobStoreV1 } from "./s3/s3-content-blob-store";

describe("durable storage configuration", () => {
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
          clientConfig: { endpoint: "http://127.0.0.1:9000", region: "us-east-1" },
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
});

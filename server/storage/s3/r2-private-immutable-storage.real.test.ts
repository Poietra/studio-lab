import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PrivateImmutableS3BucketTransportV1 } from "./s3-private-immutable-bucket-transport";

const REQUIRED_ENVIRONMENT = [
  "POIETRA_R2_ACCOUNT_ID",
  "POIETRA_R2_BUCKET",
  "POIETRA_R2_ACCESS_KEY_ID",
  "POIETRA_R2_SECRET_ACCESS_KEY",
] as const;
const requested = process.env.POIETRA_R2_CONFORMANCE_REQUIRED === "1";
const configured = REQUIRED_ENVIRONMENT.every((name) => process.env[name]);
if (requested && !configured) {
  throw new Error(`R2 conformance requires ${REQUIRED_ENVIRONMENT.join(", ")}.`);
}

function jurisdiction() {
  const value = process.env.POIETRA_R2_JURISDICTION ?? "default";
  if (value !== "default" && value !== "eu" && value !== "fedramp") {
    throw new TypeError("POIETRA_R2_JURISDICTION must be default, eu, or fedramp.");
  }
  return value;
}

async function readBody(value: unknown) {
  if (!value || typeof value !== "object" || !(Symbol.asyncIterator in value)) {
    throw new TypeError("The R2 conformance body is unreadable.");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of value as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("The R2 conformance body chunk is invalid.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

describe.skipIf(!configured)("Cloudflare R2 private immutable storage", () => {
  it("conforms for authenticated conditional PUT, HEAD, full GET, Range, list, and exact delete", async () => {
    const body = new TextEncoder().encode(`poietra-r2-conformance:${randomUUID()}`);
    const digest = createHash("sha256").update(body).digest("hex");
    const objectGeneration = randomUUID();
    const tenantId = `r2-conformance-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const prefix = `tenants/${tenantId}/sources/`;
    const objectKey = `${prefix}${digest}/g/${objectGeneration}`;
    const metadata = { "content-digest": digest, "object-generation": objectGeneration };
    const transport = new PrivateImmutableS3BucketTransportV1({
      bucket: process.env.POIETRA_R2_BUCKET!,
      deployment: "production",
      provider: {
        accountId: process.env.POIETRA_R2_ACCOUNT_ID!,
        credentials: {
          accessKeyId: process.env.POIETRA_R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.POIETRA_R2_SECRET_ACCESS_KEY!,
        },
        jurisdiction: jurisdiction(),
        kind: "cloudflare-r2",
      },
    });
    const lease = transport.acquire();
    try {
      await expect(lease.ready()).resolves.toBe(true);
      const operation = lease.operation();
      const created = await operation.putObject({
        body,
        contentType: "application/octet-stream",
        metadata,
        objectKey,
      });
      expect(created.kind).toBe("created");
      if (created.kind !== "created") throw new Error("The unique R2 conformance key already existed.");

      await expect(
        operation.putObject({ body: Uint8Array.of(0), contentType: "application/octet-stream", metadata, objectKey }),
      ).resolves.toEqual({ kind: "already-exists" });
      await expect(
        operation.headObject({ byteSize: body.byteLength, etag: created.etag, objectKey }),
      ).resolves.toMatchObject({
        byteSize: body.byteLength,
        contentType: "application/octet-stream",
        etag: created.etag,
        metadata,
      });

      const full = await operation.getObject({ byteSize: body.byteLength, etag: created.etag, objectKey });
      await expect(readBody(full.body)).resolves.toEqual(Buffer.from(body));
      const range = { end: body.byteLength - 2, start: 1 };
      const partial = await operation.getObject({ byteSize: body.byteLength, etag: created.etag, objectKey, range });
      expect(partial.contentRange).toBe(`bytes ${range.start}-${range.end}/${body.byteLength}`);
      await expect(readBody(partial.body)).resolves.toEqual(Buffer.from(body.subarray(range.start, range.end + 1)));

      await expect(operation.listObjectsPage({ maximum: 1, prefix })).resolves.toMatchObject({
        nextCursor: null,
        objects: [{ byteSize: body.byteLength, etag: created.etag, objectKey }],
      });
      await operation.deleteObject(objectKey);
      await expect(
        operation.headObject({ byteSize: body.byteLength, etag: created.etag, objectKey }),
      ).rejects.toBeTruthy();
    } finally {
      await lease
        .operation()
        .deleteObject(objectKey)
        .catch(() => undefined);
      await lease.close();
      await transport.close();
    }
  });
});

import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { S3ImmutableRenderArtifactStoreV1 } from "./s3-immutable-render-artifact-store";
import { S3ImmutableSnapshotArtifactStoreV1 } from "./s3-immutable-snapshot-artifact-store";
import { ImmutableS3ProjectPngStoreV1, ImmutableS3SourceBlobStoreV1 } from "./s3-immutable-source-png-store";
import {
  type PrivateImmutableS3BucketOperationV1,
  PrivateImmutableS3BucketTransportV1,
} from "./s3-private-immutable-bucket-transport";

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

const PROJECT_PNG_BYTES = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);
const VIDEO_BYTES = Uint8Array.from(Buffer.from("000000186674797069736f6d00000000", "hex"));

function jurisdiction() {
  const value = process.env.POIETRA_R2_JURISDICTION ?? "default";
  if (value !== "default" && value !== "eu" && value !== "fedramp") {
    throw new TypeError("POIETRA_R2_JURISDICTION must be default, eu, or fedramp.");
  }
  return value;
}

function createR2Transport() {
  return new PrivateImmutableS3BucketTransportV1({
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
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
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

function isMissingObject(error: unknown) {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "missing") ||
      error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

async function assertMissing(request: Promise<unknown>, label: string) {
  try {
    await request;
  } catch (error) {
    if (isMissingObject(error)) return;
    throw new Error(`${label} HEAD failed without proving absence.`, { cause: error });
  }
  throw new Error(`${label} remained readable after exact deletion.`);
}

async function deleteTenantObjects(operation: PrivateImmutableS3BucketOperationV1, tenantPrefix: string) {
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    const page = await operation.listObjectsPage({
      maximum: 16,
      prefix: tenantPrefix,
    });
    if (page.objects.length === 0) return;
    for (const object of page.objects) {
      if (!object.objectKey.startsWith(tenantPrefix)) {
        throw new Error("R2 shadow cleanup received an object outside its tenant prefix.");
      }
      await operation.deleteObject(object.objectKey);
    }
  }
  const remaining = await operation.listObjectsPage({ maximum: 1, prefix: tenantPrefix });
  if (remaining.objects.length === 0) return;
  throw new Error("R2 shadow cleanup could not empty its tenant prefix within four bounded passes.");
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
    const transport = createR2Transport();
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

  it("shadow verifies and discards source, PNG, snapshot, video, thumbnail, and video Range", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `r2-shadow-${suffix.slice(0, 24)}`;
    const tenantPrefix = `tenants/${tenantId}/`;
    const projectId = `project-${suffix.slice(0, 24)}`;
    const source = [
      "from manim import Scene",
      "",
      "class R2ShadowScene(Scene):",
      "    def construct(self):",
      "        self.wait(1)",
      "",
    ].join("\n");
    const sourceDigest = sha256(source);
    const runtimeDigest = sha256(`runtime:${suffix}`);
    const profileDigest = sha256(`profile:${suffix}`);
    const runtimeConfigHash = sha256(`runtime-config:${suffix}`);
    const snapshotBytes = new TextEncoder().encode(`poietra-r2-shadow-snapshot:${suffix}`);
    const requestDigest = (kind: "thumbnail" | "video") => sha256(`request:${kind}:${suffix}`);
    const mediaInput = (kind: "thumbnail" | "video", bytes: Uint8Array) => ({
      artifactDigest: sha256(bytes),
      byteSize: bytes.byteLength,
      bytes,
      kind,
      mediaType: kind === "video" ? ("video/mp4" as const) : ("image/png" as const),
      profileDigest,
      requestDigest: requestDigest(kind),
      runtimeDigest,
      sourceDigest,
    });

    const transport = createR2Transport();
    const cleanupLease = transport.acquire();
    const sources = new ImmutableS3SourceBlobStoreV1({ transport });
    const projectPngs = new ImmutableS3ProjectPngStoreV1({ transport });
    const snapshots = new S3ImmutableSnapshotArtifactStoreV1({ transport });
    const media = new S3ImmutableRenderArtifactStoreV1({ transport });
    const exactDeletes: Array<() => Promise<void>> = [];
    const cleanupErrors: unknown[] = [];
    let testFailed = false;
    let testError: unknown;

    try {
      await expect(
        Promise.all([sources.ready(), projectPngs.ready(), snapshots.ready(), media.ready()]),
      ).resolves.toEqual([true, true, true, true]);

      const sourceReceipt = await sources.putSource(tenantId, source);
      exactDeletes.push(() => sources.deleteObject(tenantId, sourceReceipt));
      await expect(sources.readSource(tenantId, sourceReceipt)).resolves.toBe(source);

      const projectPngReceipt = await projectPngs.put(tenantId, projectId, PROJECT_PNG_BYTES);
      exactDeletes.push(() => projectPngs.deleteObject(tenantId, projectId, projectPngReceipt));
      await expect(projectPngs.read(tenantId, projectId, projectPngReceipt)).resolves.toEqual(PROJECT_PNG_BYTES);

      const snapshotReceipt = await snapshots.put(tenantId, {
        bytes: snapshotBytes,
        identity: {
          kind: "runtime-digest",
          profileDigest,
          runtimeConfigHash,
          runtimeDigest,
          sourceDigest,
        },
      });
      exactDeletes.push(() => snapshots.deleteTarget(tenantId, snapshots.deletionTarget(tenantId, snapshotReceipt)));
      expect(snapshotReceipt.identity).toEqual({
        kind: "runtime-digest",
        profileDigest,
        resultDigest: sha256(snapshotBytes),
        runtimeConfigHash,
        runtimeDigest,
        sourceDigest,
      });
      await expect(snapshots.read(tenantId, snapshotReceipt)).resolves.toEqual(snapshotBytes);

      const videoReceipt = await media.put(tenantId, mediaInput("video", VIDEO_BYTES));
      exactDeletes.push(() => media.deleteObject(tenantId, videoReceipt));
      await expect(readBody(await media.open(tenantId, videoReceipt, null))).resolves.toEqual(Buffer.from(VIDEO_BYTES));
      const videoRange = { end: 11, start: 4 } as const;
      await expect(readBody(await media.open(tenantId, videoReceipt, videoRange))).resolves.toEqual(
        Buffer.from(VIDEO_BYTES.subarray(videoRange.start, videoRange.end + 1)),
      );

      const thumbnailReceipt = await media.put(tenantId, mediaInput("thumbnail", PROJECT_PNG_BYTES));
      exactDeletes.push(() => media.deleteObject(tenantId, thumbnailReceipt));
      await expect(readBody(await media.open(tenantId, thumbnailReceipt, null))).resolves.toEqual(
        Buffer.from(PROJECT_PNG_BYTES),
      );

      for (const deleteObject of [...exactDeletes].reverse()) await deleteObject();
      await assertMissing(sources.headSource(tenantId, sourceReceipt), "Source object");
      await assertMissing(projectPngs.head(tenantId, projectId, projectPngReceipt), "Project PNG object");
      await assertMissing(snapshots.head(tenantId, snapshotReceipt), "Snapshot object");
      await assertMissing(media.head(tenantId, videoReceipt), "Video object");
      await assertMissing(media.head(tenantId, thumbnailReceipt), "Thumbnail object");
    } catch (error) {
      testFailed = true;
      testError = error;
    } finally {
      for (const deleteObject of [...exactDeletes].reverse()) {
        await deleteObject().catch((error: unknown) => cleanupErrors.push(error));
      }
      for (const family of ["sources", "projects", "snapshots", "media"] as const) {
        await deleteTenantObjects(cleanupLease.operation(), `${tenantPrefix}${family}/`).catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      const closeResults = await Promise.allSettled([
        media.close(),
        snapshots.close(),
        projectPngs.close(),
        sources.close(),
        cleanupLease.close(),
      ]);
      cleanupErrors.push(...closeResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
      await transport.close().catch((error: unknown) => cleanupErrors.push(error));
    }

    if (testFailed) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([testError, ...cleanupErrors], "R2 shadow evidence and cleanup both failed.");
      }
      throw testError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "R2 shadow evidence cleanup failed.");
    }
  }, 120_000);
});

import { createHash } from "node:crypto";

import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  assertVersionedSourceBlobReceiptV1,
  MAX_MANIM_SOURCE_BYTES_V1,
  type SourceBlobReceiptV1,
  type SourceBlobVersionCursorV1,
  type SourceBlobVersionV1,
  type SourceContentBlobStoreV1,
  type VersionedSourceBlobReceiptV1,
} from "../workspace-source-repository";
import {
  acquirePrivateVersionedS3BucketTransportV1,
  type PrivateVersionedS3BucketConsumerOptionsV1,
  type PrivateVersionedS3BucketOperationV1,
  type PrivateVersionedS3BucketTransportLeaseV1,
} from "./s3-private-versioned-bucket-transport";

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function tenantId(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Tenant ID is invalid.");
  return parsed.data;
}

function exactSourceBytes(source: string) {
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > MAX_MANIM_SOURCE_BYTES_V1) throw new RangeError("The Python source exceeds 2 MiB.");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypeError("The Python source must be exact UTF-8 text.");
  }
  if (decoded !== source) throw new TypeError("The Python source must not contain unpaired Unicode surrogates.");
  return bytes;
}

function sourceDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceKey(tenant: string, digest: string) {
  return `tenants/${tenant}/sources/${digest}`;
}

function sourceVersionCursor(
  value: SourceBlobVersionCursorV1 | null | undefined,
  prefix: string,
): Readonly<{ keyMarker?: string; versionIdMarker?: string }> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError("The source-version cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("The source-version cursor is invalid.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    !parsed[0].startsWith(prefix) ||
    !/^[0-9a-f]{64}$/.test(parsed[0].slice(prefix.length)) ||
    parsed[0].length > 1_024 ||
    typeof parsed[1] !== "string" ||
    parsed[1].length === 0 ||
    parsed[1].length > 1_024
  ) {
    throw new TypeError("The source-version cursor is invalid.");
  }
  return { keyMarker: parsed[0], versionIdMarker: parsed[1] };
}

function encodeSourceVersionCursor(keyMarker: string, versionIdMarker: string, prefix: string) {
  const encoded = JSON.stringify([keyMarker, versionIdMarker]);
  sourceVersionCursor(encoded, prefix);
  return encoded;
}

function normalizeEtag(value: string | undefined) {
  if (!value || value.length > 512) throw new Error("S3 did not return a bounded object ETag.");
  return value;
}

function validateReceipt(tenant: string, value: SourceBlobReceiptV1): VersionedSourceBlobReceiptV1 {
  return assertVersionedSourceBlobReceiptV1(tenant, value);
}

function isPreconditionFailed(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "PreconditionFailed" ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 412))
  );
}

async function boundedBody(body: unknown, signal?: AbortSignal) {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw new Error("S3 returned an unreadable object body.");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      throwIfAborted(signal);
      const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
      if (!chunk) throw new Error("S3 returned an invalid object chunk.");
      byteLength += chunk.byteLength;
      if (byteLength > MAX_MANIM_SOURCE_BYTES_V1) throw new RangeError("The S3 source object exceeds 2 MiB.");
      chunks.push(Uint8Array.from(chunk));
    }
  } catch (error) {
    if ("destroy" in body && typeof body.destroy === "function") body.destroy();
    throw error;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

export type S3ContentBlobStoreOptionsV1 = PrivateVersionedS3BucketConsumerOptionsV1;

/** Private, version-pinned S3 source storage. Every read revalidates size, digest, and UTF-8. */
export class S3ContentBlobStoreV1 implements SourceContentBlobStoreV1 {
  readonly #transport: PrivateVersionedS3BucketTransportLeaseV1;

  constructor(options: S3ContentBlobStoreOptionsV1) {
    this.#transport = acquirePrivateVersionedS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #readBytes(tenant: string, receipt: SourceBlobReceiptV1, operation: PrivateVersionedS3BucketOperationV1) {
    const expected = validateReceipt(tenant, receipt);
    operation.signal.throwIfAborted();
    const response = await operation.getObject({ Key: expected.objectKey, VersionId: expected.versionId });
    if (
      response.VersionId !== expected.versionId ||
      response.ContentLength !== expected.byteSize ||
      normalizeEtag(response.ETag) !== expected.etag
    ) {
      destroyBody(response.Body);
      throw new Error("The versioned S3 source metadata does not match its published receipt.");
    }
    const bytes = await boundedBody(response.Body, operation.signal);
    if (bytes.byteLength !== expected.byteSize || sourceDigest(bytes) !== expected.digest) {
      throw new Error("The versioned S3 source bytes do not match their published receipt.");
    }
    return bytes;
  }

  async #readCurrentReceipt(
    tenant: string,
    digest: string,
    byteSize: number,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const objectKey = sourceKey(tenant, digest);
    const response = await operation.getObject({ Key: objectKey });
    let receipt: VersionedSourceBlobReceiptV1;
    try {
      receipt = validateReceipt(tenant, {
        byteSize,
        digest,
        etag: normalizeEtag(response.ETag),
        objectKey,
        versionId: response.VersionId ?? "",
      });
      if (response.ContentLength !== byteSize) throw new Error("The current S3 source size is invalid.");
    } catch (error) {
      destroyBody(response.Body);
      throw error;
    }
    const bytes = await boundedBody(response.Body, operation.signal);
    if (bytes.byteLength !== byteSize || sourceDigest(bytes) !== digest) {
      throw new Error("The current S3 source bytes do not match their content-addressed key.");
    }
    return receipt;
  }

  async putSource(tenantValue: string, source: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const bytes = exactSourceBytes(source);
    const digest = sourceDigest(bytes);
    const objectKey = sourceKey(tenant, digest);
    const operation = this.#transport.operation(signal);
    operation.signal.throwIfAborted();
    let response;
    try {
      response = await operation.putObject({
        Body: bytes,
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
        ContentLength: bytes.byteLength,
        ContentType: "text/x-python; charset=utf-8",
        IfNoneMatch: "*",
        Key: objectKey,
      });
    } catch (error) {
      if (isPreconditionFailed(error)) return this.#readCurrentReceipt(tenant, digest, bytes.byteLength, operation);
      throw error;
    }
    const receipt = validateReceipt(tenant, {
      byteSize: bytes.byteLength,
      digest,
      etag: normalizeEtag(response.ETag),
      objectKey,
      versionId: response.VersionId ?? "",
    });
    await this.#readBytes(tenant, receipt, operation);
    return receipt;
  }

  async listSourceVersions(
    tenantValue: string,
    cutoff: Date,
    maximumValue: number,
    cursorValue?: SourceBlobVersionCursorV1 | null,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError("GC cutoff is invalid.");
    if (!Number.isSafeInteger(maximumValue) || maximumValue <= 0 || maximumValue > 256) {
      throw new RangeError("maximum must be an integer between 1 and 256.");
    }
    const prefix = `tenants/${tenant}/sources/`;
    const cursor = sourceVersionCursor(cursorValue, prefix);
    const operation = this.#transport.operation(signal);
    const versions: SourceBlobVersionV1[] = [];
    let keyMarker = cursor.keyMarker;
    let versionIdMarker = cursor.versionIdMarker;
    let nextCursor: SourceBlobVersionCursorV1 | null = null;
    let examined = 0;
    let pages = 0;
    const seenCursors = new Set<string>();
    if (keyMarker && versionIdMarker) {
      seenCursors.add(encodeSourceVersionCursor(keyMarker, versionIdMarker, prefix));
    }
    while (versions.length < maximumValue && examined < 1_024 && pages < 16) {
      operation.signal.throwIfAborted();
      pages += 1;
      // Process each response in full. Capping total response entries by the
      // remaining result capacity lets the page-level cursor advance without
      // skipping eligible versions in the final response.
      const pageBudget = Math.min(256, 1_024 - examined, maximumValue - versions.length);
      const page = await operation.listObjectVersionsPage({
        KeyMarker: keyMarker,
        MaxKeys: pageBudget,
        Prefix: prefix,
        VersionIdMarker: versionIdMarker,
      });
      const pageEntries = (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
      examined += pageEntries;
      for (const version of page.Versions ?? []) {
        if (versions.length >= maximumValue) break;
        const key = version.Key ?? "";
        const digest = key.startsWith(prefix) ? key.slice(prefix.length) : "";
        if (
          !/^[0-9a-f]{64}$/.test(digest) ||
          !version.VersionId ||
          !version.ETag ||
          !Number.isSafeInteger(version.Size) ||
          version.Size! < 0 ||
          version.Size! > MAX_MANIM_SOURCE_BYTES_V1 ||
          !(version.LastModified instanceof Date)
        ) {
          throw new Error("S3 returned invalid source-version metadata.");
        }
        if (version.LastModified >= cutoff) continue;
        versions.push({
          blob: {
            byteSize: version.Size!,
            digest,
            etag: version.ETag,
            objectKey: key,
            versionId: version.VersionId,
          },
          lastModified: version.LastModified,
        });
      }
      if (!page.IsTruncated) {
        nextCursor = null;
        break;
      }
      nextCursor = encodeSourceVersionCursor(page.NextKeyMarker!, page.NextVersionIdMarker!, prefix);
      if (seenCursors.has(nextCursor)) throw new Error("S3 returned a cycling version-list cursor.");
      seenCursors.add(nextCursor);
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
    return { nextCursor, versions };
  }

  async readSource(tenantValue: string, blob: SourceBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    validateReceipt(tenant, blob);
    const bytes = await this.#readBytes(tenant, blob, this.#transport.operation(signal));
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("The versioned S3 source is not valid UTF-8.");
    }
  }

  async deleteVersion(tenantValue: string, blob: SourceBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const receipt = validateReceipt(tenant, blob);
    const operation = this.#transport.operation(signal);
    operation.signal.throwIfAborted();
    await operation.deleteObjectVersion({ Key: receipt.objectKey, VersionId: receipt.versionId });
    operation.signal.throwIfAborted();
  }

  close() {
    return this.#transport.close();
  }
}

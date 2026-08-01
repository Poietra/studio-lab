import { createHash } from "node:crypto";
import { createImmutableObjectGenerationV1 } from "../immutable-object-contract";
import {
  completeImmutableSnapshotArtifactIdentityV1,
  IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1,
  IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
  type ImmutableSnapshotArtifactDeletionTargetV1,
  type ImmutableSnapshotArtifactIdentityV1,
  type ImmutableSnapshotArtifactReceiptV1,
  type ImmutableSnapshotArtifactStoreV1,
  type ImmutableSnapshotArtifactUploadIdentityV1,
  immutableSnapshotArtifactDeletionTargetV1,
  immutableSnapshotArtifactMetadataV1,
  immutableSnapshotArtifactObjectKeyV1,
  immutableSnapshotArtifactTenantIdV1,
  parseImmutableSnapshotArtifactDeletionTargetV1,
  parseImmutableSnapshotArtifactObjectKeyV1,
  parseImmutableSnapshotArtifactReceiptV1,
  parseImmutableSnapshotArtifactUploadIdentityV1,
} from "../immutable-snapshot-artifact-store";
import { MAX_SNAPSHOT_ARTIFACT_BYTES_V1, SnapshotArtifactReadErrorV1 } from "../snapshot-publication-repository";
import {
  acquirePrivateImmutableS3BucketTransportV1,
  type PrivateImmutableS3BucketConsumerOptionsV1,
  type PrivateImmutableS3BucketOperationV1,
  type PrivateImmutableS3BucketTransportLeaseV1,
} from "./s3-private-immutable-bucket-transport";

const MAX_CONDITIONAL_CREATE_ATTEMPTS = 3;
const MAX_LIST_RESULTS = 256;
const MAX_PROVIDER_CURSOR_UTF8_BYTES = 4_096;
const MAX_STORE_CURSOR_UTF8_BYTES = 8_192;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export type S3ImmutableSnapshotArtifactStoreOptionsV1 = PrivateImmutableS3BucketConsumerOptionsV1;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

function corruptArtifact(): never {
  throw new SnapshotArtifactReadErrorV1("corrupt");
}

function isNamedError(error: unknown, name: string) {
  return error instanceof Error && (error.name === name || ("Code" in error && error.Code === name));
}

function statusCode(error: unknown) {
  return error instanceof Error &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
    ? error.$metadata.httpStatusCode
    : undefined;
}

function isMissingObject(error: unknown) {
  return (
    !isNamedError(error, "NoSuchBucket") &&
    (isNamedError(error, "NoSuchKey") || isNamedError(error, "NotFound") || statusCode(error) === 404)
  );
}

function isPreconditionFailure(error: unknown) {
  return isNamedError(error, "PreconditionFailed") || statusCode(error) === 412;
}

async function boundedBody(body: unknown, signal: AbortSignal) {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    destroyBody(body);
    corruptArtifact();
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      signal.throwIfAborted();
      const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
      if (!chunk) corruptArtifact();
      byteLength += chunk.byteLength;
      if (byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) corruptArtifact();
      chunks.push(Uint8Array.from(chunk));
    }
    signal.throwIfAborted();
  } catch (error) {
    destroyBody(body);
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

function exactMetadata(
  tenantId: string,
  identity: ImmutableSnapshotArtifactIdentityV1,
  objectGeneration: string,
  value: Readonly<Record<string, string>>,
) {
  const expected = immutableSnapshotArtifactMetadataV1(tenantId, identity, objectGeneration);
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (
    expectedEntries.length !== actualEntries.length ||
    expectedEntries.some(
      ([key, expectedValue], index) => actualEntries[index]?.[0] !== key || actualEntries[index]?.[1] !== expectedValue,
    )
  ) {
    corruptArtifact();
  }
}

function receipt(
  tenantId: string,
  identity: ImmutableSnapshotArtifactIdentityV1,
  objectGeneration: string,
  byteSize: number,
  etag: string,
) {
  return parseImmutableSnapshotArtifactReceiptV1(tenantId, {
    byteSize,
    etag,
    identity,
    objectGeneration,
    objectKey: immutableSnapshotArtifactObjectKeyV1(tenantId, identity, objectGeneration),
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
    version: 1,
  });
}

function verifyHeaders(
  tenantId: string,
  artifact: ImmutableSnapshotArtifactReceiptV1,
  response: Readonly<{
    byteSize: number;
    contentType?: string;
    etag: string;
    metadata: Readonly<Record<string, string>>;
  }>,
) {
  if (
    response.byteSize !== artifact.byteSize ||
    response.etag !== artifact.etag ||
    response.contentType !== IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1
  ) {
    corruptArtifact();
  }
  exactMetadata(tenantId, artifact.identity, artifact.objectGeneration, response.metadata);
}

function snapshotPrefix(tenantId: string) {
  return `tenants/${tenantId}/snapshots/`;
}

function boundedProviderCursor(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_CURSOR_UTF8_BYTES
  ) {
    throw new TypeError("Immutable snapshot orphan cursor is invalid.");
  }
  return value;
}

function decodeCursor(value: string | null | undefined, expectedPrefix: string) {
  if (value === null || value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STORE_CURSOR_UTF8_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError("Immutable snapshot orphan cursor is invalid.");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Non-canonical cursor");
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new TypeError("Immutable snapshot orphan cursor is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== expectedPrefix) {
    throw new TypeError("Immutable snapshot orphan cursor is invalid.");
  }
  return boundedProviderCursor(parsed[1]);
}

function encodeCursor(prefix: string, providerCursor: string) {
  const cursor = Buffer.from(JSON.stringify([prefix, boundedProviderCursor(providerCursor)]), "utf8").toString(
    "base64url",
  );
  if (cursor.length > MAX_STORE_CURSOR_UTF8_BYTES) {
    throw new Error("S3 returned an oversized immutable snapshot orphan cursor.");
  }
  return cursor;
}

/** Additive snapshot lane backed only by application-owned immutable generation keys. */
export class S3ImmutableSnapshotArtifactStoreV1 implements ImmutableSnapshotArtifactStoreV1 {
  readonly #transport: PrivateImmutableS3BucketTransportLeaseV1;

  constructor(options: S3ImmutableSnapshotArtifactStoreOptionsV1) {
    this.#transport = acquirePrivateImmutableS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #headReceipt(
    tenantId: string,
    receiptValue: ImmutableSnapshotArtifactReceiptV1,
    operation: PrivateImmutableS3BucketOperationV1,
  ) {
    const artifact = parseImmutableSnapshotArtifactReceiptV1(tenantId, receiptValue);
    let response;
    try {
      response = await operation.headObject({
        byteSize: artifact.byteSize,
        etag: artifact.etag,
        objectKey: artifact.objectKey,
      });
    } catch (error) {
      if (isMissingObject(error)) throw new SnapshotArtifactReadErrorV1("missing");
      if (isPreconditionFailure(error)) corruptArtifact();
      throw error;
    }
    verifyHeaders(tenantId, artifact, response);
    return artifact;
  }

  async #readReceipt(
    tenantId: string,
    receiptValue: ImmutableSnapshotArtifactReceiptV1,
    operation: PrivateImmutableS3BucketOperationV1,
  ) {
    const artifact = parseImmutableSnapshotArtifactReceiptV1(tenantId, receiptValue);
    let response;
    try {
      response = await operation.getObject({
        byteSize: artifact.byteSize,
        etag: artifact.etag,
        objectKey: artifact.objectKey,
      });
    } catch (error) {
      if (isMissingObject(error)) throw new SnapshotArtifactReadErrorV1("missing");
      if (isPreconditionFailure(error)) corruptArtifact();
      throw error;
    }
    try {
      verifyHeaders(tenantId, artifact, response);
    } catch (error) {
      destroyBody(response.body);
      throw error;
    }
    const bytes = await boundedBody(response.body, operation.signal);
    if (bytes.byteLength !== artifact.byteSize || sha256(bytes) !== artifact.identity.resultDigest) {
      corruptArtifact();
    }
    return bytes;
  }

  async put(
    tenantValue: string,
    input: Readonly<{ bytes: Uint8Array; identity: ImmutableSnapshotArtifactUploadIdentityV1 }>,
    signal?: AbortSignal,
  ) {
    const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
    if (!input || typeof input !== "object" || !(input.bytes instanceof Uint8Array)) {
      throw new TypeError("Immutable snapshot artifact upload is invalid.");
    }
    if (Object.keys(input).some((key) => !["bytes", "identity"].includes(key))) {
      throw new TypeError("Immutable snapshot artifact upload is invalid.");
    }
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
      throw new RangeError("Immutable snapshot artifacts must contain between 1 byte and 16 MiB.");
    }
    const bytes = Uint8Array.from(input.bytes);
    const uploadIdentity = parseImmutableSnapshotArtifactUploadIdentityV1(input.identity);
    const identity = completeImmutableSnapshotArtifactIdentityV1(uploadIdentity, sha256(bytes));
    const operation = this.#transport.operation(signal);
    for (let attempt = 1; attempt <= MAX_CONDITIONAL_CREATE_ATTEMPTS; attempt += 1) {
      operation.signal.throwIfAborted();
      const objectGeneration = createImmutableObjectGenerationV1();
      const objectKey = immutableSnapshotArtifactObjectKeyV1(tenantId, identity, objectGeneration);
      const result = await operation.putObject({
        body: bytes,
        contentType: IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1,
        metadata: immutableSnapshotArtifactMetadataV1(tenantId, identity, objectGeneration),
        objectKey,
      });
      if (result.kind === "already-exists") {
        if (attempt < MAX_CONDITIONAL_CREATE_ATTEMPTS) continue;
        throw new Error("Immutable snapshot upload exhausted its generation collision bound.");
      }
      const artifact = receipt(tenantId, identity, objectGeneration, bytes.byteLength, result.etag);
      await this.#headReceipt(tenantId, artifact, operation);
      await this.#readReceipt(tenantId, artifact, operation);
      return artifact;
    }
    throw new Error("Immutable snapshot upload did not settle within its bounded attempts.");
  }

  head(tenantValue: string, artifact: ImmutableSnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
    return this.#headReceipt(tenantId, artifact, this.#transport.operation(signal));
  }

  read(tenantValue: string, artifact: ImmutableSnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
    return this.#readReceipt(tenantId, artifact, this.#transport.operation(signal));
  }

  async deleteTarget(
    tenantValue: string,
    targetValue: ImmutableSnapshotArtifactDeletionTargetV1,
    signal?: AbortSignal,
  ) {
    const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
    const target = parseImmutableSnapshotArtifactDeletionTargetV1(tenantId, targetValue);
    const operation = this.#transport.operation(signal);
    await operation.deleteObject(target.objectKey);
    operation.signal.throwIfAborted();
  }

  async listOrphanCandidates(
    tenantValue: string,
    cutoff: Date,
    maximum: number,
    cursorValue?: string | null,
    signal?: AbortSignal,
  ) {
    const tenantId = immutableSnapshotArtifactTenantIdV1(tenantValue);
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new TypeError("Immutable snapshot orphan cutoff is invalid.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LIST_RESULTS) {
      throw new RangeError(`maximum must be an integer between 1 and ${MAX_LIST_RESULTS}.`);
    }
    const prefix = snapshotPrefix(tenantId);
    const providerCursor = decodeCursor(cursorValue, prefix);
    const operation = this.#transport.operation(signal);
    const page = await operation.listObjectsPage({
      ...(providerCursor === undefined ? {} : { cursor: providerCursor }),
      maximum,
      prefix,
    });
    const candidates = page.objects
      .filter((object) => object.lastModified < cutoff)
      .map((object) => {
        const parsed = parseImmutableSnapshotArtifactObjectKeyV1(tenantId, object.objectKey);
        const artifact = receipt(tenantId, parsed.identity, parsed.objectGeneration, object.byteSize, object.etag);
        return {
          artifact,
          lastModified: new Date(object.lastModified.getTime()),
        };
      });
    const nextCursor = page.nextCursor === null ? null : encodeCursor(prefix, page.nextCursor);
    if (nextCursor !== null && nextCursor === cursorValue) {
      throw new Error("S3 returned a cycling immutable snapshot orphan cursor.");
    }
    return { candidates, nextCursor };
  }

  deletionTarget(tenantValue: string, artifactValue: ImmutableSnapshotArtifactReceiptV1) {
    return immutableSnapshotArtifactDeletionTargetV1(tenantValue, artifactValue);
  }

  close() {
    return this.#transport.close();
  }
}

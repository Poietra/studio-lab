import { createHash } from "node:crypto";

import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  parseVersionedSnapshotArtifactReceiptV1,
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotArtifactVersionV1,
  snapshotArtifactObjectKeyV1,
  type VersionedSnapshotArtifactReceiptV1,
} from "../snapshot-publication-repository";
import {
  acquirePrivateVersionedS3BucketTransportV1,
  type PrivateVersionedS3BucketConsumerOptionsV1,
  type PrivateVersionedS3BucketOperationV1,
  type PrivateVersionedS3BucketTransportLeaseV1,
} from "./s3-private-versioned-bucket-transport";

const MAX_LIST_RESULTS = 256;
const MAX_LIST_ENTRIES = 1_024;
const MAX_LIST_PAGES = 16;
const MAX_CONDITIONAL_PUT_ATTEMPTS = 3;
const SHA256 = /^[0-9a-f]{64}$/;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function tenantId(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Tenant ID is invalid.");
  return parsed.data;
}

function resultDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotPrefix(tenant: string) {
  return `tenants/${tenant}/snapshots/`;
}

function parseArtifactKey(key: string, prefix: string) {
  if (typeof key !== "string" || !key.startsWith(prefix)) {
    throw new Error("S3 returned a snapshot key outside the tenant prefix.");
  }
  const parts = key.slice(prefix.length).split("/");
  if ((parts.length !== 4 && parts.length !== 5) || parts.some((part) => !SHA256.test(part))) {
    throw new Error("S3 returned an invalid snapshot artifact key.");
  }
  const legacy = parts.length === 4;
  return {
    profileDigest: parts[2]!,
    resultDigest: parts[legacy ? 3 : 4]!,
    runtimeConfigHash: parts[1]!,
    runtimeDigest: legacy ? LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 : parts[3]!,
    sourceDigest: parts[0]!,
  };
}

function normalizeEtag(value: string | undefined) {
  if (!value || value.length > 512) throw new Error("S3 did not return a bounded object ETag.");
  return value;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

async function boundedBody(body: unknown, signal?: AbortSignal) {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    destroyBody(body);
    throw new SnapshotArtifactReadErrorV1("corrupt");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      throwIfAborted(signal);
      const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
      if (!chunk) throw new SnapshotArtifactReadErrorV1("corrupt");
      byteLength += chunk.byteLength;
      if (byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
        throw new SnapshotArtifactReadErrorV1("corrupt");
      }
      chunks.push(Uint8Array.from(chunk));
    }
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

type VersionCursor = Readonly<{ keyMarker?: string; versionIdMarker?: string }>;

function decodeCursor(value: string | null | undefined, prefix: string): VersionCursor {
  if (value === null || value === undefined) return {};
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("The snapshot-version cursor is invalid.");
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical cursor");
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new TypeError("The snapshot-version cursor is invalid.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    parsed[1].length < 1 ||
    parsed[1].length > 1_024
  ) {
    throw new TypeError("The snapshot-version cursor is invalid.");
  }
  try {
    parseArtifactKey(parsed[0], prefix);
  } catch {
    throw new TypeError("The snapshot-version cursor is invalid.");
  }
  return { keyMarker: parsed[0], versionIdMarker: parsed[1] };
}

function encodeCursor(keyMarker: string, versionIdMarker: string, prefix: string) {
  try {
    parseArtifactKey(keyMarker, prefix);
  } catch {
    throw new Error("S3 returned an invalid version-list cursor.");
  }
  if (typeof versionIdMarker !== "string" || versionIdMarker.length < 1 || versionIdMarker.length > 1_024) {
    throw new Error("S3 returned an invalid version-list cursor.");
  }
  const cursor = Buffer.from(JSON.stringify([keyMarker, versionIdMarker]), "utf8").toString("base64url");
  if (cursor.length > 4_096) throw new Error("S3 returned an oversized version-list cursor.");
  return cursor;
}

function isNamedError(error: unknown, name: string) {
  return error instanceof Error && (error.name === name || ("Code" in error && error.Code === name));
}

function isPreconditionFailed(error: unknown) {
  return (
    isNamedError(error, "PreconditionFailed") ||
    (error instanceof Error &&
      "$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null &&
      "httpStatusCode" in error.$metadata &&
      error.$metadata.httpStatusCode === 412)
  );
}

function isConditionalRequestConflict(error: unknown) {
  return (
    isNamedError(error, "ConditionalRequestConflict") ||
    (error instanceof Error &&
      "$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null &&
      "httpStatusCode" in error.$metadata &&
      error.$metadata.httpStatusCode === 409)
  );
}

function isMissingObjectVersion(error: unknown) {
  return (
    isNamedError(error, "NoSuchKey") ||
    isNamedError(error, "NoSuchVersion") ||
    isNamedError(error, "NotFound") ||
    (error instanceof Error &&
      "$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null &&
      "httpStatusCode" in error.$metadata &&
      error.$metadata.httpStatusCode === 404)
  );
}

function corruptArtifact(): never {
  throw new SnapshotArtifactReadErrorV1("corrupt");
}

export type S3SnapshotArtifactStoreOptionsV1 = PrivateVersionedS3BucketConsumerOptionsV1;

/** Immutable, version-pinned S3 storage for verified snapshot bytes. */
export class S3SnapshotArtifactStoreV1 implements SnapshotArtifactStoreV1 {
  readonly #transport: PrivateVersionedS3BucketTransportLeaseV1;

  constructor(options: S3SnapshotArtifactStoreOptionsV1) {
    this.#transport = acquirePrivateVersionedS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #readBytes(
    tenant: string,
    receiptValue: SnapshotArtifactReceiptV1,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const receipt = parseVersionedSnapshotArtifactReceiptV1(tenant, receiptValue);
    operation.signal.throwIfAborted();
    let response;
    try {
      response = await operation.getObject({ Key: receipt.objectKey, VersionId: receipt.versionId });
    } catch (error) {
      if (isMissingObjectVersion(error)) throw new SnapshotArtifactReadErrorV1("missing");
      throw error;
    }
    try {
      if (
        response.VersionId !== receipt.versionId ||
        response.ContentLength !== receipt.byteSize ||
        normalizeEtag(response.ETag) !== receipt.etag
      ) {
        corruptArtifact();
      }
    } catch (error) {
      destroyBody(response.Body);
      if (error instanceof SnapshotArtifactReadErrorV1) throw error;
      corruptArtifact();
    }
    const bytes = await boundedBody(response.Body, operation.signal);
    if (bytes.byteLength !== receipt.byteSize || resultDigest(bytes) !== receipt.resultDigest) {
      corruptArtifact();
    }
    return bytes;
  }

  async #readCurrentReceipt(
    tenant: string,
    identity: Readonly<{
      byteSize: number;
      profileDigest: string;
      resultDigest: string;
      runtimeConfigHash: string;
      runtimeDigest: string;
      sourceDigest: string;
    }>,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const objectKey = snapshotArtifactObjectKeyV1(tenant, identity);
    let response;
    try {
      response = await operation.getObject({ Key: objectKey });
    } catch (error) {
      if (isMissingObjectVersion(error)) throw new SnapshotArtifactReadErrorV1("missing");
      throw error;
    }
    let receipt: VersionedSnapshotArtifactReceiptV1;
    try {
      receipt = parseVersionedSnapshotArtifactReceiptV1(tenant, {
        ...identity,
        etag: normalizeEtag(response.ETag),
        objectKey,
        versionId: response.VersionId ?? "",
      });
      if (response.ContentLength !== identity.byteSize) {
        corruptArtifact();
      }
    } catch (error) {
      destroyBody(response.Body);
      if (error instanceof SnapshotArtifactReadErrorV1) throw error;
      corruptArtifact();
    }
    const bytes = await boundedBody(response.Body, operation.signal);
    if (bytes.byteLength !== identity.byteSize || resultDigest(bytes) !== identity.resultDigest) {
      corruptArtifact();
    }
    return receipt;
  }

  async put(
    tenantValue: string,
    input: Readonly<{
      bytes: Uint8Array;
      profileDigest: string;
      runtimeConfigHash: string;
      runtimeDigest: string;
      sourceDigest: string;
    }>,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    if (!input || typeof input !== "object" || !(input.bytes instanceof Uint8Array)) {
      throw new TypeError("Snapshot artifact input is invalid.");
    }
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
      throw new RangeError("Snapshot artifacts must contain between 1 byte and 16 MiB.");
    }
    const bytes = Uint8Array.from(input.bytes);
    if (input.runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
      throw new TypeError("The reserved legacy snapshot runtime digest cannot be uploaded.");
    }
    const identity = {
      byteSize: bytes.byteLength,
      profileDigest: input.profileDigest,
      resultDigest: resultDigest(bytes),
      runtimeConfigHash: input.runtimeConfigHash,
      runtimeDigest: input.runtimeDigest,
      sourceDigest: input.sourceDigest,
    };
    const objectKey = snapshotArtifactObjectKeyV1(tenant, identity);
    const operation = this.#transport.operation(signal);
    operation.signal.throwIfAborted();
    let response;
    for (let attempt = 1; attempt <= MAX_CONDITIONAL_PUT_ATTEMPTS; attempt += 1) {
      try {
        response = await operation.putObject({
          Body: bytes,
          ChecksumSHA256: Buffer.from(identity.resultDigest, "hex").toString("base64"),
          ContentLength: bytes.byteLength,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Key: objectKey,
        });
        break;
      } catch (error) {
        if (isPreconditionFailed(error)) {
          try {
            return await this.#readCurrentReceipt(tenant, identity, operation);
          } catch (readError) {
            if (
              !(readError instanceof SnapshotArtifactReadErrorV1) ||
              readError.code !== "missing" ||
              attempt === MAX_CONDITIONAL_PUT_ATTEMPTS
            ) {
              throw readError;
            }
            operation.signal.throwIfAborted();
            continue;
          }
        }
        if (!isConditionalRequestConflict(error) || attempt === MAX_CONDITIONAL_PUT_ATTEMPTS) throw error;
        operation.signal.throwIfAborted();
      }
    }
    if (!response) throw new Error("S3 did not settle the bounded conditional snapshot upload.");
    const receipt = parseVersionedSnapshotArtifactReceiptV1(tenant, {
      ...identity,
      etag: normalizeEtag(response.ETag),
      objectKey,
      versionId: response.VersionId ?? "",
    });
    await this.#readBytes(tenant, receipt, operation);
    return receipt;
  }

  async read(tenantValue: string, artifact: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    parseVersionedSnapshotArtifactReceiptV1(tenant, artifact);
    return this.#readBytes(tenant, artifact, this.#transport.operation(signal));
  }

  async listVersions(
    tenantValue: string,
    cutoff: Date,
    maximum: number,
    cursorValue?: string | null,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError("GC cutoff is invalid.");
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LIST_RESULTS) {
      throw new RangeError(`maximum must be an integer between 1 and ${MAX_LIST_RESULTS}.`);
    }
    const prefix = snapshotPrefix(tenant);
    const cursor = decodeCursor(cursorValue, prefix);
    const operation = this.#transport.operation(signal);
    const versions: SnapshotArtifactVersionV1<VersionedSnapshotArtifactReceiptV1>[] = [];
    let keyMarker = cursor.keyMarker;
    let versionIdMarker = cursor.versionIdMarker;
    let nextCursor: string | null = null;
    let examined = 0;
    let pages = 0;
    const seen = new Set<string>();
    if (keyMarker && versionIdMarker) seen.add(encodeCursor(keyMarker, versionIdMarker, prefix));
    while (versions.length < maximum && examined < MAX_LIST_ENTRIES && pages < MAX_LIST_PAGES) {
      operation.signal.throwIfAborted();
      pages += 1;
      const pageBudget = Math.min(MAX_LIST_RESULTS, MAX_LIST_ENTRIES - examined, maximum - versions.length);
      const page = await operation.listObjectVersionsPage({
        KeyMarker: keyMarker,
        MaxKeys: pageBudget,
        Prefix: prefix,
        VersionIdMarker: versionIdMarker,
      });
      const pageEntries = (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
      examined += pageEntries;
      for (const version of page.Versions ?? []) {
        const key = version.Key ?? "";
        const identity = parseArtifactKey(key, prefix);
        if (
          !version.VersionId ||
          version.VersionId.length > 1_024 ||
          !Number.isSafeInteger(version.Size) ||
          version.Size! < 1 ||
          version.Size! > MAX_SNAPSHOT_ARTIFACT_BYTES_V1 ||
          !(version.LastModified instanceof Date) ||
          !Number.isFinite(version.LastModified.getTime())
        ) {
          throw new Error("S3 returned invalid snapshot-version metadata.");
        }
        const artifact = parseVersionedSnapshotArtifactReceiptV1(tenant, {
          ...identity,
          byteSize: version.Size!,
          etag: normalizeEtag(version.ETag),
          objectKey: key,
          versionId: version.VersionId,
        });
        if (version.LastModified < cutoff) versions.push({ artifact, lastModified: version.LastModified });
      }
      if (!page.IsTruncated) {
        nextCursor = null;
        break;
      }
      nextCursor = encodeCursor(page.NextKeyMarker!, page.NextVersionIdMarker!, prefix);
      if (seen.has(nextCursor)) throw new Error("S3 returned a cycling version-list cursor.");
      seen.add(nextCursor);
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
    return { nextCursor, versions };
  }

  async deleteVersion(tenantValue: string, artifactValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const artifact = parseVersionedSnapshotArtifactReceiptV1(tenantId(tenantValue), artifactValue);
    const operation = this.#transport.operation(signal);
    operation.signal.throwIfAborted();
    await operation.deleteObjectVersion({ Key: artifact.objectKey, VersionId: artifact.versionId });
    operation.signal.throwIfAborted();
  }

  close() {
    return this.#transport.close();
  }
}

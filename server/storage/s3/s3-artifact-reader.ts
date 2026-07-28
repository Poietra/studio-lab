import { createHash } from "node:crypto";

import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  MAX_RENDER_ARTIFACT_BYTES_V1,
  parseRenderArtifactReceiptV1,
  RenderArtifactReadErrorV1,
  renderArtifactObjectKeyV1,
  type RenderArtifactReceiptV1,
  type RenderArtifactStoreV1,
} from "../render-artifact-repository";
import {
  acquirePrivateVersionedS3BucketTransportV1,
  type PrivateVersionedS3BucketConsumerOptionsV1,
  type PrivateVersionedS3BucketOperationV1,
  type PrivateVersionedS3BucketTransportLeaseV1,
} from "./s3-private-versioned-bucket-transport";

const MAX_CONDITIONAL_PUT_ATTEMPTS = 3;
const MAX_LIST_RESULTS = 256;
const SHA256 = /^[0-9a-f]{64}$/u;
const METADATA = {
  artifactDigest: "artifact-digest",
  kind: "artifact-kind",
  profileDigest: "profile-digest",
  requestDigest: "request-digest",
  runtimeDigest: "runtime-digest",
  sourceDigest: "source-digest",
} as const;

type VersionCursor = Readonly<{ KeyMarker?: string; VersionIdMarker?: string }>;

function tenantId(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Tenant ID is invalid.");
  return parsed.data;
}

function mediaPrefix(tenant: string) {
  return `tenants/${tenant}/media/`;
}

function parseObjectKey(key: string, tenant: string) {
  const prefix = mediaPrefix(tenant);
  if (typeof key !== "string" || !key.startsWith(prefix)) {
    throw new Error("S3 returned a render artifact key outside the tenant prefix.");
  }
  const [kind, sourceDigest, runtimeDigest, profileDigest, requestDigest, artifactDigest, ...extra] = key
    .slice(prefix.length)
    .split("/");
  if (
    extra.length > 0 ||
    (kind !== "thumbnail" && kind !== "video") ||
    !sourceDigest ||
    !runtimeDigest ||
    !profileDigest ||
    !requestDigest ||
    !artifactDigest ||
    ![sourceDigest, runtimeDigest, profileDigest, requestDigest, artifactDigest].every((value) => SHA256.test(value))
  ) {
    throw new Error("S3 returned an invalid render artifact key.");
  }
  return {
    artifactDigest,
    kind,
    profileDigest,
    requestDigest,
    runtimeDigest,
    sourceDigest,
  } as const;
}

function normalizedEtag(value: string | undefined) {
  if (!value || value.length > 512) throw new Error("S3 did not return a bounded render artifact ETag.");
  return value;
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

function isMissing(error: unknown) {
  return (
    isNamedError(error, "NoSuchKey") ||
    isNamedError(error, "NoSuchVersion") ||
    isNamedError(error, "NotFound") ||
    statusCode(error) === 404
  );
}

function isPreconditionFailed(error: unknown) {
  return isNamedError(error, "PreconditionFailed") || statusCode(error) === 412;
}

function isConditionalConflict(error: unknown) {
  return isNamedError(error, "ConditionalRequestConflict") || statusCode(error) === 409;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

function bodyIterable(body: unknown): AsyncIterable<unknown> {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    destroyBody(body);
    throw new RenderArtifactReadErrorV1("corrupt");
  }
  return body as AsyncIterable<unknown>;
}

function responseMetadata(value: Record<string, string> | undefined, expected: RenderArtifactReceiptV1) {
  return (
    value?.[METADATA.artifactDigest] === expected.artifactDigest &&
    value[METADATA.kind] === expected.kind &&
    value[METADATA.profileDigest] === expected.profileDigest &&
    value[METADATA.requestDigest] === expected.requestDigest &&
    value[METADATA.runtimeDigest] === expected.runtimeDigest &&
    value[METADATA.sourceDigest] === expected.sourceDigest &&
    Object.keys(value).length === Object.keys(METADATA).length
  );
}

function objectMetadata(receipt: RenderArtifactReceiptV1) {
  return {
    [METADATA.artifactDigest]: receipt.artifactDigest,
    [METADATA.kind]: receipt.kind,
    [METADATA.profileDigest]: receipt.profileDigest,
    [METADATA.requestDigest]: receipt.requestDigest,
    [METADATA.runtimeDigest]: receipt.runtimeDigest,
    [METADATA.sourceDigest]: receipt.sourceDigest,
  };
}

function contentType(kind: RenderArtifactReceiptV1["kind"]) {
  return kind === "video" ? "video/mp4" : "image/png";
}

function receiptFromResponse(
  tenant: string,
  input: Omit<RenderArtifactReceiptV1, "etag" | "objectKey" | "versionId">,
  response: Readonly<{
    ContentLength?: number;
    ContentType?: string;
    ETag?: string;
    Metadata?: Record<string, string>;
    VersionId?: string;
  }>,
) {
  const candidate = parseRenderArtifactReceiptV1(tenant, {
    ...input,
    etag: normalizedEtag(response.ETag),
    objectKey: renderArtifactObjectKeyV1(tenant, input),
    versionId: response.VersionId ?? "",
  });
  if (
    response.ContentLength !== candidate.byteSize ||
    response.ContentType !== candidate.mediaType ||
    !responseMetadata(response.Metadata, candidate)
  ) {
    throw new RenderArtifactReadErrorV1("corrupt");
  }
  return candidate;
}

function decodeCursor(value: string | null | undefined, tenant: string): VersionCursor {
  if (value === null || value === undefined) return {};
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) throw new TypeError("Render artifact cursor is invalid.");
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      parsed[1].length < 1 ||
      parsed[1].length > 1_024
    ) {
      throw new Error();
    }
    parseObjectKey(parsed[0], tenant);
    return { KeyMarker: parsed[0], VersionIdMarker: parsed[1] };
  } catch {
    throw new TypeError("Render artifact cursor is invalid.");
  }
}

function encodeCursor(key: string, version: string, tenant: string) {
  parseObjectKey(key, tenant);
  if (typeof version !== "string" || version.length < 1 || version.length > 1_024) {
    throw new Error("S3 returned an invalid render artifact cursor.");
  }
  return Buffer.from(JSON.stringify([key, version]), "utf8").toString("base64url");
}

async function collectAndVerify(body: unknown, receipt: RenderArtifactReceiptV1, signal: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of bodyIterable(body)) {
      signal.throwIfAborted();
      const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
      if (!chunk) throw new RenderArtifactReadErrorV1("corrupt");
      bytes += chunk.byteLength;
      if (bytes > receipt.byteSize || bytes > MAX_RENDER_ARTIFACT_BYTES_V1) {
        throw new RenderArtifactReadErrorV1("corrupt");
      }
      hash.update(chunk);
    }
    if (bytes !== receipt.byteSize || hash.digest("hex") !== receipt.artifactDigest) {
      throw new RenderArtifactReadErrorV1("corrupt");
    }
  } catch (error) {
    destroyBody(body);
    throw error;
  }
}

function verifiedStream(body: unknown, expectedBytes: number, signal: AbortSignal) {
  return (async function* () {
    let bytes = 0;
    try {
      for await (const value of bodyIterable(body)) {
        signal.throwIfAborted();
        const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
        if (!chunk) throw new RenderArtifactReadErrorV1("corrupt");
        bytes += chunk.byteLength;
        if (bytes > expectedBytes) throw new RenderArtifactReadErrorV1("corrupt");
        yield chunk;
      }
      if (bytes !== expectedBytes) throw new RenderArtifactReadErrorV1("corrupt");
    } finally {
      destroyBody(body);
    }
  })();
}

export type S3ArtifactReaderOptionsV1 = PrivateVersionedS3BucketConsumerOptionsV1;

/** Immutable media writer plus version-pinned HEAD/range reader over the shared private S3 transport. */
export class S3ArtifactReaderV1 implements RenderArtifactStoreV1 {
  readonly #transport: PrivateVersionedS3BucketTransportLeaseV1;

  constructor(options: S3ArtifactReaderOptionsV1) {
    this.#transport = acquirePrivateVersionedS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #get(
    tenant: string,
    receiptValue: RenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const receipt = parseRenderArtifactReceiptV1(tenant, receiptValue);
    const expectedBytes = range ? range.end - range.start + 1 : receipt.byteSize;
    let response;
    try {
      response = await operation.getObject({
        Key: receipt.objectKey,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        VersionId: receipt.versionId,
      });
    } catch (error) {
      if (isMissing(error)) throw new RenderArtifactReadErrorV1("missing");
      throw error;
    }
    try {
      const expectedRange = range ? `bytes ${range.start}-${range.end}/${receipt.byteSize}` : undefined;
      if (
        response.VersionId !== receipt.versionId ||
        response.ContentLength !== expectedBytes ||
        response.ContentType !== receipt.mediaType ||
        normalizedEtag(response.ETag) !== receipt.etag ||
        !responseMetadata(response.Metadata, receipt) ||
        (range ? response.ContentRange !== expectedRange : response.ContentRange !== undefined)
      ) {
        throw new RenderArtifactReadErrorV1("corrupt");
      }
      return { body: response.Body, expectedBytes, receipt };
    } catch (error) {
      destroyBody(response.Body);
      if (error instanceof RenderArtifactReadErrorV1) throw error;
      throw new RenderArtifactReadErrorV1("corrupt");
    }
  }

  async #readCurrent(
    tenant: string,
    input: Omit<RenderArtifactReceiptV1, "etag" | "objectKey" | "versionId">,
    operation: PrivateVersionedS3BucketOperationV1,
  ) {
    const objectKey = renderArtifactObjectKeyV1(tenant, input);
    let response;
    try {
      response = await operation.getObject({ Key: objectKey });
    } catch (error) {
      if (isMissing(error)) throw new RenderArtifactReadErrorV1("missing");
      throw error;
    }
    let receipt: RenderArtifactReceiptV1;
    try {
      receipt = receiptFromResponse(tenant, input, response);
    } catch (error) {
      destroyBody(response.Body);
      throw error;
    }
    await collectAndVerify(response.Body, receipt, operation.signal);
    return receipt;
  }

  async put(
    tenantValue: string,
    input: Omit<RenderArtifactReceiptV1, "etag" | "objectKey" | "versionId"> & Readonly<{ bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== input.byteSize) {
      throw new TypeError("Render artifact bytes are invalid.");
    }
    // The verified publisher already owns this immutable buffer for the
    // duration of the call. Copying it would double the 128 MiB worker cap.
    const bytes = input.bytes;
    if (createHash("sha256").update(bytes).digest("hex") !== input.artifactDigest) {
      throw new TypeError("Render artifact bytes do not match their digest.");
    }
    const provisional = parseRenderArtifactReceiptV1(tenant, {
      ...input,
      etag: "pending",
      objectKey: renderArtifactObjectKeyV1(tenant, input),
      versionId: "pending",
    });
    const operation = this.#transport.operation(signal);
    let response;
    for (let attempt = 1; attempt <= MAX_CONDITIONAL_PUT_ATTEMPTS; attempt += 1) {
      try {
        response = await operation.putObject({
          Body: bytes,
          ChecksumSHA256: Buffer.from(provisional.artifactDigest, "hex").toString("base64"),
          ContentLength: bytes.byteLength,
          ContentType: provisional.mediaType,
          IfNoneMatch: "*",
          Key: provisional.objectKey,
          Metadata: objectMetadata(provisional),
        });
        break;
      } catch (error) {
        if (isPreconditionFailed(error)) return this.#readCurrent(tenant, input, operation);
        if (!isConditionalConflict(error) || attempt === MAX_CONDITIONAL_PUT_ATTEMPTS) throw error;
        operation.signal.throwIfAborted();
      }
    }
    if (!response) throw new Error("S3 did not settle the bounded render artifact upload.");
    const receipt = parseRenderArtifactReceiptV1(tenant, {
      ...provisional,
      etag: normalizedEtag(response.ETag),
      versionId: response.VersionId ?? "",
    });
    const stored = await this.#get(tenant, receipt, null, operation);
    await collectAndVerify(stored.body, receipt, operation.signal);
    return receipt;
  }

  async head(tenantValue: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const receipt = parseRenderArtifactReceiptV1(tenant, receiptValue);
    let response;
    try {
      response = await this.#transport.operation(signal).headObject({
        Key: receipt.objectKey,
        VersionId: receipt.versionId,
      });
    } catch (error) {
      if (isMissing(error)) throw new RenderArtifactReadErrorV1("missing");
      throw error;
    }
    if (
      response.VersionId !== receipt.versionId ||
      response.ContentLength !== receipt.byteSize ||
      response.ContentType !== receipt.mediaType ||
      normalizedEtag(response.ETag) !== receipt.etag ||
      !responseMetadata(response.Metadata, receipt)
    ) {
      throw new RenderArtifactReadErrorV1("corrupt");
    }
  }

  async open(
    tenantValue: string,
    receiptValue: RenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const receipt = parseRenderArtifactReceiptV1(tenant, receiptValue);
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end >= receipt.byteSize)
    ) {
      throw new RangeError("Render artifact byte range is invalid.");
    }
    const operation = this.#transport.operation(signal);
    const opened = await this.#get(tenant, receipt, range, operation);
    return verifiedStream(opened.body, opened.expectedBytes, operation.signal);
  }

  async listVersions(
    tenantValue: string,
    cutoff: Date,
    maximumValue: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new TypeError("Artifact cutoff is invalid.");
    if (!Number.isSafeInteger(maximumValue) || maximumValue < 1 || maximumValue > MAX_LIST_RESULTS) {
      throw new RangeError("maximum must be an integer between 1 and 256.");
    }
    const decoded = decodeCursor(cursor, tenant);
    const page = await this.#transport.operation(signal).listObjectVersionsPage({
      ...decoded,
      MaxKeys: maximumValue,
      Prefix: mediaPrefix(tenant),
    });
    const versions = (page.Versions ?? []).flatMap((version) => {
      if (!(version.LastModified instanceof Date) || version.LastModified >= cutoff) return [];
      const key = version.Key;
      if (
        !key ||
        typeof version.VersionId !== "string" ||
        !Number.isSafeInteger(version.Size) ||
        version.Size! < 1 ||
        version.Size! > MAX_RENDER_ARTIFACT_BYTES_V1
      ) {
        throw new Error("S3 returned invalid render artifact version metadata.");
      }
      const identity = parseObjectKey(key, tenant);
      return [
        {
          lastModified: version.LastModified,
          receipt: parseRenderArtifactReceiptV1(tenant, {
            ...identity,
            byteSize: version.Size,
            etag: normalizedEtag(version.ETag),
            mediaType: contentType(identity.kind),
            objectKey: key,
            versionId: version.VersionId,
          }),
        },
      ];
    });
    const nextCursor = page.IsTruncated ? encodeCursor(page.NextKeyMarker!, page.NextVersionIdMarker!, tenant) : null;
    return { nextCursor, versions };
  }

  async deleteVersion(tenantValue: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const receipt = parseRenderArtifactReceiptV1(tenant, receiptValue);
    await this.#transport.operation(signal).deleteObjectVersion({
      Key: receipt.objectKey,
      VersionId: receipt.versionId,
    });
  }

  close() {
    return this.#transport.close();
  }
}

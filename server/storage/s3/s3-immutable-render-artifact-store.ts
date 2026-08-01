import { createHash } from "node:crypto";

import {
  createImmutableRenderArtifactLocatorV1,
  type ImmutableRenderArtifactIdentityV1,
  type ImmutableRenderArtifactReceiptV1,
  type ImmutableRenderArtifactStoreV1,
  immutableRenderArtifactMediaPrefixV1,
  immutableRenderArtifactMediaTypeV1,
  immutableRenderArtifactMetadataMatchesV1,
  immutableRenderArtifactMetadataV1,
  parseImmutableRenderArtifactIdentityV1,
  parseImmutableRenderArtifactObjectKeyV1,
  parseImmutableRenderArtifactReceiptV1,
} from "../immutable-render-artifact-storage";
import {
  MAX_RENDER_ARTIFACT_BYTES_V1,
  RenderArtifactReadErrorV1,
  type RenderArtifactReceiptV1,
} from "../render-artifact-repository";
import {
  acquirePrivateImmutableS3BucketTransportV1,
  type PrivateImmutableObjectResponseV1,
  type PrivateImmutableS3BucketConsumerOptionsV1,
  type PrivateImmutableS3BucketOperationV1,
  type PrivateImmutableS3BucketTransportLeaseV1,
} from "./s3-private-immutable-bucket-transport";

const MAX_GENERATION_ATTEMPTS_V1 = 3;
const MAX_LIST_RESULTS_V1 = 256;

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
  return isNamedError(error, "NoSuchKey") || isNamedError(error, "NotFound") || statusCode(error) === 404;
}

function isPreconditionFailed(error: unknown) {
  return isNamedError(error, "PreconditionFailed") || statusCode(error) === 412;
}

function rethrowReadFailure(error: unknown): never {
  if (error instanceof RenderArtifactReadErrorV1) throw error;
  if (isMissing(error)) throw new RenderArtifactReadErrorV1("missing");
  if (isPreconditionFailed(error)) throw new RenderArtifactReadErrorV1("corrupt");
  throw error;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

function bodyIterable(body: unknown): AsyncIterable<unknown> {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw new RenderArtifactReadErrorV1("corrupt");
  }
  return body as AsyncIterable<unknown>;
}

async function collectAndVerify(body: unknown, expectedBytes: number, expectedDigest: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of bodyIterable(body)) {
      signal.throwIfAborted();
      if (!(value instanceof Uint8Array)) throw new RenderArtifactReadErrorV1("corrupt");
      bytes += value.byteLength;
      if (bytes > expectedBytes || bytes > MAX_RENDER_ARTIFACT_BYTES_V1) {
        throw new RenderArtifactReadErrorV1("corrupt");
      }
      hash.update(value);
    }
    signal.throwIfAborted();
    if (bytes !== expectedBytes || hash.digest("hex") !== expectedDigest) {
      throw new RenderArtifactReadErrorV1("corrupt");
    }
  } finally {
    destroyBody(body);
  }
}

function verifiedStream(body: unknown, expectedBytes: number, expectedDigest: string | null, signal: AbortSignal) {
  return (async function* () {
    const hash = expectedDigest === null ? null : createHash("sha256");
    let bytes = 0;
    try {
      for await (const value of bodyIterable(body)) {
        signal.throwIfAborted();
        if (!(value instanceof Uint8Array)) throw new RenderArtifactReadErrorV1("corrupt");
        bytes += value.byteLength;
        if (bytes > expectedBytes) throw new RenderArtifactReadErrorV1("corrupt");
        hash?.update(value);
        yield value;
      }
      signal.throwIfAborted();
      if (bytes !== expectedBytes || (hash && hash.digest("hex") !== expectedDigest)) {
        throw new RenderArtifactReadErrorV1("corrupt");
      }
    } finally {
      destroyBody(body);
    }
  })();
}

function validResponseMetadata(response: PrivateImmutableObjectResponseV1, receipt: ImmutableRenderArtifactReceiptV1) {
  return (
    response.contentType === receipt.mediaType && immutableRenderArtifactMetadataMatchesV1(response.metadata, receipt)
  );
}

export type S3ImmutableRenderArtifactStoreOptionsV1 = PrivateImmutableS3BucketConsumerOptionsV1;

/** Additive R2/S3 media lane backed only by application-owned immutable keys. */
export class S3ImmutableRenderArtifactStoreV1 implements ImmutableRenderArtifactStoreV1 {
  readonly #transport: PrivateImmutableS3BucketTransportLeaseV1;

  constructor(options: S3ImmutableRenderArtifactStoreOptionsV1) {
    this.#transport = acquirePrivateImmutableS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #get(
    receipt: ImmutableRenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    operation: PrivateImmutableS3BucketOperationV1,
  ) {
    let response: PrivateImmutableObjectResponseV1;
    try {
      response = await operation.getObject({
        byteSize: receipt.byteSize,
        etag: receipt.etag,
        objectKey: receipt.objectKey,
        ...(range === null ? {} : { range }),
      });
    } catch (error) {
      return rethrowReadFailure(error);
    }
    if (!validResponseMetadata(response, receipt)) {
      destroyBody(response.body);
      throw new RenderArtifactReadErrorV1("corrupt");
    }
    return response;
  }

  async put(
    tenantId: string,
    input: ImmutableRenderArtifactIdentityV1 & Readonly<{ bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    if (!input || typeof input !== "object") throw new TypeError("Immutable render artifact input is invalid.");
    const { bytes, ...identityValue } = input;
    const identity = parseImmutableRenderArtifactIdentityV1(tenantId, identityValue);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== identity.byteSize) {
      throw new TypeError("Immutable render artifact bytes are invalid.");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== identity.artifactDigest) {
      throw new TypeError("Immutable render artifact bytes do not match their digest.");
    }

    const operation = this.#transport.operation(signal);
    const attemptedKeys = new Set<string>();
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS_V1; attempt += 1) {
      operation.signal.throwIfAborted();
      const locator = createImmutableRenderArtifactLocatorV1(tenantId, identity);
      if (attemptedKeys.has(locator.objectKey)) {
        throw new Error("The immutable object generation allocator reused a render artifact key.");
      }
      attemptedKeys.add(locator.objectKey);
      const result = await operation.putObject({
        body: bytes,
        contentType: identity.mediaType,
        metadata: immutableRenderArtifactMetadataV1({ ...identity, ...locator }),
        objectKey: locator.objectKey,
      });
      if (result.kind === "already-exists") continue;

      const receipt = parseImmutableRenderArtifactReceiptV1(tenantId, {
        ...identity,
        ...locator,
        etag: result.etag,
      });
      const stored = await this.#get(receipt, null, operation);
      await collectAndVerify(stored.body, receipt.byteSize, receipt.artifactDigest, operation.signal);
      return receipt;
    }
    throw new Error("Could not allocate a unique immutable render artifact generation after three attempts.");
  }

  async head(tenantId: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseImmutableRenderArtifactReceiptV1(tenantId, receiptValue);
    let response;
    try {
      response = await this.#transport.operation(signal).headObject({
        byteSize: receipt.byteSize,
        etag: receipt.etag,
        objectKey: receipt.objectKey,
      });
    } catch (error) {
      return rethrowReadFailure(error);
    }
    if (
      response.contentType !== receipt.mediaType ||
      !immutableRenderArtifactMetadataMatchesV1(response.metadata, receipt)
    ) {
      throw new RenderArtifactReadErrorV1("corrupt");
    }
  }

  async open(
    tenantId: string,
    receiptValue: RenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ) {
    const receipt = parseImmutableRenderArtifactReceiptV1(tenantId, receiptValue);
    const operation = this.#transport.operation(signal);
    const response = await this.#get(receipt, range, operation);
    const expectedBytes = range === null ? receipt.byteSize : range.end - range.start + 1;
    return verifiedStream(
      response.body,
      expectedBytes,
      range === null ? receipt.artifactDigest : null,
      operation.signal,
    );
  }

  async listObjects(tenantId: string, cutoff: Date, maximum: number, cursor?: string | null, signal?: AbortSignal) {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
      throw new TypeError("Immutable render artifact cutoff is invalid.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LIST_RESULTS_V1) {
      throw new RangeError("Immutable render artifact list maximum must be between 1 and 256.");
    }
    const page = await this.#transport.operation(signal).listObjectsPage({
      ...(cursor === null || cursor === undefined ? {} : { cursor }),
      maximum,
      prefix: immutableRenderArtifactMediaPrefixV1(tenantId),
    });
    const objects = page.objects.flatMap((object) => {
      if (object.lastModified >= cutoff) return [];
      const identity = parseImmutableRenderArtifactObjectKeyV1(tenantId, object.objectKey);
      const receipt = parseImmutableRenderArtifactReceiptV1(tenantId, {
        ...identity,
        byteSize: object.byteSize,
        etag: object.etag,
        mediaType: immutableRenderArtifactMediaTypeV1(identity.kind),
      });
      return [{ lastModified: new Date(object.lastModified.getTime()), receipt }];
    });
    return { nextCursor: page.nextCursor, objects };
  }

  async deleteObject(tenantId: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseImmutableRenderArtifactReceiptV1(tenantId, receiptValue);
    await this.#transport.operation(signal).deleteObject(receipt.objectKey);
  }

  close() {
    return this.#transport.close();
  }
}

import { createHash } from "node:crypto";

import {
  CLIENT_EXPORT_MEDIA_TYPE_V1,
  type ClientExportArtifactReceiptV1,
  type ClientExportArtifactStoreV1,
  ClientExportReadErrorV1,
  clientExportByteSizeV1,
  clientExportMediaPrefixV1,
  createClientExportArtifactLocatorV1,
  MAX_CLIENT_EXPORT_VIDEO_BYTES_V1,
  parseClientExportArtifactReceiptV1,
  parseClientExportObjectKeyV1,
} from "../client-export-contract";
import {
  acquirePrivateImmutableS3BucketTransportV1,
  type PrivateImmutableObjectResponseV1,
  type PrivateImmutableS3BucketConsumerOptionsV1,
  type PrivateImmutableS3BucketOperationV1,
  type PrivateImmutableS3BucketTransportLeaseV1,
} from "./s3-private-immutable-bucket-transport";

const MAX_LOCATOR_TOKEN_ATTEMPTS_V1 = 3;
const MAX_LIST_RESULTS_V1 = 256;

const METADATA_FIELDS = {
  contentDigest: "content-digest",
  objectLocatorToken: "object-locator-token",
} as const;

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
  if (error instanceof ClientExportReadErrorV1) throw error;
  if (isMissing(error)) throw new ClientExportReadErrorV1("missing");
  if (isPreconditionFailed(error)) throw new ClientExportReadErrorV1("corrupt");
  throw error;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

function bodyIterable(body: unknown): AsyncIterable<unknown> {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw new ClientExportReadErrorV1("corrupt");
  }
  return body as AsyncIterable<unknown>;
}

async function collectAndVerify(body: unknown, expectedBytes: number, expectedDigest: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of bodyIterable(body)) {
      signal.throwIfAborted();
      if (!(value instanceof Uint8Array)) throw new ClientExportReadErrorV1("corrupt");
      bytes += value.byteLength;
      if (bytes > expectedBytes || bytes > MAX_CLIENT_EXPORT_VIDEO_BYTES_V1) {
        throw new ClientExportReadErrorV1("corrupt");
      }
      hash.update(value);
    }
    signal.throwIfAborted();
    if (bytes !== expectedBytes || hash.digest("hex") !== expectedDigest) {
      throw new ClientExportReadErrorV1("corrupt");
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
        if (!(value instanceof Uint8Array)) throw new ClientExportReadErrorV1("corrupt");
        bytes += value.byteLength;
        if (bytes > expectedBytes) throw new ClientExportReadErrorV1("corrupt");
        hash?.update(value);
        yield value;
      }
      signal.throwIfAborted();
      if (bytes !== expectedBytes || (hash && hash.digest("hex") !== expectedDigest)) {
        throw new ClientExportReadErrorV1("corrupt");
      }
    } finally {
      destroyBody(body);
    }
  })();
}

function clientExportMetadataV1(receipt: Pick<ClientExportArtifactReceiptV1, "contentDigest" | "objectLocatorToken">) {
  return {
    [METADATA_FIELDS.contentDigest]: receipt.contentDigest,
    [METADATA_FIELDS.objectLocatorToken]: receipt.objectLocatorToken,
  };
}

function clientExportMetadataMatchesV1(
  value: Readonly<Record<string, string>>,
  expected: ClientExportArtifactReceiptV1,
) {
  const canonical: Readonly<Record<string, string>> = clientExportMetadataV1(expected);
  const keys = Object.keys(value);
  return keys.length === Object.keys(canonical).length && keys.every((key) => value[key] === canonical[key]);
}

export type S3ClientExportArtifactStoreOptionsV1 = PrivateImmutableS3BucketConsumerOptionsV1;

/** Immutable-locator-lane R2/S3 store for accepted client-export MP4 bytes. */
export class S3ClientExportArtifactStoreV1 implements ClientExportArtifactStoreV1 {
  readonly #transport: PrivateImmutableS3BucketTransportLeaseV1;

  constructor(options: S3ClientExportArtifactStoreOptionsV1) {
    this.#transport = acquirePrivateImmutableS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #get(
    receipt: ClientExportArtifactReceiptV1,
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
    if (response.contentType !== receipt.mediaType || !clientExportMetadataMatchesV1(response.metadata, receipt)) {
      destroyBody(response.body);
      throw new ClientExportReadErrorV1("corrupt");
    }
    return response;
  }

  async put(
    tenantId: string,
    input: Readonly<{ byteSize: number; bytes: Uint8Array; contentDigest: string }>,
    signal?: AbortSignal,
  ) {
    if (!input || typeof input !== "object") throw new TypeError("Client export artifact input is invalid.");
    const byteSize = clientExportByteSizeV1(input.byteSize);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== byteSize) {
      throw new TypeError("Client export artifact bytes are invalid.");
    }
    if (createHash("sha256").update(input.bytes).digest("hex") !== input.contentDigest) {
      throw new TypeError("Client export artifact bytes do not match their digest.");
    }

    const operation = this.#transport.operation(signal);
    const attemptedKeys = new Set<string>();
    for (let attempt = 0; attempt < MAX_LOCATOR_TOKEN_ATTEMPTS_V1; attempt += 1) {
      operation.signal.throwIfAborted();
      const locator = createClientExportArtifactLocatorV1(tenantId, input.contentDigest);
      if (attemptedKeys.has(locator.objectKey)) {
        throw new Error("The immutable object locator token allocator reused a client export key.");
      }
      attemptedKeys.add(locator.objectKey);
      const result = await operation.putObject({
        body: input.bytes,
        contentType: CLIENT_EXPORT_MEDIA_TYPE_V1,
        metadata: clientExportMetadataV1({
          contentDigest: input.contentDigest,
          objectLocatorToken: locator.objectLocatorToken,
        }),
        objectKey: locator.objectKey,
      });
      if (result.kind === "already-exists") continue;

      const receipt = parseClientExportArtifactReceiptV1(tenantId, {
        byteSize,
        contentDigest: input.contentDigest,
        etag: result.etag,
        mediaType: CLIENT_EXPORT_MEDIA_TYPE_V1,
        objectKey: locator.objectKey,
        objectLocatorToken: locator.objectLocatorToken,
      });
      const stored = await this.#get(receipt, null, operation);
      await collectAndVerify(stored.body, receipt.byteSize, receipt.contentDigest, operation.signal);
      return receipt;
    }
    throw new Error("Could not allocate a unique client export locator token after three attempts.");
  }

  async head(tenantId: string, receiptValue: ClientExportArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseClientExportArtifactReceiptV1(tenantId, receiptValue);
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
    if (response.contentType !== receipt.mediaType || !clientExportMetadataMatchesV1(response.metadata, receipt)) {
      throw new ClientExportReadErrorV1("corrupt");
    }
  }

  async open(
    tenantId: string,
    receiptValue: ClientExportArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ) {
    const receipt = parseClientExportArtifactReceiptV1(tenantId, receiptValue);
    const operation = this.#transport.operation(signal);
    const response = await this.#get(receipt, range, operation);
    const expectedBytes = range === null ? receipt.byteSize : range.end - range.start + 1;
    return verifiedStream(
      response.body,
      expectedBytes,
      range === null ? receipt.contentDigest : null,
      operation.signal,
    );
  }

  async listObjects(tenantId: string, cutoff: Date, maximum: number, cursor?: string | null, signal?: AbortSignal) {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
      throw new TypeError("Client export listing cutoff is invalid.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LIST_RESULTS_V1) {
      throw new RangeError("Client export list maximum must be between 1 and 256.");
    }
    const page = await this.#transport.operation(signal).listObjectsPage({
      ...(cursor === null || cursor === undefined ? {} : { cursor }),
      maximum,
      prefix: clientExportMediaPrefixV1(tenantId),
    });
    const objects = page.objects.flatMap((object) => {
      if (object.lastModified >= cutoff) return [];
      const identity = parseClientExportObjectKeyV1(tenantId, object.objectKey);
      const receipt = parseClientExportArtifactReceiptV1(tenantId, {
        byteSize: object.byteSize,
        contentDigest: identity.contentDigest,
        etag: object.etag,
        mediaType: CLIENT_EXPORT_MEDIA_TYPE_V1,
        objectKey: object.objectKey,
        objectLocatorToken: identity.objectLocatorToken,
      });
      return [{ lastModified: new Date(object.lastModified.getTime()), receipt }];
    });
    return { nextCursor: page.nextCursor, objects };
  }

  async deleteObject(tenantId: string, receiptValue: ClientExportArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseClientExportArtifactReceiptV1(tenantId, receiptValue);
    await this.#transport.operation(signal).deleteObject(receipt.objectKey);
  }

  close() {
    return this.#transport.close();
  }
}

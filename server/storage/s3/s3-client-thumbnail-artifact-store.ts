import { createHash } from "node:crypto";

import {
  CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
  type ClientThumbnailArtifactReceiptV1,
  type ClientThumbnailArtifactStoreV1,
  ClientThumbnailReadErrorV1,
  createClientThumbnailArtifactLocatorV1,
  MAX_CLIENT_THUMBNAIL_BYTES_V1,
  parseClientThumbnailArtifactReceiptV1,
} from "../client-thumbnail-contract";
import {
  acquirePrivateImmutableS3BucketTransportV1,
  type PrivateImmutableS3BucketConsumerOptionsV1,
  type PrivateImmutableS3BucketOperationV1,
  type PrivateImmutableS3BucketTransportLeaseV1,
} from "./s3-private-immutable-bucket-transport";

const MAX_LOCATOR_ATTEMPTS = 3;
const METADATA_FIELDS = { contentDigest: "content-digest", objectLocatorToken: "object-locator-token" } as const;

function namedError(error: unknown, name: string) {
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

function readFailure(error: unknown): never {
  if (error instanceof ClientThumbnailReadErrorV1) throw error;
  if (namedError(error, "NoSuchKey") || namedError(error, "NotFound") || statusCode(error) === 404) {
    throw new ClientThumbnailReadErrorV1("missing");
  }
  if (namedError(error, "PreconditionFailed") || statusCode(error) === 412) {
    throw new ClientThumbnailReadErrorV1("corrupt");
  }
  throw error;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

function metadata(receipt: Pick<ClientThumbnailArtifactReceiptV1, "contentDigest" | "objectLocatorToken">) {
  return {
    [METADATA_FIELDS.contentDigest]: receipt.contentDigest,
    [METADATA_FIELDS.objectLocatorToken]: receipt.objectLocatorToken,
  };
}

function metadataMatches(value: Readonly<Record<string, string>>, receipt: ClientThumbnailArtifactReceiptV1) {
  const expected: Readonly<Record<string, string>> = metadata(receipt);
  const keys = Object.keys(value);
  return keys.length === 2 && keys.every((key) => value[key] === expected[key]);
}

async function collect(body: unknown, receipt: ClientThumbnailArtifactReceiptV1, signal: AbortSignal) {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    destroyBody(body);
    throw new ClientThumbnailReadErrorV1("corrupt");
  }
  const output = Buffer.alloc(receipt.byteSize);
  const hash = createHash("sha256");
  let offset = 0;
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      signal.throwIfAborted();
      if (!(value instanceof Uint8Array) || offset + value.byteLength > output.byteLength) {
        throw new ClientThumbnailReadErrorV1("corrupt");
      }
      output.set(value, offset);
      hash.update(value);
      offset += value.byteLength;
    }
    signal.throwIfAborted();
    if (offset !== output.byteLength || hash.digest("hex") !== receipt.contentDigest) {
      throw new ClientThumbnailReadErrorV1("corrupt");
    }
    return output;
  } finally {
    destroyBody(body);
  }
}

export type S3ClientThumbnailArtifactStoreOptionsV1 = PrivateImmutableS3BucketConsumerOptionsV1;

/** Private immutable R2/S3 store for browser-rendered project thumbnails. */
export class S3ClientThumbnailArtifactStoreV1 implements ClientThumbnailArtifactStoreV1 {
  readonly #transport: PrivateImmutableS3BucketTransportLeaseV1;

  constructor(options: S3ClientThumbnailArtifactStoreOptionsV1) {
    this.#transport = acquirePrivateImmutableS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #read(receipt: ClientThumbnailArtifactReceiptV1, operation: PrivateImmutableS3BucketOperationV1) {
    let response;
    try {
      response = await operation.getObject({
        byteSize: receipt.byteSize,
        etag: receipt.etag,
        objectKey: receipt.objectKey,
      });
    } catch (error) {
      return readFailure(error);
    }
    if (response.contentType !== CLIENT_THUMBNAIL_MEDIA_TYPE_V1 || !metadataMatches(response.metadata, receipt)) {
      destroyBody(response.body);
      throw new ClientThumbnailReadErrorV1("corrupt");
    }
    return collect(response.body, receipt, operation.signal);
  }

  async put(tenantId: string, input: Readonly<{ bytes: Uint8Array; contentDigest: string }>, signal?: AbortSignal) {
    if (
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > MAX_CLIENT_THUMBNAIL_BYTES_V1 ||
      createHash("sha256").update(input.bytes).digest("hex") !== input.contentDigest
    ) {
      throw new TypeError("Client thumbnail artifact bytes are invalid.");
    }
    const operation = this.#transport.operation(signal);
    const attemptedKeys = new Set<string>();
    for (let attempt = 0; attempt < MAX_LOCATOR_ATTEMPTS; attempt += 1) {
      operation.signal.throwIfAborted();
      const locator = createClientThumbnailArtifactLocatorV1(tenantId, input.contentDigest);
      if (attemptedKeys.has(locator.objectKey)) throw new Error("Client thumbnail locator token was reused.");
      attemptedKeys.add(locator.objectKey);
      const result = await operation.putObject({
        body: input.bytes,
        contentType: CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
        metadata: metadata({ contentDigest: input.contentDigest, objectLocatorToken: locator.objectLocatorToken }),
        objectKey: locator.objectKey,
      });
      if (result.kind === "already-exists") continue;
      const receipt = parseClientThumbnailArtifactReceiptV1(tenantId, {
        byteSize: input.bytes.byteLength,
        contentDigest: input.contentDigest,
        etag: result.etag,
        mediaType: CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
        objectKey: locator.objectKey,
        objectLocatorToken: locator.objectLocatorToken,
      });
      await this.#read(receipt, operation);
      return receipt;
    }
    throw new Error("Could not allocate a unique client thumbnail object key.");
  }

  read(tenantId: string, receiptValue: ClientThumbnailArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseClientThumbnailArtifactReceiptV1(tenantId, receiptValue);
    return this.#read(receipt, this.#transport.operation(signal));
  }

  async deleteObject(tenantId: string, receiptValue: ClientThumbnailArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseClientThumbnailArtifactReceiptV1(tenantId, receiptValue);
    await this.#transport.operation(signal).deleteObject(receipt.objectKey);
  }

  close() {
    return this.#transport.close();
  }
}

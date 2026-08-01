import { createHash } from "node:crypto";
import { createImmutableObjectGenerationV1, immutableObjectGenerationV1 } from "../immutable-object-contract";
import {
  type ImmutableProjectPngBlobStoreV1,
  type ImmutableProjectPngReceiptV1,
  type ImmutableSourceBlobReceiptV1,
  type ImmutableSourceContentBlobStoreV1,
  immutableProjectPngFamilyPrefixV1,
  immutableProjectPngObjectKeyV1,
  immutableSourceBlobFamilyPrefixV1,
  immutableSourceBlobObjectKeyV1,
  parseImmutableProjectPngObjectKeyV1,
  parseImmutableProjectPngReceiptV1,
  parseImmutableSourceBlobObjectKeyV1,
  parseImmutableSourceBlobReceiptV1,
  sourceBlobContentAddressedKeyV1,
} from "../immutable-source-png-storage";
import {
  inspectProjectPngBytesV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngVersionPageV1,
  projectPngObjectKeyV1,
} from "../project-png-storage";
import {
  MAX_MANIM_SOURCE_BYTES_V1,
  type SourceBlobReceiptV1,
  type SourceBlobVersionPageV1,
  type SourceContentBlobStoreV1,
} from "../workspace-source-repository";
import {
  acquirePrivateImmutableS3BucketTransportV1,
  type PrivateImmutableObjectHeadV1,
  type PrivateImmutableObjectResponseV1,
  type PrivateImmutableS3BucketConsumerOptionsV1,
  type PrivateImmutableS3BucketOperationV1,
  type PrivateImmutableS3BucketTransportLeaseV1,
} from "./s3-private-immutable-bucket-transport";

const MAX_GENERATION_ATTEMPTS_V1 = 3;
const SOURCE_CONTENT_TYPE_V1 = "text/x-python";
const PROJECT_PNG_CONTENT_TYPE_V1 = "image/png";

export type ImmutableS3AdapterDependenciesV1 = Readonly<{
  createObjectGeneration?: () => string;
}>;

type ImmutableObjectPropertiesV1 = Readonly<{
  contentType?: string;
  metadata: Readonly<Record<string, string>>;
}>;

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactSourceBytes(value: unknown) {
  if (typeof value !== "string") throw new TypeError("Python source must be a string.");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_MANIM_SOURCE_BYTES_V1) throw new RangeError("The Python source exceeds 2 MiB.");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("The Python source must be exact UTF-8 text.");
  }
  if (decoded !== value) throw new TypeError("The Python source must not contain unpaired Unicode surrogates.");
  return bytes;
}

function decodeExactSource(bytes: Uint8Array) {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The immutable source object is not valid UTF-8.");
  }
  const encoded = exactSourceBytes(source);
  if (encoded.byteLength !== bytes.byteLength || !encoded.every((byte, index) => byte === bytes[index])) {
    throw new Error("The immutable source object is not canonical UTF-8.");
  }
  return source;
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

async function collectBody(body: unknown, maximum: number, signal: AbortSignal, label: string) {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    destroyBody(body);
    throw new Error(`The immutable ${label} body is unreadable.`);
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      signal.throwIfAborted();
      const chunk = value instanceof Uint8Array ? value : typeof value === "string" ? Buffer.from(value) : null;
      if (!chunk) throw new Error(`The immutable ${label} body contains an invalid chunk.`);
      byteLength += chunk.byteLength;
      if (byteLength > maximum) throw new RangeError(`The immutable ${label} body exceeds its byte limit.`);
      chunks.push(Uint8Array.from(chunk));
    }
    signal.throwIfAborted();
  } finally {
    destroyBody(body);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exactMetadata(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

function assertProperties(
  actual: ImmutableObjectPropertiesV1,
  expectedContentType: string,
  expectedMetadata: Readonly<Record<string, string>>,
  label: string,
) {
  if (actual.contentType !== expectedContentType || !exactMetadata(actual.metadata, expectedMetadata)) {
    throw new Error(`The immutable ${label} metadata does not match its receipt.`);
  }
}

function sourceMetadata(receipt: Pick<ImmutableSourceBlobReceiptV1, "digest" | "objectGeneration">) {
  return {
    "content-digest": receipt.digest,
    "object-generation": receipt.objectGeneration,
    "object-kind": "source-blob",
    "source-encoding": "utf-8",
  } as const;
}

function projectPngMetadata(
  projectId: string,
  receipt: Pick<ImmutableProjectPngReceiptV1, "digest" | "objectGeneration">,
) {
  return {
    "content-digest": receipt.digest,
    "object-generation": receipt.objectGeneration,
    "object-kind": "project-png",
    "project-id": projectId,
  } as const;
}

function responseProperties(response: PrivateImmutableObjectHeadV1 | PrivateImmutableObjectResponseV1) {
  return { contentType: response.contentType, metadata: response.metadata };
}

function generationFactory(dependencies: ImmutableS3AdapterDependenciesV1) {
  const create = dependencies.createObjectGeneration ?? createImmutableObjectGenerationV1;
  if (typeof create !== "function") throw new TypeError("Immutable object generation factory is invalid.");
  return () => immutableObjectGenerationV1(create());
}

async function putWithGenerations(
  operation: PrivateImmutableS3BucketOperationV1,
  createGeneration: () => string,
  createInput: (objectGeneration: string) => Readonly<{
    body: Uint8Array;
    contentType: string;
    metadata: Readonly<Record<string, string>>;
    objectKey: string;
  }>,
) {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS_V1; attempt += 1) {
    operation.signal.throwIfAborted();
    const objectGeneration = createGeneration();
    const input = createInput(objectGeneration);
    const result = await operation.putObject(input);
    if (result.kind === "created") return { etag: result.etag, objectGeneration, objectKey: input.objectKey };
  }
  throw new Error(`Immutable object creation collided ${MAX_GENERATION_ATTEMPTS_V1} consecutive times.`);
}

export type ImmutableS3SourceBlobStoreOptionsV1 = PrivateImmutableS3BucketConsumerOptionsV1;

/** Unversioned source storage pinned by an application-owned object generation and exact ETag. */
export class ImmutableS3SourceBlobStoreV1 implements ImmutableSourceContentBlobStoreV1, SourceContentBlobStoreV1 {
  readonly #createGeneration: () => string;
  readonly #transport: PrivateImmutableS3BucketTransportLeaseV1;

  constructor(options: ImmutableS3SourceBlobStoreOptionsV1, dependencies: ImmutableS3AdapterDependenciesV1 = {}) {
    this.#createGeneration = generationFactory(dependencies);
    this.#transport = acquirePrivateImmutableS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #head(
    tenantId: string,
    receiptValue: ImmutableSourceBlobReceiptV1,
    operation: PrivateImmutableS3BucketOperationV1,
  ) {
    const receipt = parseImmutableSourceBlobReceiptV1(tenantId, receiptValue);
    const response = await operation.headObject({
      byteSize: receipt.byteSize,
      etag: receipt.etag,
      objectKey: receipt.objectKey,
    });
    assertProperties(responseProperties(response), SOURCE_CONTENT_TYPE_V1, sourceMetadata(receipt), "source");
    return receipt;
  }

  async #read(tenantId: string, receiptValue: unknown, operation: PrivateImmutableS3BucketOperationV1) {
    const receipt = parseImmutableSourceBlobReceiptV1(tenantId, receiptValue);
    const response = await operation.getObject({
      byteSize: receipt.byteSize,
      etag: receipt.etag,
      objectKey: receipt.objectKey,
    });
    try {
      assertProperties(responseProperties(response), SOURCE_CONTENT_TYPE_V1, sourceMetadata(receipt), "source");
    } catch (error) {
      destroyBody(response.body);
      throw error;
    }
    const bytes = await collectBody(response.body, MAX_MANIM_SOURCE_BYTES_V1, operation.signal, "source");
    if (bytes.byteLength !== receipt.byteSize || digest(bytes) !== receipt.digest) {
      throw new Error("The immutable source bytes do not match their receipt.");
    }
    return decodeExactSource(bytes);
  }

  async putSource(tenantId: string, source: string, signal?: AbortSignal) {
    const bytes = exactSourceBytes(source);
    const contentDigest = digest(bytes);
    sourceBlobContentAddressedKeyV1(tenantId, contentDigest);
    const operation = this.#transport.operation(signal);
    const created = await putWithGenerations(operation, this.#createGeneration, (objectGeneration) => {
      const objectKey = immutableSourceBlobObjectKeyV1(tenantId, contentDigest, objectGeneration);
      return {
        body: bytes,
        contentType: SOURCE_CONTENT_TYPE_V1,
        metadata: sourceMetadata({ digest: contentDigest, objectGeneration }),
        objectKey,
      };
    });
    const receipt = parseImmutableSourceBlobReceiptV1(tenantId, {
      byteSize: bytes.byteLength,
      digest: contentDigest,
      ...created,
    });
    await this.#read(tenantId, receipt, operation);
    return receipt;
  }

  async readSource(tenantId: string, receiptValue: SourceBlobReceiptV1, signal?: AbortSignal) {
    return this.#read(tenantId, receiptValue, this.#transport.operation(signal));
  }

  async headSource(tenantId: string, receipt: ImmutableSourceBlobReceiptV1, signal?: AbortSignal) {
    await this.#head(tenantId, receipt, this.#transport.operation(signal));
  }

  async deleteObject(tenantId: string, receiptValue: ImmutableSourceBlobReceiptV1, signal?: AbortSignal) {
    const receipt = parseImmutableSourceBlobReceiptV1(tenantId, receiptValue);
    await this.#transport.operation(signal).deleteObject(receipt.objectKey);
  }

  async deleteVersion(tenantId: string, receiptValue: SourceBlobReceiptV1, signal?: AbortSignal) {
    const receipt = parseImmutableSourceBlobReceiptV1(tenantId, receiptValue);
    await this.deleteObject(tenantId, receipt, signal);
  }

  async listOrphanCandidates(tenantId: string, maximum: number, cursor?: string | null, signal?: AbortSignal) {
    const page = await this.#transport.operation(signal).listObjectsPage({
      ...(cursor === null || cursor === undefined ? {} : { cursor }),
      maximum,
      prefix: immutableSourceBlobFamilyPrefixV1(tenantId),
    });
    return {
      candidates: page.objects.map((object) => {
        const identity = parseImmutableSourceBlobObjectKeyV1(tenantId, object.objectKey);
        return {
          lastModified: new Date(object.lastModified.getTime()),
          receipt: parseImmutableSourceBlobReceiptV1(tenantId, {
            byteSize: object.byteSize,
            digest: identity.digest,
            etag: object.etag,
            objectGeneration: identity.objectGeneration,
            objectKey: identity.objectKey,
          }),
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  async listSourceVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<SourceBlobVersionPageV1> {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new TypeError("Immutable source GC cutoff is invalid.");
    }
    const page = await this.listOrphanCandidates(tenantId, maximum, cursor, signal);
    return {
      nextCursor: page.nextCursor,
      versions: page.candidates.flatMap((candidate) =>
        candidate.lastModified < cutoff ? [{ blob: candidate.receipt, lastModified: candidate.lastModified }] : [],
      ),
    };
  }

  close() {
    return this.#transport.close();
  }
}

export type ImmutableS3ProjectPngStoreOptionsV1 = PrivateImmutableS3BucketConsumerOptionsV1;

/** Unversioned project image storage pinned by an application-owned object generation and exact ETag. */
export class ImmutableS3ProjectPngStoreV1 implements ImmutableProjectPngBlobStoreV1, ProjectPngBlobStoreV1 {
  readonly #createGeneration: () => string;
  readonly #transport: PrivateImmutableS3BucketTransportLeaseV1;

  constructor(options: ImmutableS3ProjectPngStoreOptionsV1, dependencies: ImmutableS3AdapterDependenciesV1 = {}) {
    this.#createGeneration = generationFactory(dependencies);
    this.#transport = acquirePrivateImmutableS3BucketTransportV1(options);
  }

  ready(signal?: AbortSignal) {
    return this.#transport.ready(signal);
  }

  async #head(
    tenantId: string,
    projectId: string,
    receiptValue: ImmutableProjectPngReceiptV1,
    operation: PrivateImmutableS3BucketOperationV1,
  ) {
    const receipt = parseImmutableProjectPngReceiptV1(tenantId, projectId, receiptValue);
    const response = await operation.headObject({
      byteSize: receipt.byteSize,
      etag: receipt.etag,
      objectKey: receipt.objectKey,
    });
    assertProperties(
      responseProperties(response),
      PROJECT_PNG_CONTENT_TYPE_V1,
      projectPngMetadata(projectId, receipt),
      "image.png",
    );
    return receipt;
  }

  async #read(
    tenantId: string,
    projectId: string,
    receiptValue: unknown,
    operation: PrivateImmutableS3BucketOperationV1,
  ) {
    const receipt = parseImmutableProjectPngReceiptV1(tenantId, projectId, receiptValue);
    const response = await operation.getObject({
      byteSize: receipt.byteSize,
      etag: receipt.etag,
      objectKey: receipt.objectKey,
    });
    try {
      assertProperties(
        responseProperties(response),
        PROJECT_PNG_CONTENT_TYPE_V1,
        projectPngMetadata(projectId, receipt),
        "image.png",
      );
    } catch (error) {
      destroyBody(response.body);
      throw error;
    }
    const bytes = await collectBody(response.body, receipt.byteSize, operation.signal, "image.png");
    const inspected = inspectProjectPngBytesV1(bytes);
    if (inspected.byteSize !== receipt.byteSize || inspected.digest !== receipt.digest) {
      throw new Error("The immutable image.png bytes do not match their receipt.");
    }
    return inspected.bytes;
  }

  async put(tenantId: string, projectId: string, bytes: Uint8Array, signal?: AbortSignal) {
    const inspected = inspectProjectPngBytesV1(bytes);
    projectPngObjectKeyV1(tenantId, projectId, inspected.digest);
    const operation = this.#transport.operation(signal);
    const created = await putWithGenerations(operation, this.#createGeneration, (objectGeneration) => {
      const objectKey = immutableProjectPngObjectKeyV1(tenantId, projectId, inspected.digest, objectGeneration);
      return {
        body: inspected.bytes,
        contentType: PROJECT_PNG_CONTENT_TYPE_V1,
        metadata: projectPngMetadata(projectId, { digest: inspected.digest, objectGeneration }),
        objectKey,
      };
    });
    const receipt = parseImmutableProjectPngReceiptV1(tenantId, projectId, {
      byteSize: inspected.byteSize,
      digest: inspected.digest,
      ...created,
    });
    await this.#read(tenantId, projectId, receipt, operation);
    return receipt;
  }

  async read(tenantId: string, projectId: string, receiptValue: ProjectPngBlobReceiptV1, signal?: AbortSignal) {
    return this.#read(tenantId, projectId, receiptValue, this.#transport.operation(signal));
  }

  async head(tenantId: string, projectId: string, receipt: ImmutableProjectPngReceiptV1, signal?: AbortSignal) {
    await this.#head(tenantId, projectId, receipt, this.#transport.operation(signal));
  }

  async deleteObject(
    tenantId: string,
    projectId: string,
    receiptValue: ImmutableProjectPngReceiptV1,
    signal?: AbortSignal,
  ) {
    const receipt = parseImmutableProjectPngReceiptV1(tenantId, projectId, receiptValue);
    await this.#transport.operation(signal).deleteObject(receipt.objectKey);
  }

  async deleteVersion(
    tenantId: string,
    projectId: string,
    receiptValue: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ) {
    const receipt = parseImmutableProjectPngReceiptV1(tenantId, projectId, receiptValue);
    await this.deleteObject(tenantId, projectId, receipt, signal);
  }

  async listOrphanCandidates(tenantId: string, maximum: number, cursor?: string | null, signal?: AbortSignal) {
    const page = await this.#transport.operation(signal).listObjectsPage({
      ...(cursor === null || cursor === undefined ? {} : { cursor }),
      maximum,
      prefix: immutableProjectPngFamilyPrefixV1(tenantId),
    });
    return {
      candidates: page.objects.map((object) => {
        const identity = parseImmutableProjectPngObjectKeyV1(tenantId, object.objectKey);
        return {
          lastModified: new Date(object.lastModified.getTime()),
          projectId: identity.projectId,
          receipt: parseImmutableProjectPngReceiptV1(tenantId, identity.projectId, {
            byteSize: object.byteSize,
            digest: identity.digest,
            etag: object.etag,
            objectGeneration: identity.objectGeneration,
            objectKey: identity.objectKey,
          }),
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  async listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ProjectPngVersionPageV1> {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new TypeError("Immutable project image.png GC cutoff is invalid.");
    }
    const page = await this.listOrphanCandidates(tenantId, maximum, cursor, signal);
    return {
      nextCursor: page.nextCursor,
      versions: page.candidates.flatMap((candidate) =>
        candidate.lastModified < cutoff
          ? [{ lastModified: candidate.lastModified, projectId: candidate.projectId, receipt: candidate.receipt }]
          : [],
      ),
    };
  }

  close() {
    return this.#transport.close();
  }
}

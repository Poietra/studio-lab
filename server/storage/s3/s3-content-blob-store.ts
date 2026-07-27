import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  MAX_MANIM_SOURCE_BYTES_V1,
  type SourceBlobReceiptV1,
  type SourceBlobVersionV1,
  type SourceContentBlobStoreV1,
} from "../workspace-source-repository";

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
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function normalizeEtag(value: string | undefined) {
  if (!value || value.length > 512) throw new Error("S3 did not return a bounded object ETag.");
  return value;
}

function validateReceipt(tenant: string, value: SourceBlobReceiptV1) {
  if (
    !/^[0-9a-f]{64}$/.test(value.digest) ||
    value.objectKey !== sourceKey(tenant, value.digest) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 ||
    value.byteSize > MAX_MANIM_SOURCE_BYTES_V1 ||
    value.versionId.length < 1 ||
    value.versionId.length > 1_024 ||
    value.etag.length < 1 ||
    value.etag.length > 512
  ) {
    throw new TypeError("Source blob receipt is invalid.");
  }
  return value;
}

function isLoopback(hostname: string) {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unwrapped === "localhost" || unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."));
}

function validateEndpoint(endpoint: string | undefined, deployment: "production" | "test") {
  if (!endpoint) return;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("The S3 endpoint must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("The S3 endpoint must contain only an HTTP(S) origin.");
  }
  if (parsed.protocol !== "https:" && (deployment !== "test" || !isLoopback(parsed.hostname))) {
    throw new TypeError("Only loopback tests may use an unencrypted S3 endpoint.");
  }
}

function isNoBucketPolicy(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "NoSuchBucketPolicy" || ("Code" in error && error.Code === "NoSuchBucketPolicy"))
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

export type S3ContentBlobStoreOptionsV1 = Readonly<{
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  deployment: "production" | "test";
}>;

/** Private, version-pinned S3 source storage. Every read revalidates size, digest, and UTF-8. */
export class S3ContentBlobStoreV1 implements SourceContentBlobStoreV1 {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #ownsClient: boolean;

  constructor(options: S3ContentBlobStoreOptionsV1) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new TypeError("The private S3 bucket name is invalid.");
    }
    if ((options.client === undefined) === (options.clientConfig === undefined)) {
      throw new TypeError("Provide exactly one S3 client or client configuration.");
    }
    if (options.deployment === "production" && options.client !== undefined) {
      throw new TypeError("Production S3 requires an inspectable client configuration, not an injected client.");
    }
    if (options.clientConfig?.endpoint !== undefined && typeof options.clientConfig.endpoint !== "string") {
      throw new TypeError("The S3 endpoint must be a statically validated URL string.");
    }
    validateEndpoint(
      typeof options.clientConfig?.endpoint === "string" ? options.clientConfig.endpoint : undefined,
      options.deployment,
    );
    if (options.deployment === "production" && options.clientConfig?.forcePathStyle === true) {
      throw new TypeError("Production S3 must not use path-style addressing.");
    }
    this.#bucket = options.bucket;
    this.#client = options.client ?? new S3Client(options.clientConfig!);
    this.#ownsClient = options.client === undefined;
  }

  async ready(signal?: AbortSignal) {
    try {
      throwIfAborted(signal);
      const policyStatus = this.#client
        .send(new GetBucketPolicyStatusCommand({ Bucket: this.#bucket }), { abortSignal: signal })
        .catch((error: unknown) => {
          if (isNoBucketPolicy(error)) return null;
          throw error;
        });
      const [, versioning, acl, policy] = await Promise.all([
        this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), { abortSignal: signal }),
        this.#client.send(new GetBucketVersioningCommand({ Bucket: this.#bucket }), { abortSignal: signal }),
        this.#client.send(new GetBucketAclCommand({ Bucket: this.#bucket }), { abortSignal: signal }),
        policyStatus,
      ]);
      throwIfAborted(signal);
      const publicGrant = acl.Grants?.some((grant) => {
        const uri = grant.Grantee?.URI ?? "";
        return uri.endsWith("/AllUsers") || uri.endsWith("/AuthenticatedUsers");
      });
      return versioning.Status === "Enabled" && publicGrant !== true && policy?.PolicyStatus?.IsPublic !== true;
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async #readBytes(tenant: string, receipt: SourceBlobReceiptV1, signal?: AbortSignal) {
    const expected = validateReceipt(tenant, receipt);
    throwIfAborted(signal);
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: expected.objectKey, VersionId: expected.versionId }),
      { abortSignal: signal },
    );
    if (
      response.VersionId !== expected.versionId ||
      response.ContentLength !== expected.byteSize ||
      normalizeEtag(response.ETag) !== expected.etag
    ) {
      throw new Error("The versioned S3 source metadata does not match its published receipt.");
    }
    const bytes = await boundedBody(response.Body, signal);
    if (bytes.byteLength !== expected.byteSize || sourceDigest(bytes) !== expected.digest) {
      throw new Error("The versioned S3 source bytes do not match their published receipt.");
    }
    return bytes;
  }

  async putSource(tenantValue: string, source: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const bytes = exactSourceBytes(source);
    const digest = sourceDigest(bytes);
    const objectKey = sourceKey(tenant, digest);
    throwIfAborted(signal);
    const response = await this.#client.send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: this.#bucket,
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
        ContentLength: bytes.byteLength,
        ContentType: "text/x-python; charset=utf-8",
        Key: objectKey,
      }),
      { abortSignal: signal },
    );
    const receipt = validateReceipt(tenant, {
      byteSize: bytes.byteLength,
      digest,
      etag: normalizeEtag(response.ETag),
      objectKey,
      versionId: response.VersionId ?? "",
    });
    await this.#readBytes(tenant, receipt, signal);
    return receipt;
  }

  async listSourceVersions(tenantValue: string, cutoff: Date, maximumValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError("GC cutoff is invalid.");
    if (!Number.isSafeInteger(maximumValue) || maximumValue <= 0 || maximumValue > 256) {
      throw new RangeError("maximum must be an integer between 1 and 256.");
    }
    const prefix = `tenants/${tenant}/sources/`;
    const versions: SourceBlobVersionV1[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let examined = 0;
    while (versions.length < maximumValue && examined < 1_024) {
      throwIfAborted(signal);
      const page = await this.#client.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          KeyMarker: keyMarker,
          MaxKeys: Math.min(256, maximumValue - versions.length),
          Prefix: prefix,
          VersionIdMarker: versionIdMarker,
        }),
        { abortSignal: signal },
      );
      for (const version of page.Versions ?? []) {
        examined += 1;
        if (versions.length >= maximumValue || examined > 1_024) break;
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
      if (!page.IsTruncated) break;
      if (!page.NextKeyMarker || !page.NextVersionIdMarker) {
        throw new Error("S3 returned an incomplete version-list cursor.");
      }
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
    return versions;
  }

  async readSource(tenantValue: string, blob: SourceBlobReceiptV1, signal?: AbortSignal) {
    const bytes = await this.#readBytes(tenantId(tenantValue), blob, signal);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("The versioned S3 source is not valid UTF-8.");
    }
  }

  async deleteVersion(tenantValue: string, blob: SourceBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const receipt = validateReceipt(tenant, blob);
    throwIfAborted(signal);
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: receipt.objectKey, VersionId: receipt.versionId }),
      { abortSignal: signal },
    );
    throwIfAborted(signal);
  }

  async close() {
    if (this.#ownsClient) this.#client.destroy();
  }
}

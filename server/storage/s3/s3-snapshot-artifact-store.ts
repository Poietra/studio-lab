import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketLifecycleConfigurationCommand,
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
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  parseSnapshotArtifactReceiptV1,
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotArtifactVersionV1,
  snapshotArtifactObjectKeyV1,
} from "../snapshot-publication-repository";

const OPERATION_TIMEOUT_MS = 30_000;
const MAX_LIST_RESULTS = 256;
const MAX_LIST_ENTRIES = 1_024;
const MAX_LIST_PAGES = 16;
const MAX_CONDITIONAL_PUT_ATTEMPTS = 3;
const SHA256 = /^[0-9a-f]{64}$/;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function operationSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
  if (parts.length !== 4 || parts.some((part) => !SHA256.test(part))) {
    throw new Error("S3 returned an invalid snapshot artifact key.");
  }
  return {
    profileDigest: parts[2]!,
    resultDigest: parts[3]!,
    runtimeConfigHash: parts[1]!,
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

function isLoopback(hostname: string) {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
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

export type S3SnapshotArtifactStoreOptionsV1 = Readonly<{
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  deployment: "production" | "test";
}>;

/** Immutable, version-pinned S3 storage for verified snapshot bytes. */
export class S3SnapshotArtifactStoreV1 implements SnapshotArtifactStoreV1 {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #deployment: "production" | "test";
  readonly #ownsClient: boolean;

  constructor(options: S3SnapshotArtifactStoreOptionsV1) {
    if (options.deployment !== "production" && options.deployment !== "test") {
      throw new TypeError("The S3 deployment mode is invalid.");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new TypeError("The private S3 bucket name is invalid.");
    }
    if ((options.client === undefined) === (options.clientConfig === undefined)) {
      throw new TypeError("Provide exactly one S3 client or client configuration.");
    }
    if (options.deployment === "production" && options.client !== undefined) {
      throw new TypeError("Production S3 requires an inspectable client configuration, not an injected client.");
    }
    if (
      options.deployment === "production" &&
      (options.clientConfig?.requestHandler !== undefined ||
        options.clientConfig?.endpointProvider !== undefined ||
        options.clientConfig?.urlParser !== undefined ||
        options.clientConfig?.tls !== undefined ||
        options.clientConfig?.ignoreConfiguredEndpointUrls !== true)
    ) {
      throw new TypeError(
        "Production S3 requires the SDK verified-HTTPS transport and must ignore environment/shared-config endpoint overrides.",
      );
    }
    if (options.clientConfig?.endpoint !== undefined && typeof options.clientConfig.endpoint !== "string") {
      throw new TypeError("The S3 endpoint must be a statically validated URL string.");
    }
    validateEndpoint(
      typeof options.clientConfig?.endpoint === "string" ? options.clientConfig.endpoint : undefined,
      options.deployment,
    );
    if (
      options.deployment === "production" &&
      options.clientConfig?.forcePathStyle !== undefined &&
      options.clientConfig.forcePathStyle !== false
    ) {
      throw new TypeError("Production S3 must not use path-style addressing.");
    }
    this.#bucket = options.bucket;
    this.#client = options.client ?? new S3Client(options.clientConfig!);
    this.#deployment = options.deployment;
    this.#ownsClient = options.client === undefined;
  }

  async ready(signal?: AbortSignal) {
    signal = operationSignal(signal);
    try {
      throwIfAborted(signal);
      const policy = this.#client
        .send(new GetBucketPolicyStatusCommand({ Bucket: this.#bucket }), { abortSignal: signal })
        .catch((error: unknown) => {
          if (isNamedError(error, "NoSuchBucketPolicy")) return null;
          throw error;
        });
      const lifecycle = this.#client
        .send(new GetBucketLifecycleConfigurationCommand({ Bucket: this.#bucket }), { abortSignal: signal })
        .catch((error: unknown) => {
          if (isNamedError(error, "NoSuchLifecycleConfiguration")) return null;
          throw error;
        });
      const [, versioning, acl, policyStatus, lifecycleConfiguration] = await Promise.all([
        this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), { abortSignal: signal }),
        this.#client.send(new GetBucketVersioningCommand({ Bucket: this.#bucket }), { abortSignal: signal }),
        this.#client.send(new GetBucketAclCommand({ Bucket: this.#bucket }), { abortSignal: signal }),
        policy,
        lifecycle,
      ]);
      throwIfAborted(signal);
      const ownerId = acl.Owner?.ID;
      const ownerOnlyAcl =
        typeof ownerId === "string" &&
        (this.#deployment === "test" || ownerId.length > 0) &&
        Array.isArray(acl.Grants) &&
        acl.Grants.length > 0 &&
        acl.Grants.every(
          (grant) =>
            grant.Grantee?.Type === "CanonicalUser" &&
            (grant.Grantee.ID === ownerId ||
              (this.#deployment === "test" && ownerId === "" && grant.Grantee.ID === undefined)) &&
            grant.Permission === "FULL_CONTROL",
        );
      return (
        versioning.Status === "Enabled" &&
        ownerOnlyAcl &&
        (policyStatus === null || policyStatus.PolicyStatus?.IsPublic === false) &&
        lifecycleConfiguration === null
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async #readBytes(tenant: string, receiptValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const receipt = parseSnapshotArtifactReceiptV1(tenant, receiptValue);
    throwIfAborted(signal);
    let response;
    try {
      response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: receipt.objectKey, VersionId: receipt.versionId }),
        { abortSignal: signal },
      );
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
    const bytes = await boundedBody(response.Body, signal);
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
      sourceDigest: string;
    }>,
    signal?: AbortSignal,
  ) {
    const objectKey = snapshotArtifactObjectKeyV1(tenant, identity);
    let response;
    try {
      response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }), {
        abortSignal: signal,
      });
    } catch (error) {
      if (isMissingObjectVersion(error)) throw new SnapshotArtifactReadErrorV1("missing");
      throw error;
    }
    let receipt: SnapshotArtifactReceiptV1;
    try {
      receipt = parseSnapshotArtifactReceiptV1(tenant, {
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
    const bytes = await boundedBody(response.Body, signal);
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
      sourceDigest: string;
    }>,
    signal?: AbortSignal,
  ) {
    signal = operationSignal(signal);
    const tenant = tenantId(tenantValue);
    if (!input || typeof input !== "object" || !(input.bytes instanceof Uint8Array)) {
      throw new TypeError("Snapshot artifact input is invalid.");
    }
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES_V1) {
      throw new RangeError("Snapshot artifacts must contain between 1 byte and 16 MiB.");
    }
    const bytes = Uint8Array.from(input.bytes);
    const identity = {
      byteSize: bytes.byteLength,
      profileDigest: input.profileDigest,
      resultDigest: resultDigest(bytes),
      runtimeConfigHash: input.runtimeConfigHash,
      sourceDigest: input.sourceDigest,
    };
    const objectKey = snapshotArtifactObjectKeyV1(tenant, identity);
    throwIfAborted(signal);
    let response;
    for (let attempt = 1; attempt <= MAX_CONDITIONAL_PUT_ATTEMPTS; attempt += 1) {
      try {
        response = await this.#client.send(
          new PutObjectCommand({
            Body: bytes,
            Bucket: this.#bucket,
            ChecksumSHA256: Buffer.from(identity.resultDigest, "hex").toString("base64"),
            ContentLength: bytes.byteLength,
            ContentType: "application/octet-stream",
            IfNoneMatch: "*",
            Key: objectKey,
          }),
          { abortSignal: signal },
        );
        break;
      } catch (error) {
        if (isPreconditionFailed(error)) return this.#readCurrentReceipt(tenant, identity, signal);
        if (!isConditionalRequestConflict(error) || attempt === MAX_CONDITIONAL_PUT_ATTEMPTS) throw error;
        throwIfAborted(signal);
      }
    }
    if (!response) throw new Error("S3 did not settle the bounded conditional snapshot upload.");
    const receipt = parseSnapshotArtifactReceiptV1(tenant, {
      ...identity,
      etag: normalizeEtag(response.ETag),
      objectKey,
      versionId: response.VersionId ?? "",
    });
    await this.#readBytes(tenant, receipt, signal);
    return receipt;
  }

  async read(tenantValue: string, artifact: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    signal = operationSignal(signal);
    return this.#readBytes(tenantId(tenantValue), artifact, signal);
  }

  async listVersions(
    tenantValue: string,
    cutoff: Date,
    maximum: number,
    cursorValue?: string | null,
    signal?: AbortSignal,
  ) {
    signal = operationSignal(signal);
    const tenant = tenantId(tenantValue);
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError("GC cutoff is invalid.");
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LIST_RESULTS) {
      throw new RangeError(`maximum must be an integer between 1 and ${MAX_LIST_RESULTS}.`);
    }
    const prefix = snapshotPrefix(tenant);
    const cursor = decodeCursor(cursorValue, prefix);
    const versions: SnapshotArtifactVersionV1[] = [];
    let keyMarker = cursor.keyMarker;
    let versionIdMarker = cursor.versionIdMarker;
    let nextCursor: string | null = null;
    let examined = 0;
    let pages = 0;
    const seen = new Set<string>();
    if (keyMarker && versionIdMarker) seen.add(encodeCursor(keyMarker, versionIdMarker, prefix));
    while (versions.length < maximum && examined < MAX_LIST_ENTRIES && pages < MAX_LIST_PAGES) {
      throwIfAborted(signal);
      pages += 1;
      const pageBudget = Math.min(MAX_LIST_RESULTS, MAX_LIST_ENTRIES - examined, maximum - versions.length);
      const page = await this.#client.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          KeyMarker: keyMarker,
          MaxKeys: pageBudget,
          Prefix: prefix,
          VersionIdMarker: versionIdMarker,
        }),
        { abortSignal: signal },
      );
      const pageEntries = (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
      if (pageEntries > pageBudget) throw new Error("S3 exceeded the bounded snapshot-version page size.");
      if (page.IsTruncated && pageEntries === 0) {
        throw new Error("S3 returned an empty truncated snapshot-version page.");
      }
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
        const artifact = parseSnapshotArtifactReceiptV1(tenant, {
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
      if (!page.NextKeyMarker || !page.NextVersionIdMarker) {
        throw new Error("S3 returned an incomplete version-list cursor.");
      }
      nextCursor = encodeCursor(page.NextKeyMarker, page.NextVersionIdMarker, prefix);
      if (seen.has(nextCursor)) throw new Error("S3 returned a cycling version-list cursor.");
      seen.add(nextCursor);
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
    return { nextCursor, versions };
  }

  async deleteVersion(tenantValue: string, artifactValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    signal = operationSignal(signal);
    const artifact = parseSnapshotArtifactReceiptV1(tenantId(tenantValue), artifactValue);
    throwIfAborted(signal);
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: artifact.objectKey, VersionId: artifact.versionId }),
      { abortSignal: signal },
    );
    throwIfAborted(signal);
  }

  async close() {
    if (this.#ownsClient) this.#client.destroy();
  }
}

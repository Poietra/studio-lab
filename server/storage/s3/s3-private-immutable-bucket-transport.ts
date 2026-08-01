import { isIP } from "node:net";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { manimTenantIdSchema } from "../../manim-request-principal";

const S3_OPERATION_TIMEOUT_MS_V1 = 30_000;
const MAX_LIST_PAGE_RESULTS_V1 = 256;
const MAX_OBJECT_BYTES_V1 = 128 * 1024 * 1024;
const MAX_OBJECT_KEY_UTF8_BYTES_V1 = 1_024;
const MAX_CURSOR_UTF8_BYTES_V1 = 4_096;
const MAX_ETAG_UTF8_BYTES_V1 = 512;
const MAX_METADATA_ENTRIES_V1 = 32;
const MAX_METADATA_UTF8_BYTES_V1 = 8_192;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const IMMUTABLE_KEY = new RegExp(`^tenants/([^/]+)/(.+)/([0-9a-f]{64})/g/(${UUID})$`, "u");
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export type PrivateImmutableObjectRangeV1 = Readonly<{ end: number; start: number }>;

export type PrivateImmutableObjectResponseV1 = Readonly<{
  body: unknown;
  byteSize: number;
  contentRange?: string;
  contentType?: string;
  etag: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type PrivateImmutableObjectHeadV1 = Omit<PrivateImmutableObjectResponseV1, "body" | "contentRange">;

export type PrivateImmutableObjectListEntryV1 = Readonly<{
  byteSize: number;
  etag: string;
  lastModified: Date;
  objectKey: string;
}>;

export type PrivateImmutableObjectListPageV1 = Readonly<{
  nextCursor: string | null;
  objects: readonly PrivateImmutableObjectListEntryV1[];
}>;

export type PrivateImmutableObjectPutResultV1 =
  | Readonly<{ etag: string; kind: "created" }>
  | Readonly<{ kind: "already-exists" }>;

export type PrivateImmutableS3BucketOperationV1 = Readonly<{
  deleteObject: (objectKey: string) => Promise<void>;
  getObject: (
    input: Readonly<{
      byteSize: number;
      etag: string;
      objectKey: string;
      range?: PrivateImmutableObjectRangeV1;
    }>,
  ) => Promise<PrivateImmutableObjectResponseV1>;
  headObject: (
    input: Readonly<{
      byteSize: number;
      etag: string;
      objectKey: string;
    }>,
  ) => Promise<PrivateImmutableObjectHeadV1>;
  listObjectsPage: (
    input: Readonly<{
      cursor?: string;
      maximum: number;
      prefix: string;
    }>,
  ) => Promise<PrivateImmutableObjectListPageV1>;
  putObject: (
    input: Readonly<{
      body: Uint8Array;
      contentType: string;
      metadata?: Readonly<Record<string, string>>;
      objectKey: string;
    }>,
  ) => Promise<PrivateImmutableObjectPutResultV1>;
  signal: AbortSignal;
}>;

export type PrivateImmutableS3BucketTransportLeaseV1 = Readonly<{
  close: () => Promise<void>;
  operation: (signal?: AbortSignal) => PrivateImmutableS3BucketOperationV1;
  ready: (signal?: AbortSignal) => Promise<boolean>;
}>;

export type PrivateImmutableS3StaticCredentialsV1 = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type PrivateImmutableS3ProductionProviderV1 =
  | Readonly<{
      accountId: string;
      credentials: PrivateImmutableS3StaticCredentialsV1;
      jurisdiction?: "default" | "eu" | "fedramp";
      kind: "cloudflare-r2";
    }>
  | Readonly<{
      credentials:
        | Readonly<{ source: "aws-default-chain" }>
        | (PrivateImmutableS3StaticCredentialsV1 & Readonly<{ source: "static" }>);
      kind: "aws-s3";
      region: string;
    }>;

export type PrivateImmutableS3BucketTransportOptionsV1 =
  | Readonly<{
      bucket: string;
      deployment: "production";
      provider: PrivateImmutableS3ProductionProviderV1;
    }>
  | Readonly<{
      bucket: string;
      client: S3Client;
      deployment: "test";
    }>
  | Readonly<{
      bucket: string;
      clientConfig: S3ClientConfig;
      deployment: "test";
    }>;

export type PrivateImmutableS3BucketConsumerOptionsV1 =
  | PrivateImmutableS3BucketTransportOptionsV1
  | Readonly<{ transport: PrivateImmutableS3BucketTransportV1 }>;

function utf8Length(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function boundedOpaque(value: unknown, maximum: number, label: string) {
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value) || utf8Length(value) > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function objectKey(value: unknown) {
  const key = boundedOpaque(value, MAX_OBJECT_KEY_UTF8_BYTES_V1, "Immutable object key");
  const match = key.match(IMMUTABLE_KEY);
  if (
    !SAFE_PATH.test(key) ||
    !match ||
    !manimTenantIdSchema.safeParse(match[1]).success ||
    key.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("Immutable object key is invalid.");
  }
  return key;
}

function objectPrefix(value: unknown) {
  const prefix = boundedOpaque(value, MAX_OBJECT_KEY_UTF8_BYTES_V1, "Immutable object-list prefix");
  const segments = prefix.split("/");
  if (
    !SAFE_PATH.test(prefix) ||
    segments[0] !== "tenants" ||
    !manimTenantIdSchema.safeParse(segments[1]).success ||
    segments.length < 4 ||
    !prefix.endsWith("/") ||
    segments.slice(0, -1).some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("Immutable object-list prefix is invalid.");
  }
  return prefix;
}

function byteSize(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_OBJECT_BYTES_V1) {
    throw new RangeError("Immutable object byte size is invalid.");
  }
  return value as number;
}

function etag(value: unknown) {
  return boundedOpaque(value, MAX_ETAG_UTF8_BYTES_V1, "Immutable object ETag");
}

function contentType(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 129 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(value)
  ) {
    throw new TypeError("Immutable object content type is invalid.");
  }
  return value;
}

function metadata(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable object metadata is invalid.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES_V1) throw new RangeError("Immutable object metadata is too large.");
  let bytes = 0;
  const result: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(key) || typeof entryValue !== "string" || CONTROL.test(entryValue)) {
      throw new TypeError("Immutable object metadata is invalid.");
    }
    bytes += utf8Length(key) + utf8Length(entryValue);
    if (bytes > MAX_METADATA_UTF8_BYTES_V1) throw new RangeError("Immutable object metadata is too large.");
    result[key] = entryValue;
  }
  return result;
}

function range(value: PrivateImmutableObjectRangeV1 | undefined, total: number) {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) ||
    value.start < 0 ||
    value.end < value.start ||
    value.end >= total
  ) {
    throw new RangeError("Immutable object byte range is invalid.");
  }
  return { end: value.end, start: value.start };
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

function staticCredentials(value: unknown, required: boolean) {
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Static S3 credentials are invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const accessKeyId = boundedOpaque(candidate.accessKeyId, 256, "S3 access key ID");
  const secretAccessKey = boundedOpaque(candidate.secretAccessKey, 512, "S3 secret access key");
  const sessionToken =
    candidate.sessionToken === undefined
      ? undefined
      : boundedOpaque(candidate.sessionToken, MAX_CURSOR_UTF8_BYTES_V1, "S3 session token");
  if (Object.keys(candidate).some((key) => !["accessKeyId", "secretAccessKey", "sessionToken"].includes(key))) {
    throw new TypeError("Static S3 credentials are invalid.");
  }
  return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) };
}

function productionClientConfig(provider: PrivateImmutableS3ProductionProviderV1): S3ClientConfig {
  const base = {
    bucketEndpoint: false,
    disableMultiregionAccessPoints: true,
    followRegionRedirects: false,
    forcePathStyle: false,
    ignoreConfiguredEndpointUrls: true,
    maxAttempts: 3,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    retryMode: "standard",
    useAccelerateEndpoint: false,
    useArnRegion: false,
    useDualstackEndpoint: false,
    useFipsEndpoint: false,
  } as const;
  if (provider?.kind === "cloudflare-r2") {
    if (Object.keys(provider).some((key) => !["accountId", "credentials", "jurisdiction", "kind"].includes(key))) {
      throw new TypeError("The Cloudflare R2 provider configuration is invalid.");
    }
    if (!/^[0-9a-f]{32}$/u.test(provider.accountId)) throw new TypeError("Cloudflare account ID is invalid.");
    if (provider.jurisdiction !== undefined && !["default", "eu", "fedramp"].includes(provider.jurisdiction)) {
      throw new TypeError("Cloudflare R2 jurisdiction is invalid.");
    }
    const jurisdiction = provider.jurisdiction ?? "default";
    const jurisdictionLabel = jurisdiction === "default" ? "" : `${jurisdiction}.`;
    return {
      ...base,
      credentials: staticCredentials(provider.credentials, true),
      endpoint: `https://${provider.accountId}.${jurisdictionLabel}r2.cloudflarestorage.com`,
      region: "auto",
    };
  }
  if (provider?.kind === "aws-s3") {
    if (Object.keys(provider).some((key) => !["credentials", "kind", "region"].includes(key))) {
      throw new TypeError("The AWS S3 provider configuration is invalid.");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(provider.region) || provider.region === "auto") {
      throw new TypeError("AWS S3 region is invalid.");
    }
    if (
      !provider.credentials ||
      (provider.credentials.source !== "aws-default-chain" && provider.credentials.source !== "static")
    ) {
      throw new TypeError("The AWS S3 credential source is invalid.");
    }
    const credentials =
      provider.credentials.source === "static"
        ? staticCredentials(
            {
              accessKeyId: provider.credentials.accessKeyId,
              secretAccessKey: provider.credentials.secretAccessKey,
              ...(provider.credentials.sessionToken === undefined
                ? {}
                : { sessionToken: provider.credentials.sessionToken }),
            },
            true,
          )
        : undefined;
    if (
      Object.keys(provider.credentials).some((key) =>
        provider.credentials.source === "static"
          ? !["accessKeyId", "secretAccessKey", "sessionToken", "source"].includes(key)
          : key !== "source",
      )
    ) {
      throw new TypeError("The AWS S3 credential source is invalid.");
    }
    return {
      ...base,
      ...(credentials === undefined ? {} : { credentials }),
      region: provider.region,
    };
  }
  throw new TypeError("The production S3 provider is invalid.");
}

function resolveClient(options: PrivateImmutableS3BucketTransportOptionsV1) {
  if (options.deployment !== "production" && options.deployment !== "test") {
    throw new TypeError("The S3 deployment mode is invalid.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket)) {
    throw new TypeError("The private S3 bucket name is invalid.");
  }
  if (options.deployment === "production") {
    if (Object.keys(options).some((key) => !["bucket", "deployment", "provider"].includes(key))) {
      throw new TypeError("The production S3 transport configuration is invalid.");
    }
    const provider = (options as Readonly<{ provider?: unknown }>).provider;
    const clientConfig = productionClientConfig(provider as PrivateImmutableS3ProductionProviderV1);
    if (
      provider &&
      typeof provider === "object" &&
      "kind" in provider &&
      provider.kind === "cloudflare-r2" &&
      options.bucket.includes(".")
    ) {
      throw new TypeError("Cloudflare R2 bucket names must not contain dots.");
    }
    return { client: new S3Client(clientConfig), ownsClient: true };
  }
  const client = "client" in options ? options.client : undefined;
  const clientConfig = "clientConfig" in options ? options.clientConfig : undefined;
  if ((client === undefined) === (clientConfig === undefined)) {
    throw new TypeError("Test S3 requires exactly one client or client configuration.");
  }
  if (clientConfig?.endpoint !== undefined && typeof clientConfig.endpoint !== "string") {
    throw new TypeError("The S3 endpoint must be a statically validated URL string.");
  }
  validateEndpoint(typeof clientConfig?.endpoint === "string" ? clientConfig.endpoint : undefined, "test");
  return { client: client ?? new S3Client(clientConfig!), ownsClient: client === undefined };
}

function operationSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(S3_OPERATION_TIMEOUT_MS_V1);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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

function isCreateConflict(error: unknown) {
  return (
    isNamedError(error, "PreconditionFailed") ||
    statusCode(error) === 412 ||
    isNamedError(error, "ConditionalRequestConflict")
  );
}

function destroyBody(body: unknown) {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy();
}

class PrivateImmutableS3BucketOperation implements PrivateImmutableS3BucketOperationV1 {
  readonly signal: AbortSignal;
  readonly #assertOpen: () => void;
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string, signal: AbortSignal, assertOpen: () => void) {
    this.#assertOpen = assertOpen;
    this.#bucket = bucket;
    this.#client = client;
    this.signal = signal;
  }

  async #send<T>(request: (signal: AbortSignal) => Promise<T>) {
    this.#assertOpen();
    this.signal.throwIfAborted();
    const bounded = operationSignal(this.signal);
    try {
      const result = await request(bounded);
      bounded.throwIfAborted();
      this.#assertOpen();
      return result;
    } catch (error) {
      bounded.throwIfAborted();
      throw error;
    }
  }

  async getObject(
    input: Readonly<{
      byteSize: number;
      etag: string;
      objectKey: string;
      range?: PrivateImmutableObjectRangeV1;
    }>,
  ) {
    const key = objectKey(input?.objectKey);
    const expectedEtag = etag(input?.etag);
    const total = byteSize(input?.byteSize);
    const requestedRange = range(input?.range, total);
    this.#assertOpen();
    this.signal.throwIfAborted();
    const headerAbort = new AbortController();
    const timeout = setTimeout(
      () => headerAbort.abort(new Error("S3 response headers timed out.")),
      S3_OPERATION_TIMEOUT_MS_V1,
    );
    timeout.unref();
    const headerSignal = AbortSignal.any([this.signal, headerAbort.signal]);
    let response;
    try {
      response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          IfMatch: expectedEtag,
          Key: key,
          ...(requestedRange ? { Range: `bytes=${requestedRange.start}-${requestedRange.end}` } : {}),
        }),
        { abortSignal: headerSignal },
      );
      headerSignal.throwIfAborted();
      this.#assertOpen();
    } catch (error) {
      if (response) destroyBody(response.Body);
      headerSignal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    try {
      const responseEtag = etag(response.ETag);
      const expectedBytes = requestedRange ? requestedRange.end - requestedRange.start + 1 : total;
      const expectedRange = requestedRange ? `bytes ${requestedRange.start}-${requestedRange.end}/${total}` : undefined;
      if (
        responseEtag !== expectedEtag ||
        response.ContentLength !== expectedBytes ||
        response.ContentRange !== expectedRange ||
        response.Body === undefined ||
        response.Body === null
      ) {
        throw new Error("S3 returned object headers outside the immutable read contract.");
      }
      return {
        body: response.Body,
        byteSize: expectedBytes,
        ...(expectedRange === undefined ? {} : { contentRange: expectedRange }),
        ...(response.ContentType === undefined ? {} : { contentType: contentType(response.ContentType) }),
        etag: responseEtag,
        metadata: metadata(response.Metadata),
      };
    } catch (error) {
      destroyBody(response.Body);
      throw error;
    }
  }

  async headObject(input: Readonly<{ byteSize: number; etag: string; objectKey: string }>) {
    const key = objectKey(input?.objectKey);
    const expectedEtag = etag(input?.etag);
    const expectedBytes = byteSize(input?.byteSize);
    const response = await this.#send((signal) =>
      this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, IfMatch: expectedEtag, Key: key }), {
        abortSignal: signal,
      }),
    );
    const responseEtag = etag(response.ETag);
    if (responseEtag !== expectedEtag || response.ContentLength !== expectedBytes) {
      throw new Error("S3 returned object headers outside the immutable HEAD contract.");
    }
    return {
      byteSize: expectedBytes,
      ...(response.ContentType === undefined ? {} : { contentType: contentType(response.ContentType) }),
      etag: responseEtag,
      metadata: metadata(response.Metadata),
    };
  }

  async putObject(
    input: Readonly<{
      body: Uint8Array;
      contentType: string;
      metadata?: Readonly<Record<string, string>>;
      objectKey: string;
    }>,
  ): Promise<PrivateImmutableObjectPutResultV1> {
    const key = objectKey(input?.objectKey);
    if (!(input?.body instanceof Uint8Array)) throw new TypeError("Immutable object body is invalid.");
    byteSize(input.body.byteLength);
    const type = contentType(input.contentType);
    const objectMetadata = metadata(input.metadata);
    this.#assertOpen();
    this.signal.throwIfAborted();
    const bounded = operationSignal(this.signal);
    try {
      const response = await this.#client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: this.#bucket,
          ContentLength: input.body.byteLength,
          ContentType: type,
          IfNoneMatch: "*",
          Key: key,
          Metadata: objectMetadata,
        }),
        { abortSignal: bounded },
      );
      this.#assertOpen();
      bounded.throwIfAborted();
      return { etag: etag(response.ETag), kind: "created" };
    } catch (error) {
      bounded.throwIfAborted();
      if (isCreateConflict(error)) return { kind: "already-exists" };
      throw error;
    }
  }

  async deleteObject(value: string) {
    const key = objectKey(value);
    await this.#send((signal) =>
      this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }), { abortSignal: signal }),
    );
  }

  async listObjectsPage(input: Readonly<{ cursor?: string; maximum: number; prefix: string }>) {
    const prefix = objectPrefix(input?.prefix);
    if (!Number.isSafeInteger(input?.maximum) || input.maximum < 1 || input.maximum > MAX_LIST_PAGE_RESULTS_V1) {
      throw new RangeError("Immutable object-list maximum is invalid.");
    }
    const cursor =
      input.cursor === undefined
        ? undefined
        : boundedOpaque(input.cursor, MAX_CURSOR_UTF8_BYTES_V1, "Immutable object-list cursor");
    const response = await this.#send((signal) =>
      this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
          MaxKeys: input.maximum,
          Prefix: prefix,
        }),
        { abortSignal: signal },
      ),
    );
    const contents = response.Contents ?? [];
    if (
      typeof response.IsTruncated !== "boolean" ||
      contents.length > input.maximum ||
      (response.KeyCount !== undefined &&
        (!Number.isSafeInteger(response.KeyCount) || response.KeyCount !== contents.length))
    ) {
      throw new Error("S3 exceeded the bounded immutable object-list page size.");
    }
    const seen = new Set<string>();
    const objects = contents.map((entry) => {
      const key = objectKey(entry.Key);
      if (!key.startsWith(prefix) || seen.has(key)) {
        throw new Error("S3 returned an object outside the requested immutable prefix.");
      }
      seen.add(key);
      const size = byteSize(entry.Size);
      const modified = entry.LastModified;
      if (!(modified instanceof Date) || Number.isNaN(modified.getTime())) {
        throw new Error("S3 returned invalid immutable object modification metadata.");
      }
      return { byteSize: size, etag: etag(entry.ETag), lastModified: new Date(modified.getTime()), objectKey: key };
    });
    let nextCursor: string | null = null;
    if (response.IsTruncated) {
      nextCursor = boundedOpaque(
        response.NextContinuationToken,
        MAX_CURSOR_UTF8_BYTES_V1,
        "Immutable object-list cursor",
      );
      if (objects.length === 0 || nextCursor === cursor) {
        throw new Error("S3 returned a non-progressing immutable object-list page.");
      }
    } else if (response.NextContinuationToken !== undefined) {
      throw new Error("S3 returned an unexpected immutable object-list cursor.");
    }
    return { nextCursor, objects };
  }
}

/**
 * Deadline-bounded exact-key transport shared by private unversioned S3 and R2
 * buckets. `ready()` proves authenticated bucket reachability only; deployment
 * policy and IaC remain the authority for bucket privacy.
 */
export class PrivateImmutableS3BucketTransportV1 {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #ownsClient: boolean;
  #activeLeases = 0;
  #closed = false;
  #closeRequest: Promise<void> | null = null;
  #resolveClose: (() => void) | null = null;

  constructor(options: PrivateImmutableS3BucketTransportOptionsV1) {
    const resolved = resolveClient(options);
    this.#bucket = options.bucket;
    this.#client = resolved.client;
    this.#ownsClient = resolved.ownsClient;
  }

  acquire(): PrivateImmutableS3BucketTransportLeaseV1 {
    if (this.#closed || this.#closeRequest) throw new Error("The private immutable S3 transport is closed.");
    this.#activeLeases += 1;
    let released = false;
    const leaseAbort = new AbortController();
    const assertOpen = () => {
      if (released || this.#closed) throw new Error("The private immutable S3 transport lease is closed.");
    };
    return {
      close: async () => {
        if (released) return;
        released = true;
        leaseAbort.abort(new Error("The private immutable S3 transport lease is closed."));
        this.#activeLeases -= 1;
        if (this.#activeLeases === 0) this.#finishClose();
      },
      operation: (signal) => {
        assertOpen();
        const callerSignal = signal ?? new AbortController().signal;
        const requestSignal = AbortSignal.any([callerSignal, leaseAbort.signal]);
        requestSignal.throwIfAborted();
        return new PrivateImmutableS3BucketOperation(this.#client, this.#bucket, requestSignal, assertOpen);
      },
      ready: (signal) => {
        const callerSignal = signal ?? new AbortController().signal;
        return this.#ready(assertOpen, AbortSignal.any([callerSignal, leaseAbort.signal]));
      },
    };
  }

  close() {
    if (this.#closed) return Promise.resolve();
    this.#closeRequest ??= new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
    if (this.#activeLeases === 0) this.#finishClose();
    return this.#closeRequest;
  }

  async #ready(assertOpen: () => void, signal?: AbortSignal) {
    const bounded = operationSignal(signal);
    try {
      assertOpen();
      bounded.throwIfAborted();
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), { abortSignal: bounded });
      bounded.throwIfAborted();
      assertOpen();
      return true;
    } catch {
      bounded.throwIfAborted();
      assertOpen();
      return false;
    }
  }

  #finishClose() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsClient) this.#client.destroy();
    this.#resolveClose?.();
    this.#resolveClose = null;
  }
}

export function acquirePrivateImmutableS3BucketTransportV1(options: PrivateImmutableS3BucketConsumerOptionsV1) {
  const transport = "transport" in options ? options.transport : new PrivateImmutableS3BucketTransportV1(options);
  if (!(transport instanceof PrivateImmutableS3BucketTransportV1)) {
    throw new TypeError("The private immutable S3 transport is invalid.");
  }
  return transport.acquire();
}

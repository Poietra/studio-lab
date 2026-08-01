import { isIP } from "node:net";

import {
  DeleteObjectCommand,
  type DeleteObjectCommandInput,
  type DeleteObjectCommandOutput,
  GetBucketAclCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyStatusCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandInput,
  type HeadObjectCommandOutput,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandInput,
  type ListObjectVersionsCommandOutput,
  PutObjectCommand,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

const S3_OPERATION_TIMEOUT_MS_V1 = 30_000;
const MAX_VERSION_PAGE_RESULTS_V1 = 256;
const MAX_S3_KEY_BYTES_V1 = 1_024;
const MAX_S3_VERSION_ID_LENGTH_V1 = 1_024;

type WithoutBucket<T> = Omit<T, "Bucket">;

export type PrivateVersionedS3BucketOperationV1 = Readonly<{
  /** Returns the SDK body stream unchanged so authorized Range readers need not buffer an object. */
  getObject: (input: WithoutBucket<GetObjectCommandInput>) => Promise<GetObjectCommandOutput>;
  headObject: (input: WithoutBucket<HeadObjectCommandInput>) => Promise<HeadObjectCommandOutput>;
  listObjectVersionsPage: (
    input: WithoutBucket<ListObjectVersionsCommandInput>,
  ) => Promise<ListObjectVersionsCommandOutput>;
  putObject: (input: WithoutBucket<PutObjectCommandInput>) => Promise<PutObjectCommandOutput>;
  deleteObjectVersion: (input: WithoutBucket<DeleteObjectCommandInput>) => Promise<DeleteObjectCommandOutput>;
  signal: AbortSignal;
}>;

export type PrivateVersionedS3BucketTransportLeaseV1 = Readonly<{
  close: () => Promise<void>;
  operation: (signal?: AbortSignal) => PrivateVersionedS3BucketOperationV1;
  ready: (signal?: AbortSignal) => Promise<boolean>;
}>;

export type PrivateVersionedS3BucketTransportOptionsV1 = Readonly<{
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  deployment: "production" | "test";
}>;

export type PrivateVersionedS3BucketConsumerOptionsV1 =
  | PrivateVersionedS3BucketTransportOptionsV1
  | Readonly<{ transport: PrivateVersionedS3BucketTransportV1 }>;

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

function validateOptions(options: PrivateVersionedS3BucketTransportOptionsV1) {
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
}

function operationSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(S3_OPERATION_TIMEOUT_MS_V1);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validateVersionPageInput(input: WithoutBucket<ListObjectVersionsCommandInput>) {
  if (
    !boundedString(input.Prefix, MAX_S3_KEY_BYTES_V1) ||
    !Number.isSafeInteger(input.MaxKeys) ||
    input.MaxKeys! < 1 ||
    input.MaxKeys! > MAX_VERSION_PAGE_RESULTS_V1
  ) {
    throw new RangeError("The S3 version-list request is not safely bounded.");
  }
  const hasKeyMarker = input.KeyMarker !== undefined;
  const hasVersionMarker = input.VersionIdMarker !== undefined;
  if (
    hasKeyMarker !== hasVersionMarker ||
    (hasKeyMarker && !boundedString(input.KeyMarker, MAX_S3_KEY_BYTES_V1)) ||
    (hasVersionMarker && !boundedString(input.VersionIdMarker, MAX_S3_VERSION_ID_LENGTH_V1))
  ) {
    throw new TypeError("The S3 version-list request cursor is invalid.");
  }
}

function validateVersionPageOutput(page: ListObjectVersionsCommandOutput, maximum: number) {
  const entries = (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
  if (entries > maximum) throw new Error("S3 exceeded the bounded version-list page size.");
  if (page.IsTruncated && entries === 0) throw new Error("S3 returned an empty truncated version-list page.");
  if (
    page.IsTruncated &&
    (!boundedString(page.NextKeyMarker, MAX_S3_KEY_BYTES_V1) ||
      !boundedString(page.NextVersionIdMarker, MAX_S3_VERSION_ID_LENGTH_V1))
  ) {
    throw new Error("S3 returned an incomplete version-list cursor.");
  }
}

class PrivateVersionedS3BucketOperation implements PrivateVersionedS3BucketOperationV1 {
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
    const result = await request(bounded);
    this.#assertOpen();
    this.signal.throwIfAborted();
    return result;
  }

  async getObject(input: WithoutBucket<GetObjectCommandInput>) {
    this.#assertOpen();
    this.signal.throwIfAborted();
    const headerAbort = new AbortController();
    const timeout = setTimeout(
      () => headerAbort.abort(new Error("S3 response headers timed out.")),
      S3_OPERATION_TIMEOUT_MS_V1,
    );
    timeout.unref();
    try {
      const response = await this.#client.send(new GetObjectCommand({ ...input, Bucket: this.#bucket }), {
        abortSignal: AbortSignal.any([this.signal, headerAbort.signal]),
      });
      this.#assertOpen();
      this.signal.throwIfAborted();
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  headObject(input: WithoutBucket<HeadObjectCommandInput>) {
    return this.#send((signal) =>
      this.#client.send(new HeadObjectCommand({ ...input, Bucket: this.#bucket }), { abortSignal: signal }),
    );
  }

  async listObjectVersionsPage(input: WithoutBucket<ListObjectVersionsCommandInput>) {
    validateVersionPageInput(input);
    const page = await this.#send((signal) =>
      this.#client.send(new ListObjectVersionsCommand({ ...input, Bucket: this.#bucket }), {
        abortSignal: signal,
      }),
    );
    validateVersionPageOutput(page, input.MaxKeys!);
    return page;
  }

  putObject(input: WithoutBucket<PutObjectCommandInput>) {
    return this.#send((signal) =>
      this.#client.send(new PutObjectCommand({ ...input, Bucket: this.#bucket }), { abortSignal: signal }),
    );
  }

  deleteObjectVersion(input: WithoutBucket<DeleteObjectCommandInput>) {
    if (
      !boundedString(input.Key, MAX_S3_KEY_BYTES_V1) ||
      !boundedString(input.VersionId, MAX_S3_VERSION_ID_LENGTH_V1)
    ) {
      throw new TypeError("The S3 object-version deletion target is invalid.");
    }
    return this.#send((signal) =>
      this.#client.send(new DeleteObjectCommand({ ...input, Bucket: this.#bucket }), { abortSignal: signal }),
    );
  }
}

/** Validated, deadline-bounded transport for one private and versioned S3 bucket. */
export class PrivateVersionedS3BucketTransportV1 {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #deployment: "production" | "test";
  readonly #ownsClient: boolean;
  #activeLeases = 0;
  #closed = false;
  #closeRequest: Promise<void> | null = null;
  #resolveClose: (() => void) | null = null;

  constructor(options: PrivateVersionedS3BucketTransportOptionsV1) {
    validateOptions(options);
    this.#bucket = options.bucket;
    this.#client = options.client ?? new S3Client(options.clientConfig!);
    this.#deployment = options.deployment;
    this.#ownsClient = options.client === undefined;
  }

  acquire(): PrivateVersionedS3BucketTransportLeaseV1 {
    if (this.#closed || this.#closeRequest) throw new Error("The private S3 bucket transport is closed.");
    this.#activeLeases += 1;
    let released = false;
    const assertOpen = () => {
      if (released || this.#closed) throw new Error("The private S3 bucket transport lease is closed.");
    };
    return {
      close: async () => {
        if (released) return;
        released = true;
        this.#activeLeases -= 1;
        if (this.#activeLeases === 0) this.#finishClose();
      },
      operation: (signal) => {
        assertOpen();
        const requestSignal = signal ?? new AbortController().signal;
        requestSignal.throwIfAborted();
        return new PrivateVersionedS3BucketOperation(this.#client, this.#bucket, requestSignal, assertOpen);
      },
      ready: (signal) => this.#ready(assertOpen, signal),
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
      const policyStatus = this.#client
        .send(new GetBucketPolicyStatusCommand({ Bucket: this.#bucket }), { abortSignal: bounded })
        .catch((error: unknown) => {
          if (isNamedError(error, "NoSuchBucketPolicy")) return null;
          throw error;
        });
      const lifecycle = this.#client
        .send(new GetBucketLifecycleConfigurationCommand({ Bucket: this.#bucket }), { abortSignal: bounded })
        .catch((error: unknown) => {
          if (isNamedError(error, "NoSuchLifecycleConfiguration")) return null;
          throw error;
        });
      const [, versioning, acl, policyResult, lifecycleConfiguration] = await Promise.all([
        this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), { abortSignal: bounded }),
        this.#client.send(new GetBucketVersioningCommand({ Bucket: this.#bucket }), { abortSignal: bounded }),
        this.#client.send(new GetBucketAclCommand({ Bucket: this.#bucket }), { abortSignal: bounded }),
        policyStatus,
        lifecycle,
      ]);
      assertOpen();
      bounded.throwIfAborted();
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
        (policyResult === null || policyResult.PolicyStatus?.IsPublic === false) &&
        lifecycleConfiguration === null
      );
    } catch {
      assertOpen();
      bounded.throwIfAborted();
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

export function acquirePrivateVersionedS3BucketTransportV1(options: PrivateVersionedS3BucketConsumerOptionsV1) {
  const shared = "transport" in options;
  const transport = shared ? options.transport : new PrivateVersionedS3BucketTransportV1(options);
  if (!(transport instanceof PrivateVersionedS3BucketTransportV1)) {
    throw new TypeError("The private S3 bucket transport is invalid.");
  }
  const lease = transport.acquire();
  if (shared) return lease;
  return {
    ...lease,
    async close() {
      await lease.close();
      await transport.close();
    },
  };
}

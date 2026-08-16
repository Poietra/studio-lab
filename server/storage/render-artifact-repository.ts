import { manimTenantIdSchema } from "../manim-request-principal";
import {
  createImmutableObjectLocatorTokenV1,
  immutableObjectKeyV1,
  immutableObjectLocatorTokenV1,
  parseImmutableObjectLocatorV1,
} from "./immutable-object-contract";

export const MAX_RENDER_ARTIFACT_BYTES_V1 = 128 * 1024 * 1024;
export const MAX_RENDER_THUMBNAIL_BYTES_V1 = 4 * 1024 * 1024;
export const RENDER_ARTIFACT_KINDS_V1 = ["thumbnail", "video"] as const;

export type RenderArtifactKindV1 = (typeof RENDER_ARTIFACT_KINDS_V1)[number];
export type RenderArtifactMediaTypeV1 = "image/png" | "video/mp4";

export class RenderArtifactReadErrorV1 extends Error {
  readonly code: "corrupt" | "missing";

  constructor(code: "corrupt" | "missing") {
    super(code === "missing" ? "The render artifact object is missing." : "The render artifact is corrupt.");
    this.name = "RenderArtifactReadErrorV1";
    this.code = code;
  }
}

export type RenderArtifactIdentityV1 = Readonly<{
  artifactDigest: string;
  byteSize: number;
  kind: RenderArtifactKindV1;
  mediaType: RenderArtifactMediaTypeV1;
  profileDigest: string;
  requestDigest: string;
  runtimeDigest: string;
  sourceDigest: string;
}>;

export type VersionedRenderArtifactReceiptV1 = RenderArtifactIdentityV1 &
  Readonly<{
    etag: string;
    objectGeneration?: never;
    objectKey: string;
    versionId: string;
  }>;

export type ImmutableRenderArtifactReceiptV1 = RenderArtifactIdentityV1 &
  Readonly<{
    etag: string;
    /** Legacy persisted spelling of the random object locator token (#715); never ordered or monotonic. */
    objectGeneration: string;
    objectKey: string;
    versionId?: never;
  }>;

/** Explicit rolling locator union; a parsed receipt always has exactly one locator member. */
export type RenderArtifactReceiptV1 = VersionedRenderArtifactReceiptV1 | ImmutableRenderArtifactReceiptV1;

export type PublishedRenderArtifactV1 = Readonly<{
  artifactId: string;
  expiresAt: Date;
  receipt: RenderArtifactReceiptV1;
}>;

export type RenderArtifactReadClaimV1 = Readonly<{
  artifact: PublishedRenderArtifactV1;
  claimId: string;
  claimExpiresAt: Date;
}>;

export type RenderArtifactVersionV1 = Readonly<{
  lastModified: Date;
  receipt: VersionedRenderArtifactReceiptV1;
}>;

export type RenderArtifactVersionPageV1 = Readonly<{
  nextCursor: string | null;
  versions: readonly RenderArtifactVersionV1[];
}>;

export type RenderArtifactObjectV1 = Readonly<{
  lastModified: Date;
  receipt: RenderArtifactReceiptV1;
}>;

export type RenderArtifactObjectPageV1 = Readonly<{
  nextCursor: string | null;
  objects: readonly RenderArtifactObjectV1[];
}>;

export type RenderArtifactDeletionV1 = Readonly<{
  deletionId: string;
  receipt: RenderArtifactReceiptV1;
  tenantId: string;
}>;

export type PublishRenderArtifactsInputV1 = Readonly<{
  artifacts: Readonly<{
    thumbnail: Readonly<{
      artifactId: string;
      receipt: RenderArtifactReceiptV1;
    }>;
    video: Readonly<{ artifactId: string; receipt: RenderArtifactReceiptV1 }>;
  }>;
  expectedVersion: bigint;
  expirationMs: number;
  fenceToken: bigint;
  logTail: string;
  ownerId: string;
  sessionId: string;
  tenantId: string;
}>;

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTITY_FIELDS = [
  "artifactDigest",
  "byteSize",
  "kind",
  "mediaType",
  "profileDigest",
  "requestDigest",
  "runtimeDigest",
  "sourceDigest",
] as const;
const RECEIPT_FIELDS = new Set<string>([...IDENTITY_FIELDS, "etag", "objectGeneration", "objectKey", "versionId"]);

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function tenantId(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Tenant ID is invalid.");
  return parsed.data;
}

export function renderArtifactObjectKeyV1(
  tenantValue: string,
  identity: Pick<
    RenderArtifactIdentityV1,
    "artifactDigest" | "kind" | "profileDigest" | "requestDigest" | "runtimeDigest" | "sourceDigest"
  >,
) {
  const tenant = tenantId(tenantValue);
  const kind = identity?.kind;
  if (!RENDER_ARTIFACT_KINDS_V1.includes(kind)) throw new TypeError("Render artifact kind is invalid.");
  const source = digest(identity.sourceDigest, "Render artifact source digest");
  const runtime = digest(identity.runtimeDigest, "Render artifact runtime digest");
  const profile = digest(identity.profileDigest, "Render artifact profile digest");
  const request = digest(identity.requestDigest, "Render artifact request digest");
  const artifact = digest(identity.artifactDigest, "Render artifact digest");
  return `tenants/${tenant}/media/${kind}/${source}/${runtime}/${profile}/${request}/${artifact}`;
}

export function renderArtifactMediaTypeV1(kind: unknown): RenderArtifactMediaTypeV1 {
  if (!RENDER_ARTIFACT_KINDS_V1.includes(kind as RenderArtifactKindV1)) {
    throw new TypeError("Render artifact kind is invalid.");
  }
  return kind === "video" ? "video/mp4" : "image/png";
}

export function parseRenderArtifactIdentityV1(tenantValue: string, value: unknown): RenderArtifactIdentityV1 {
  const tenant = tenantId(tenantValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Render artifact identity is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const identity = Object.fromEntries(
    IDENTITY_FIELDS.map((field) => [field, candidate[field]]),
  ) as RenderArtifactIdentityV1;
  const expectedMediaType = renderArtifactMediaTypeV1(identity.kind);
  if (
    identity.mediaType !== expectedMediaType ||
    !Number.isSafeInteger(identity.byteSize) ||
    identity.byteSize < 1 ||
    identity.byteSize > (identity.kind === "thumbnail" ? MAX_RENDER_THUMBNAIL_BYTES_V1 : MAX_RENDER_ARTIFACT_BYTES_V1)
  ) {
    throw new TypeError("Render artifact identity is invalid.");
  }
  renderArtifactObjectKeyV1(tenant, identity);
  return identity;
}

function receiptEtagV1(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Render artifact ETag is invalid.");
  }
  return value;
}

function assertRenderArtifactReceiptFieldsV1(value: Record<string, unknown>) {
  if (Object.keys(value).some((field) => !RECEIPT_FIELDS.has(field))) {
    throw new TypeError("Render artifact receipt contains an unknown field.");
  }
}

export function immutableRenderArtifactObjectKeyV1(
  tenantValue: string,
  value: RenderArtifactIdentityV1,
  objectLocatorToken: string,
) {
  const tenant = tenantId(tenantValue);
  const identity = parseRenderArtifactIdentityV1(tenant, value);
  return immutableObjectKeyV1({
    contentAddressedKey: renderArtifactObjectKeyV1(tenant, identity),
    contentDigest: identity.artifactDigest,
    objectLocatorToken,
    tenantId: tenant,
  });
}

/** Allocates a fresh random locator token and returns the legacy-spelled locator pair receipts persist. */
export function createImmutableRenderArtifactLocatorV1(tenantValue: string, value: RenderArtifactIdentityV1) {
  const objectLocatorToken = createImmutableObjectLocatorTokenV1();
  return {
    objectGeneration: objectLocatorToken,
    objectKey: immutableRenderArtifactObjectKeyV1(tenantValue, value, objectLocatorToken),
  } as const;
}

export function parseVersionedRenderArtifactReceiptV1(
  tenantValue: string,
  value: unknown,
): VersionedRenderArtifactReceiptV1 {
  const tenant = tenantId(tenantValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Versioned render artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  assertRenderArtifactReceiptFieldsV1(candidate);
  const identity = parseRenderArtifactIdentityV1(tenant, candidate);
  if (
    (candidate.objectGeneration !== undefined && candidate.objectGeneration !== null) ||
    typeof candidate.versionId !== "string" ||
    candidate.versionId.length < 1 ||
    candidate.versionId.length > 1_024 ||
    candidate.objectKey !== renderArtifactObjectKeyV1(tenant, identity)
  ) {
    throw new TypeError("Versioned render artifact receipt is invalid.");
  }
  return {
    ...identity,
    etag: receiptEtagV1(candidate.etag),
    objectKey: candidate.objectKey,
    versionId: candidate.versionId,
  };
}

export function parseImmutableRenderArtifactReceiptV1(
  tenantValue: string,
  value: unknown,
): ImmutableRenderArtifactReceiptV1 {
  const tenant = tenantId(tenantValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable render artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  assertRenderArtifactReceiptFieldsV1(candidate);
  if (candidate.versionId !== undefined && candidate.versionId !== null) {
    throw new TypeError("Immutable render artifact receipt is invalid.");
  }
  const identity = parseRenderArtifactIdentityV1(tenant, candidate);
  const locator = parseImmutableObjectLocatorV1(
    {
      contentAddressedKey: renderArtifactObjectKeyV1(tenant, identity),
      contentDigest: identity.artifactDigest,
      tenantId: tenant,
    },
    candidate,
  );
  return { ...identity, etag: receiptEtagV1(candidate.etag), ...locator };
}

export function parseRenderArtifactReceiptV1(tenantValue: string, value: unknown): RenderArtifactReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Render artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const hasVersionId = candidate.versionId !== undefined && candidate.versionId !== null;
  const hasObjectGeneration = candidate.objectGeneration !== undefined && candidate.objectGeneration !== null;
  if (hasVersionId === hasObjectGeneration) throw new TypeError("Render artifact locator mode is invalid.");
  return hasVersionId
    ? parseVersionedRenderArtifactReceiptV1(tenantValue, candidate)
    : parseImmutableRenderArtifactReceiptV1(tenantValue, candidate);
}

export function isVersionedRenderArtifactReceiptV1(
  value: RenderArtifactReceiptV1,
): value is VersionedRenderArtifactReceiptV1 {
  return typeof value.versionId === "string";
}

export function isImmutableRenderArtifactReceiptV1(
  value: RenderArtifactReceiptV1,
): value is ImmutableRenderArtifactReceiptV1 {
  return typeof value.objectGeneration === "string";
}

/**
 * Column-spelled exact locator for repository adapters. `objectGeneration`
 * mirrors the legacy `object_generation` column that stores the random locator
 * token, and the `generation:` advisory-identity prefix must stay stable
 * across deployments (#715 compatibility).
 */
export type RenderArtifactLocatorV1 =
  | Readonly<{
      advisoryIdentity: string;
      kind: "versioned";
      objectGeneration: null;
      objectKey: string;
      versionId: string;
    }>
  | Readonly<{
      advisoryIdentity: string;
      kind: "immutable";
      objectGeneration: string;
      objectKey: string;
      versionId: null;
    }>;

export function renderArtifactLocatorV1(value: RenderArtifactReceiptV1): RenderArtifactLocatorV1 {
  if (isVersionedRenderArtifactReceiptV1(value)) {
    return {
      advisoryIdentity: `version:${value.versionId}`,
      kind: "versioned",
      objectGeneration: null,
      objectKey: value.objectKey,
      versionId: value.versionId,
    };
  }
  const objectLocatorToken = immutableObjectLocatorTokenV1(value.objectGeneration);
  return {
    advisoryIdentity: `generation:${objectLocatorToken}`,
    kind: "immutable",
    objectGeneration: objectLocatorToken,
    objectKey: value.objectKey,
    versionId: null,
  };
}

export function sameRenderArtifactReceiptV1(left: RenderArtifactReceiptV1, right: RenderArtifactReceiptV1) {
  const leftLocator = renderArtifactLocatorV1(left);
  const rightLocator = renderArtifactLocatorV1(right);
  return (
    IDENTITY_FIELDS.every((field) => left[field] === right[field]) &&
    left.etag === right.etag &&
    left.objectKey === right.objectKey &&
    leftLocator.kind === rightLocator.kind &&
    leftLocator.versionId === rightLocator.versionId &&
    leftLocator.objectGeneration === rightLocator.objectGeneration
  );
}

export function renderArtifactIdV1(value: string, label = "Render artifact ID") {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

export interface RenderArtifactRepositoryV1 {
  acknowledgeDeletion(tenantId: string, deletionId: string, signal?: AbortSignal): Promise<void>;
  acquireProjectThumbnail(
    tenantId: string,
    projectId: string,
    claimDurationMs: number,
    signal?: AbortSignal,
  ): Promise<RenderArtifactReadClaimV1>;
  acquireSessionVideo(
    tenantId: string,
    sessionId: string,
    claimDurationMs: number,
    signal?: AbortSignal,
  ): Promise<RenderArtifactReadClaimV1>;
  close(): Promise<void>;
  isArtifactRetained(tenantId: string, receipt: RenderArtifactReceiptV1, signal?: AbortSignal): Promise<boolean>;
  pendingDeletions(
    tenantId: string,
    maximum: number,
    signal?: AbortSignal,
  ): Promise<readonly RenderArtifactDeletionV1[]>;
  publishSessionArtifacts(input: PublishRenderArtifactsInputV1, signal?: AbortSignal): Promise<void>;
  queueDeletion(
    tenantId: string,
    receipt: RenderArtifactReceiptV1,
    graceMs: number,
    signal?: AbortSignal,
  ): Promise<RenderArtifactDeletionV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  releaseReadClaim(tenantId: string, claimId: string, signal?: AbortSignal): Promise<void>;
  renewReadClaim(tenantId: string, claimId: string, claimDurationMs: number, signal?: AbortSignal): Promise<Date>;
}

export interface RenderArtifactStoreV1 {
  close(): Promise<void>;
  deleteObject(tenantId: string, receipt: RenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  head(tenantId: string, receipt: RenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  listObjects(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<RenderArtifactObjectPageV1>;
  open(
    tenantId: string,
    receipt: RenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  put(
    tenantId: string,
    input: RenderArtifactIdentityV1 & Readonly<{ bytes: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<RenderArtifactReceiptV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

export interface VersionedRenderArtifactStoreV1 extends RenderArtifactStoreV1 {
  deleteVersion(tenantId: string, receipt: VersionedRenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<RenderArtifactVersionPageV1>;
}

export function assertRenderArtifactPublishedV1(value: PublishedRenderArtifactV1, tenantId: string) {
  return {
    artifactId: renderArtifactIdV1(value.artifactId),
    expiresAt:
      value.expiresAt instanceof Date && !Number.isNaN(value.expiresAt.getTime())
        ? value.expiresAt
        : (() => {
            throw new TypeError("Render artifact expiry is invalid.");
          })(),
    receipt: parseRenderArtifactReceiptV1(tenantId, value.receipt),
  } satisfies PublishedRenderArtifactV1;
}

export function boundedRenderArtifactTextV1(value: string, label: string, maximumBytes: number, empty = false) {
  const length = typeof value === "string" ? Buffer.byteLength(value, "utf8") : -1;
  if (length < (empty ? 0 : 1) || length > maximumBytes) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function boundedRenderArtifactIntegerV1(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

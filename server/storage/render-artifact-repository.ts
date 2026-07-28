import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_RENDER_ARTIFACT_BYTES_V1 = 128 * 1024 * 1024;
export const MAX_RENDER_THUMBNAIL_BYTES_V1 = 4 * 1024 * 1024;
export const RENDER_ARTIFACT_KINDS_V1 = ["thumbnail", "video"] as const;

export type RenderArtifactKindV1 = (typeof RENDER_ARTIFACT_KINDS_V1)[number];

export class RenderArtifactReadErrorV1 extends Error {
  readonly code: "corrupt" | "missing";

  constructor(code: "corrupt" | "missing") {
    super(code === "missing" ? "The render artifact version is missing." : "The render artifact is corrupt.");
    this.name = "RenderArtifactReadErrorV1";
    this.code = code;
  }
}

export type RenderArtifactReceiptV1 = Readonly<{
  artifactDigest: string;
  byteSize: number;
  etag: string;
  kind: RenderArtifactKindV1;
  mediaType: "image/png" | "video/mp4";
  objectKey: string;
  profileDigest: string;
  requestDigest: string;
  runtimeDigest: string;
  sourceDigest: string;
  versionId: string;
}>;

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
  receipt: RenderArtifactReceiptV1;
}>;

export type RenderArtifactVersionPageV1 = Readonly<{
  nextCursor: string | null;
  versions: readonly RenderArtifactVersionV1[];
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
const RECEIPT_FIELDS = [
  "artifactDigest",
  "byteSize",
  "etag",
  "kind",
  "mediaType",
  "objectKey",
  "profileDigest",
  "requestDigest",
  "runtimeDigest",
  "sourceDigest",
  "versionId",
] as const;

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
    RenderArtifactReceiptV1,
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

export function parseRenderArtifactReceiptV1(tenantValue: string, value: unknown): RenderArtifactReceiptV1 {
  const tenant = tenantId(tenantValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Render artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const receipt = Object.fromEntries(
    RECEIPT_FIELDS.map((field) => [field, candidate[field]]),
  ) as RenderArtifactReceiptV1;
  if (
    !RENDER_ARTIFACT_KINDS_V1.includes(receipt.kind) ||
    (receipt.kind === "video" && receipt.mediaType !== "video/mp4") ||
    (receipt.kind === "thumbnail" && receipt.mediaType !== "image/png") ||
    !Number.isSafeInteger(receipt.byteSize) ||
    receipt.byteSize < 1 ||
    receipt.byteSize > (receipt.kind === "thumbnail" ? MAX_RENDER_THUMBNAIL_BYTES_V1 : MAX_RENDER_ARTIFACT_BYTES_V1) ||
    receipt.objectKey !== renderArtifactObjectKeyV1(tenant, receipt) ||
    typeof receipt.etag !== "string" ||
    receipt.etag.length < 1 ||
    receipt.etag.length > 512 ||
    typeof receipt.versionId !== "string" ||
    receipt.versionId.length < 1 ||
    receipt.versionId.length > 1_024
  ) {
    throw new TypeError("Render artifact receipt is invalid.");
  }
  digest(receipt.requestDigest, "Render artifact request digest");
  return receipt;
}

export function sameRenderArtifactReceiptV1(left: RenderArtifactReceiptV1, right: RenderArtifactReceiptV1) {
  return RECEIPT_FIELDS.every((field) => left[field] === right[field]);
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
  deleteVersion(tenantId: string, receipt: RenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  head(tenantId: string, receipt: RenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<RenderArtifactVersionPageV1>;
  open(
    tenantId: string,
    receipt: RenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  put(
    tenantId: string,
    input: Omit<RenderArtifactReceiptV1, "etag" | "objectKey" | "versionId"> & Readonly<{ bytes: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<RenderArtifactReceiptV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
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

import { manimTenantIdSchema } from "../manim-request-principal";
import {
  createImmutableObjectGenerationV1,
  immutableObjectGenerationV1,
  immutableObjectKeyV1,
  parseImmutableObjectLocatorV1,
} from "./immutable-object-contract";
import {
  MAX_RENDER_ARTIFACT_BYTES_V1,
  MAX_RENDER_THUMBNAIL_BYTES_V1,
  RENDER_ARTIFACT_KINDS_V1,
  type RenderArtifactKindV1,
  renderArtifactObjectKeyV1,
} from "./render-artifact-repository";

const RECEIPT_FIELDS = [
  "artifactDigest",
  "byteSize",
  "etag",
  "kind",
  "mediaType",
  "objectGeneration",
  "objectKey",
  "profileDigest",
  "requestDigest",
  "runtimeDigest",
  "sourceDigest",
] as const;

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

const METADATA_FIELDS = {
  artifactDigest: "artifact-digest",
  kind: "artifact-kind",
  objectGeneration: "object-generation",
  profileDigest: "profile-digest",
  requestDigest: "request-digest",
  runtimeDigest: "runtime-digest",
  sourceDigest: "source-digest",
} as const;

export type ImmutableRenderArtifactIdentityV1 = Readonly<{
  artifactDigest: string;
  byteSize: number;
  kind: RenderArtifactKindV1;
  mediaType: "image/png" | "video/mp4";
  profileDigest: string;
  requestDigest: string;
  runtimeDigest: string;
  sourceDigest: string;
}>;

export type ImmutableRenderArtifactReceiptV1 = ImmutableRenderArtifactIdentityV1 &
  Readonly<{
    etag: string;
    objectGeneration: string;
    objectKey: string;
  }>;

export type ImmutableRenderArtifactObjectIdentityV1 = Omit<
  ImmutableRenderArtifactReceiptV1,
  "byteSize" | "etag" | "mediaType"
>;

export type ImmutableRenderArtifactObjectV1 = Readonly<{
  lastModified: Date;
  receipt: ImmutableRenderArtifactReceiptV1;
}>;

export type ImmutableRenderArtifactObjectPageV1 = Readonly<{
  nextCursor: string | null;
  objects: readonly ImmutableRenderArtifactObjectV1[];
}>;

export interface ImmutableRenderArtifactStoreV1 {
  close(): Promise<void>;
  deleteObject(tenantId: string, receipt: ImmutableRenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  head(tenantId: string, receipt: ImmutableRenderArtifactReceiptV1, signal?: AbortSignal): Promise<void>;
  listObjects(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ImmutableRenderArtifactObjectPageV1>;
  open(
    tenantId: string,
    receipt: ImmutableRenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  put(
    tenantId: string,
    input: ImmutableRenderArtifactIdentityV1 & Readonly<{ bytes: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<ImmutableRenderArtifactReceiptV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
}

function tenantIdV1(value: unknown) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Immutable render artifact tenant ID is invalid.");
  return parsed.data;
}

export function immutableRenderArtifactMediaTypeV1(kind: unknown) {
  if (!RENDER_ARTIFACT_KINDS_V1.includes(kind as RenderArtifactKindV1)) {
    throw new TypeError("Immutable render artifact kind is invalid.");
  }
  return kind === "video" ? ("video/mp4" as const) : ("image/png" as const);
}

export function parseImmutableRenderArtifactIdentityV1(
  tenantValue: string,
  value: unknown,
): ImmutableRenderArtifactIdentityV1 {
  const tenantId = tenantIdV1(tenantValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable render artifact identity is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== IDENTITY_FIELDS.length ||
    IDENTITY_FIELDS.some((field) => !Object.hasOwn(candidate, field))
  ) {
    throw new TypeError("Immutable render artifact identity is invalid.");
  }
  return parseIdentityFieldsV1(tenantId, candidate);
}

function parseIdentityFieldsV1(tenantId: string, candidate: Record<string, unknown>) {
  const identity = {
    artifactDigest: candidate.artifactDigest,
    byteSize: candidate.byteSize,
    kind: candidate.kind,
    mediaType: candidate.mediaType,
    profileDigest: candidate.profileDigest,
    requestDigest: candidate.requestDigest,
    runtimeDigest: candidate.runtimeDigest,
    sourceDigest: candidate.sourceDigest,
  } as ImmutableRenderArtifactIdentityV1;
  const expectedMediaType = immutableRenderArtifactMediaTypeV1(identity.kind);
  const maximum = identity.kind === "thumbnail" ? MAX_RENDER_THUMBNAIL_BYTES_V1 : MAX_RENDER_ARTIFACT_BYTES_V1;
  if (
    identity.mediaType !== expectedMediaType ||
    !Number.isSafeInteger(identity.byteSize) ||
    identity.byteSize < 1 ||
    identity.byteSize > maximum
  ) {
    throw new TypeError("Immutable render artifact identity is invalid.");
  }
  renderArtifactObjectKeyV1(tenantId, identity);
  return identity;
}

export function immutableRenderArtifactContentAddressedKeyV1(
  tenantValue: string,
  value: ImmutableRenderArtifactIdentityV1,
) {
  const tenantId = tenantIdV1(tenantValue);
  const identity = parseImmutableRenderArtifactIdentityV1(tenantId, value);
  return renderArtifactObjectKeyV1(tenantId, identity);
}

export function immutableRenderArtifactObjectKeyV1(
  tenantValue: string,
  value: ImmutableRenderArtifactIdentityV1,
  objectGeneration: string,
) {
  const tenantId = tenantIdV1(tenantValue);
  const identity = parseImmutableRenderArtifactIdentityV1(tenantId, value);
  return immutableObjectKeyV1({
    contentAddressedKey: renderArtifactObjectKeyV1(tenantId, identity),
    contentDigest: identity.artifactDigest,
    objectGeneration,
    tenantId,
  });
}

export function createImmutableRenderArtifactLocatorV1(tenantValue: string, value: ImmutableRenderArtifactIdentityV1) {
  const objectGeneration = createImmutableObjectGenerationV1();
  return {
    objectGeneration,
    objectKey: immutableRenderArtifactObjectKeyV1(tenantValue, value, objectGeneration),
  } as const;
}

function receiptEtagV1(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Immutable render artifact ETag is invalid.");
  }
  return value;
}

export function parseImmutableRenderArtifactReceiptV1(
  tenantValue: string,
  value: unknown,
): ImmutableRenderArtifactReceiptV1 {
  const tenantId = tenantIdV1(tenantValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable render artifact receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== RECEIPT_FIELDS.length ||
    RECEIPT_FIELDS.some((field) => !Object.hasOwn(candidate, field))
  ) {
    throw new TypeError("Immutable render artifact receipt is invalid.");
  }
  const identity = parseIdentityFieldsV1(tenantId, candidate);
  const locator = parseImmutableObjectLocatorV1(
    {
      contentAddressedKey: renderArtifactObjectKeyV1(tenantId, identity),
      contentDigest: identity.artifactDigest,
      tenantId,
    },
    candidate,
  );
  return { ...identity, etag: receiptEtagV1(candidate.etag), ...locator };
}

export function sameImmutableRenderArtifactReceiptV1(
  left: ImmutableRenderArtifactReceiptV1,
  right: ImmutableRenderArtifactReceiptV1,
) {
  return RECEIPT_FIELDS.every((field) => left[field] === right[field]);
}

export function immutableRenderArtifactMetadataV1(
  value: Pick<
    ImmutableRenderArtifactReceiptV1,
    | "artifactDigest"
    | "kind"
    | "objectGeneration"
    | "profileDigest"
    | "requestDigest"
    | "runtimeDigest"
    | "sourceDigest"
  >,
) {
  return {
    [METADATA_FIELDS.artifactDigest]: value.artifactDigest,
    [METADATA_FIELDS.kind]: value.kind,
    [METADATA_FIELDS.objectGeneration]: immutableObjectGenerationV1(value.objectGeneration),
    [METADATA_FIELDS.profileDigest]: value.profileDigest,
    [METADATA_FIELDS.requestDigest]: value.requestDigest,
    [METADATA_FIELDS.runtimeDigest]: value.runtimeDigest,
    [METADATA_FIELDS.sourceDigest]: value.sourceDigest,
  };
}

export function immutableRenderArtifactMetadataMatchesV1(
  value: Readonly<Record<string, string>>,
  expected: ImmutableRenderArtifactReceiptV1,
) {
  const canonical: Readonly<Record<string, string>> = immutableRenderArtifactMetadataV1(expected);
  const keys = Object.keys(value);
  return keys.length === Object.keys(canonical).length && keys.every((key) => value[key] === canonical[key]);
}

export function immutableRenderArtifactMediaPrefixV1(tenantValue: string) {
  return `tenants/${tenantIdV1(tenantValue)}/media/`;
}

export function parseImmutableRenderArtifactObjectKeyV1(
  tenantValue: string,
  value: unknown,
): ImmutableRenderArtifactObjectIdentityV1 {
  const tenantId = tenantIdV1(tenantValue);
  if (typeof value !== "string") throw new TypeError("Immutable render artifact object key is invalid.");
  const segments = value.split("/");
  if (
    segments.length !== 11 ||
    segments[0] !== "tenants" ||
    segments[1] !== tenantId ||
    segments[2] !== "media" ||
    segments[9] !== "g"
  ) {
    throw new TypeError("Immutable render artifact object key is invalid.");
  }
  const kind = segments[3];
  if (!RENDER_ARTIFACT_KINDS_V1.includes(kind as RenderArtifactKindV1)) {
    throw new TypeError("Immutable render artifact object key is invalid.");
  }
  const identity = {
    artifactDigest: segments[8],
    kind: kind as RenderArtifactKindV1,
    profileDigest: segments[6],
    requestDigest: segments[7],
    runtimeDigest: segments[5],
    sourceDigest: segments[4],
  } as const;
  const contentAddressedKey = renderArtifactObjectKeyV1(tenantId, identity);
  const locator = parseImmutableObjectLocatorV1(
    { contentAddressedKey, contentDigest: identity.artifactDigest, tenantId },
    { objectGeneration: segments[10], objectKey: value },
  );
  return { ...identity, ...locator };
}

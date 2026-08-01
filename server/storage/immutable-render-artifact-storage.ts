import { manimTenantIdSchema } from "../manim-request-principal";
import { immutableObjectGenerationV1, parseImmutableObjectLocatorV1 } from "./immutable-object-contract";
import {
  createImmutableRenderArtifactLocatorV1,
  type ImmutableRenderArtifactReceiptV1,
  immutableRenderArtifactObjectKeyV1,
  parseImmutableRenderArtifactReceiptV1,
  parseRenderArtifactIdentityV1,
  RENDER_ARTIFACT_KINDS_V1,
  type RenderArtifactIdentityV1,
  type RenderArtifactKindV1,
  type RenderArtifactStoreV1,
  renderArtifactMediaTypeV1,
  renderArtifactObjectKeyV1,
  sameRenderArtifactReceiptV1,
} from "./render-artifact-repository";

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

export type ImmutableRenderArtifactIdentityV1 = RenderArtifactIdentityV1;
export type { ImmutableRenderArtifactReceiptV1 };

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

export type ImmutableRenderArtifactStoreV1 = RenderArtifactStoreV1;

function tenantIdV1(value: unknown) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Immutable render artifact tenant ID is invalid.");
  return parsed.data;
}

export function immutableRenderArtifactMediaTypeV1(kind: unknown) {
  return renderArtifactMediaTypeV1(kind);
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
  return parseRenderArtifactIdentityV1(tenantId, candidate);
}

export function immutableRenderArtifactContentAddressedKeyV1(
  tenantValue: string,
  value: ImmutableRenderArtifactIdentityV1,
) {
  const tenantId = tenantIdV1(tenantValue);
  const identity = parseImmutableRenderArtifactIdentityV1(tenantId, value);
  return renderArtifactObjectKeyV1(tenantId, identity);
}

export {
  createImmutableRenderArtifactLocatorV1,
  immutableRenderArtifactObjectKeyV1,
  parseImmutableRenderArtifactReceiptV1,
};

export function sameImmutableRenderArtifactReceiptV1(
  left: ImmutableRenderArtifactReceiptV1,
  right: ImmutableRenderArtifactReceiptV1,
) {
  return sameRenderArtifactReceiptV1(left, right);
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

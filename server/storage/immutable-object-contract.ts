import { randomUUID } from "node:crypto";

import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1 = 1_024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_ADDRESSED_KEY_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const UTF8_ENCODER = new TextEncoder();

export type ImmutableObjectLocatorV1 = Readonly<{
  objectGeneration: string;
  objectKey: string;
}>;

export type ImmutableObjectKeyInputV1 = Readonly<{
  contentAddressedKey: string;
  contentDigest: string;
  objectGeneration: string;
  tenantId: string;
}>;

function tenantIdV1(value: unknown) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Immutable object tenant ID is invalid.");
  return parsed.data;
}

function contentDigestV1(value: unknown) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError("Immutable object content digest is invalid.");
  }
  return value;
}

export function immutableObjectGenerationV1(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError("Immutable object generation is invalid.");
  }
  return value;
}

export function createImmutableObjectGenerationV1() {
  return immutableObjectGenerationV1(randomUUID());
}

function contentAddressedKeyV1(tenantId: string, contentDigest: string, value: unknown) {
  if (
    typeof value !== "string" ||
    !CONTENT_ADDRESSED_KEY_PATTERN.test(value) ||
    !value.startsWith(`tenants/${tenantId}/`) ||
    !value.endsWith(`/${contentDigest}`) ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("Immutable object content-addressed key is invalid.");
  }
  return value;
}

/**
 * Appends an application-owned generation to a store-specific content-addressed
 * key. The persistence adapter must enforce uniqueness with a conditional create
 * and a database constraint; this contract owns only the provider-neutral suffix.
 */
export function immutableObjectKeyV1(input: ImmutableObjectKeyInputV1) {
  const tenantId = tenantIdV1(input?.tenantId);
  const contentDigest = contentDigestV1(input?.contentDigest);
  const objectGeneration = immutableObjectGenerationV1(input?.objectGeneration);
  const contentAddressedKey = contentAddressedKeyV1(tenantId, contentDigest, input?.contentAddressedKey);
  const objectKey = `${contentAddressedKey}/g/${objectGeneration}`;
  if (UTF8_ENCODER.encode(objectKey).byteLength > MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1) {
    throw new RangeError("Immutable object key exceeds the UTF-8 byte limit.");
  }
  return objectKey;
}

/** Validates that a persisted locator names exactly the expected generation. */
export function parseImmutableObjectLocatorV1(
  expectation: Omit<ImmutableObjectKeyInputV1, "objectGeneration">,
  value: unknown,
): ImmutableObjectLocatorV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable object locator is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const objectGeneration = immutableObjectGenerationV1(candidate.objectGeneration);
  const objectKey = immutableObjectKeyV1({ ...expectation, objectGeneration });
  if (candidate.objectKey !== objectKey) throw new TypeError("Immutable object locator is invalid.");
  return { objectGeneration, objectKey };
}

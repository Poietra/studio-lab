import { randomUUID } from "node:crypto";

import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1 = 1_024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_ADDRESSED_KEY_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const UTF8_ENCODER = new TextEncoder();

/**
 * Persisted locator for one immutable object. The `objectGeneration` field is
 * the legacy persisted spelling of the object locator token (ADR 0005, #715):
 * stored receipts, the `object_generation` column, the
 * `immutable_object_generation_v1` Postgres domain, and the `/g/{token}`
 * object-key suffix keep this spelling byte-for-byte until an explicit
 * versioned cutover. The value is a random locator token, never an ordered or
 * monotonic generation.
 */
export type ImmutableObjectLocatorV1 = Readonly<{
  objectGeneration: string;
  objectKey: string;
  versionId?: never;
}>;

/** Internal input for building an immutable object key; new surfaces name the random locator UUID `objectLocatorToken`. */
export type ImmutableObjectKeyInputV1 = Readonly<{
  contentAddressedKey: string;
  contentDigest: string;
  objectLocatorToken: string;
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

/**
 * Validates the random UUID that locates one immutable object. The value is a
 * locator nonce: ADR 0005 reserves `*Generation` for monotonic aggregate-head
 * CAS counters, so new code must never treat this token as ordered, monotonic,
 * or comparable.
 */
export function immutableObjectLocatorTokenV1(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError("Immutable object locator token is invalid.");
  }
  return value;
}

export function createImmutableObjectLocatorTokenV1() {
  return immutableObjectLocatorTokenV1(randomUUID());
}

/** @deprecated Legacy `generation` vocabulary for {@link immutableObjectLocatorTokenV1}; remove only through the explicit versioned cutover tracked by #715. */
export const immutableObjectGenerationV1 = immutableObjectLocatorTokenV1;

/** @deprecated Legacy `generation` vocabulary for {@link createImmutableObjectLocatorTokenV1}; remove only through the explicit versioned cutover tracked by #715. */
export const createImmutableObjectGenerationV1 = createImmutableObjectLocatorTokenV1;

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
 * Appends the application-owned locator token to a store-specific
 * content-addressed key. The `/g/{token}` suffix is a compatibility surface:
 * existing object keys remain byte-for-byte unchanged, and no copy or
 * re-upload is required for the #715 vocabulary migration. The persistence
 * adapter must enforce uniqueness with a conditional create and a database
 * constraint; this contract owns only the provider-neutral suffix.
 */
export function immutableObjectKeyV1(input: ImmutableObjectKeyInputV1) {
  const tenantId = tenantIdV1(input?.tenantId);
  const contentDigest = contentDigestV1(input?.contentDigest);
  const objectLocatorToken = immutableObjectLocatorTokenV1(input?.objectLocatorToken);
  const contentAddressedKey = contentAddressedKeyV1(tenantId, contentDigest, input?.contentAddressedKey);
  const objectKey = `${contentAddressedKey}/g/${objectLocatorToken}`;
  if (UTF8_ENCODER.encode(objectKey).byteLength > MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1) {
    throw new RangeError("Immutable object key exceeds the UTF-8 byte limit.");
  }
  return objectKey;
}

/**
 * Validates that a persisted locator names exactly the expected locator token.
 * The candidate and the returned locator keep the legacy `objectGeneration`
 * spelling because stored receipts pin it; content identity is unchanged.
 */
export function parseImmutableObjectLocatorV1(
  expectation: Omit<ImmutableObjectKeyInputV1, "objectLocatorToken">,
  value: unknown,
): ImmutableObjectLocatorV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Immutable object locator is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const objectLocatorToken = immutableObjectLocatorTokenV1(candidate.objectGeneration);
  const objectKey = immutableObjectKeyV1({ ...expectation, objectLocatorToken });
  if (candidate.objectKey !== objectKey) throw new TypeError("Immutable object locator is invalid.");
  return { objectGeneration: objectLocatorToken, objectKey };
}

import { immutableObjectGenerationV1 } from "./immutable-object-contract";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_PROVIDER_VERSION_ID_UTF8_BYTES_V1 = 1_024;

export type ProviderVersionedObjectLocatorV1 = Readonly<{
  objectGeneration?: never;
  versionId: string;
}>;

export type ApplicationImmutableObjectLocatorV1 = Readonly<{
  objectGeneration: string;
  versionId?: never;
}>;

export type StorageObjectLocatorV1 = ProviderVersionedObjectLocatorV1 | ApplicationImmutableObjectLocatorV1;

function providerVersionIdV1(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_VERSION_ID_UTF8_BYTES_V1
  ) {
    throw new TypeError("Provider object version ID is invalid.");
  }
  return value;
}

/** Parses the exclusive provider-version/application-generation discriminator. */
export function storageObjectLocatorV1(value: unknown): StorageObjectLocatorV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Storage object locator is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const hasVersionId = Object.hasOwn(candidate, "versionId");
  const hasObjectGeneration = Object.hasOwn(candidate, "objectGeneration");
  if (hasVersionId === hasObjectGeneration)
    throw new TypeError("Storage object locator must contain exactly one kind.");
  return hasVersionId
    ? { versionId: providerVersionIdV1(candidate.versionId) }
    : { objectGeneration: immutableObjectGenerationV1(candidate.objectGeneration) };
}

export function isApplicationImmutableLocatorV1(
  value: StorageObjectLocatorV1,
): value is ApplicationImmutableObjectLocatorV1 {
  return "objectGeneration" in value;
}

export function storageObjectLocatorColumnsV1(value: StorageObjectLocatorV1) {
  const locator = storageObjectLocatorV1(value);
  return isApplicationImmutableLocatorV1(locator)
    ? { objectGeneration: locator.objectGeneration, versionId: null }
    : { objectGeneration: null, versionId: locator.versionId };
}

export function sameStorageObjectLocatorV1(left: StorageObjectLocatorV1, right: StorageObjectLocatorV1) {
  const leftLocator = storageObjectLocatorColumnsV1(left);
  const rightLocator = storageObjectLocatorColumnsV1(right);
  return (
    leftLocator.versionId === rightLocator.versionId && leftLocator.objectGeneration === rightLocator.objectGeneration
  );
}

export function storageObjectLocatorIdentityV1(value: StorageObjectLocatorV1) {
  const locator = storageObjectLocatorV1(value);
  return isApplicationImmutableLocatorV1(locator)
    ? `generation:${locator.objectGeneration}`
    : `version:${locator.versionId}`;
}

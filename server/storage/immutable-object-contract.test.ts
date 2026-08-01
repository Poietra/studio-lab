import { describe, expect, it } from "vitest";

import {
  createImmutableObjectGenerationV1,
  immutableObjectGenerationV1,
  immutableObjectKeyV1,
  MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1,
  parseImmutableObjectLocatorV1,
} from "./immutable-object-contract";

const TENANT = "tenant-a";
const DIGEST = "a".repeat(64);
const GENERATION_A = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION_B = "123e4567-e89b-42d3-a456-426614174001";
const CONTENT_KEY = `tenants/${TENANT}/sources/${DIGEST}`;
const EXPECTATION = {
  contentAddressedKey: CONTENT_KEY,
  contentDigest: DIGEST,
  tenantId: TENANT,
} as const;

function input(overrides: Partial<Parameters<typeof immutableObjectKeyV1>[0]> = {}) {
  return {
    ...EXPECTATION,
    objectGeneration: GENERATION_A,
    ...overrides,
  };
}

describe("immutable object contract", () => {
  it("builds and parses the application-owned generation suffix", () => {
    const objectKey = immutableObjectKeyV1(input());
    expect(objectKey).toBe(`${CONTENT_KEY}/g/${GENERATION_A}`);
    expect(
      parseImmutableObjectLocatorV1(EXPECTATION, {
        ignoredReceiptField: true,
        objectGeneration: GENERATION_A,
        objectKey,
      }),
    ).toEqual({ objectGeneration: GENERATION_A, objectKey });
  });

  it("allocates a canonical UUID generation", () => {
    const generation = createImmutableObjectGenerationV1();
    expect(immutableObjectGenerationV1(generation)).toBe(generation);
  });

  it.each([
    null,
    "123E4567-E89B-42D3-A456-426614174000",
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567-e89b-42d3-a456-42661417400",
  ])("rejects a noncanonical object generation: %j", (objectGeneration) => {
    expect(() => immutableObjectGenerationV1(objectGeneration)).toThrow(/generation/i);
  });

  it.each([
    { contentAddressedKey: `tenants/tenant-b/sources/${DIGEST}` },
    { contentAddressedKey: `tenants/${TENANT}/sources/../${DIGEST}` },
    { contentAddressedKey: `tenants/${TENANT}//sources/${DIGEST}` },
    { contentAddressedKey: `tenants/${TENANT}/sources/${DIGEST}?copy=1` },
    { contentAddressedKey: `tenants/${TENANT}/sources/${DIGEST}/extra` },
    { contentDigest: "b".repeat(64) },
    { tenantId: "../tenant" },
  ])("rejects a noncanonical or mismatched content key: %j", (override) => {
    expect(() => immutableObjectKeyV1(input(override))).toThrow();
  });

  it("enforces the provider key limit in UTF-8 bytes", () => {
    const suffix = `/${DIGEST}/g/${GENERATION_A}`;
    const prefix = `tenants/${TENANT}/objects/`;
    const exactKey = `${prefix}${"x".repeat(MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1 - prefix.length - suffix.length)}${suffix}`;
    const exactContentKey = exactKey.slice(0, -`/g/${GENERATION_A}`.length);

    expect(immutableObjectKeyV1(input({ contentAddressedKey: exactContentKey }))).toHaveLength(
      MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1,
    );
    expect(() =>
      immutableObjectKeyV1(input({ contentAddressedKey: `${prefix}x${exactContentKey.slice(prefix.length)}` })),
    ).toThrow(/byte limit/i);
  });

  it("fails closed when a locator key and generation disagree", () => {
    expect(() =>
      parseImmutableObjectLocatorV1(EXPECTATION, {
        objectGeneration: GENERATION_B,
        objectKey: immutableObjectKeyV1(input()),
      }),
    ).toThrow(/locator/i);
    expect(() => parseImmutableObjectLocatorV1(EXPECTATION, null)).toThrow(/locator/i);
  });
});

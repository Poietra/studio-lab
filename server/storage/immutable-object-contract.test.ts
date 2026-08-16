import { describe, expect, it } from "vitest";

import {
  createImmutableObjectGenerationV1,
  createImmutableObjectLocatorTokenV1,
  immutableObjectGenerationV1,
  immutableObjectKeyV1,
  immutableObjectLocatorTokenV1,
  MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1,
  parseImmutableObjectLocatorV1,
} from "./immutable-object-contract";

const TENANT = "tenant-a";
const DIGEST = "a".repeat(64);
const LOCATOR_TOKEN_A = "123e4567-e89b-42d3-a456-426614174000";
const LOCATOR_TOKEN_B = "123e4567-e89b-42d3-a456-426614174001";
const CONTENT_KEY = `tenants/${TENANT}/sources/${DIGEST}`;
const EXPECTATION = {
  contentAddressedKey: CONTENT_KEY,
  contentDigest: DIGEST,
  tenantId: TENANT,
} as const;

function input(overrides: Partial<Parameters<typeof immutableObjectKeyV1>[0]> = {}) {
  return {
    ...EXPECTATION,
    objectLocatorToken: LOCATOR_TOKEN_A,
    ...overrides,
  };
}

describe("immutable object contract", () => {
  it("builds and parses the application-owned locator-token suffix", () => {
    const objectKey = immutableObjectKeyV1(input());
    expect(objectKey).toBe(`${CONTENT_KEY}/g/${LOCATOR_TOKEN_A}`);
    expect(
      parseImmutableObjectLocatorV1(EXPECTATION, {
        ignoredReceiptField: true,
        objectGeneration: LOCATOR_TOKEN_A,
        objectKey,
      }),
    ).toEqual({ objectGeneration: LOCATOR_TOKEN_A, objectKey });
  });

  it("allocates a canonical UUID locator token", () => {
    const objectLocatorToken = createImmutableObjectLocatorTokenV1();
    expect(immutableObjectLocatorTokenV1(objectLocatorToken)).toBe(objectLocatorToken);
  });

  it("keeps the legacy generation-named aliases interoperable with the locator-token vocabulary", () => {
    expect(immutableObjectGenerationV1).toBe(immutableObjectLocatorTokenV1);
    expect(createImmutableObjectGenerationV1).toBe(createImmutableObjectLocatorTokenV1);

    const legacyAllocated = createImmutableObjectGenerationV1();
    const objectKey = immutableObjectKeyV1(input({ objectLocatorToken: legacyAllocated }));
    expect(objectKey).toBe(`${CONTENT_KEY}/g/${legacyAllocated}`);
    expect(parseImmutableObjectLocatorV1(EXPECTATION, { objectGeneration: legacyAllocated, objectKey })).toEqual({
      objectGeneration: legacyAllocated,
      objectKey,
    });
  });

  it.each([
    null,
    "123E4567-E89B-42D3-A456-426614174000",
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567-e89b-42d3-a456-42661417400",
  ])("rejects a noncanonical object locator token: %j", (objectLocatorToken) => {
    expect(() => immutableObjectLocatorTokenV1(objectLocatorToken)).toThrow(/locator token/i);
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
    const suffix = `/${DIGEST}/g/${LOCATOR_TOKEN_A}`;
    const prefix = `tenants/${TENANT}/objects/`;
    const exactKey = `${prefix}${"x".repeat(MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1 - prefix.length - suffix.length)}${suffix}`;
    const exactContentKey = exactKey.slice(0, -`/g/${LOCATOR_TOKEN_A}`.length);

    expect(immutableObjectKeyV1(input({ contentAddressedKey: exactContentKey }))).toHaveLength(
      MAX_IMMUTABLE_OBJECT_KEY_UTF8_BYTES_V1,
    );
    expect(() =>
      immutableObjectKeyV1(input({ contentAddressedKey: `${prefix}x${exactContentKey.slice(prefix.length)}` })),
    ).toThrow(/byte limit/i);
  });

  it("fails closed when a locator key and token disagree", () => {
    expect(() =>
      parseImmutableObjectLocatorV1(EXPECTATION, {
        objectGeneration: LOCATOR_TOKEN_B,
        objectKey: immutableObjectKeyV1(input()),
      }),
    ).toThrow(/locator/i);
    expect(() => parseImmutableObjectLocatorV1(EXPECTATION, null)).toThrow(/locator/i);
  });
});

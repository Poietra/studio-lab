import { describe, expect, it } from "vitest";

import {
  immutableProjectPngObjectKeyV1,
  immutableSourceBlobObjectKeyV1,
  parseImmutableProjectPngObjectKeyV1,
  parseImmutableProjectPngReceiptV1,
  parseImmutableRenderInputLocatorV1,
  parseImmutableSourceBlobObjectKeyV1,
  parseImmutableSourceBlobReceiptV1,
  sourceBlobContentAddressedKeyV1,
} from "./immutable-source-png-storage";
import { projectPngObjectKeyV1 } from "./project-png-storage";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const DIGEST = "a".repeat(64);
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_KEY = `tenants/${TENANT}/sources/${DIGEST}/g/${GENERATION}`;
const PNG_KEY = `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${DIGEST}/g/${GENERATION}`;

function sourceReceipt(overrides: Record<string, unknown> = {}) {
  return {
    byteSize: 12,
    digest: DIGEST,
    etag: '"etag-a"',
    objectGeneration: GENERATION,
    objectKey: SOURCE_KEY,
    ...overrides,
  };
}

function pngReceipt(overrides: Record<string, unknown> = {}) {
  return {
    byteSize: 67,
    digest: DIGEST,
    etag: '"etag-a"',
    objectGeneration: GENERATION,
    objectKey: PNG_KEY,
    ...overrides,
  };
}

describe("immutable source and project PNG storage contracts", () => {
  it("uses the content-addressed builders as the only prefix before the application generation", () => {
    expect(sourceBlobContentAddressedKeyV1(TENANT, DIGEST)).toBe(`tenants/${TENANT}/sources/${DIGEST}`);
    expect(immutableSourceBlobObjectKeyV1(TENANT, DIGEST, GENERATION)).toBe(SOURCE_KEY);
    expect(immutableProjectPngObjectKeyV1(TENANT, PROJECT, DIGEST, GENERATION)).toBe(
      `${projectPngObjectKeyV1(TENANT, PROJECT, DIGEST)}/g/${GENERATION}`,
    );
    expect(parseImmutableSourceBlobObjectKeyV1(TENANT, SOURCE_KEY)).toEqual({
      digest: DIGEST,
      objectKey: SOURCE_KEY,
      objectLocatorToken: GENERATION,
    });
    expect(parseImmutableProjectPngObjectKeyV1(TENANT, PNG_KEY)).toEqual({
      digest: DIGEST,
      objectKey: PNG_KEY,
      objectLocatorToken: GENERATION,
      projectId: PROJECT,
    });

    const laterGeneration = "223e4567-e89b-42d3-a456-426614174000";
    expect(immutableSourceBlobObjectKeyV1(TENANT, DIGEST, laterGeneration)).not.toBe(SOURCE_KEY);
    expect(immutableProjectPngObjectKeyV1(TENANT, PROJECT, DIGEST, laterGeneration)).not.toBe(PNG_KEY);
  });

  it("normalizes closed receipts without a provider version identifier", () => {
    expect(parseImmutableSourceBlobReceiptV1(TENANT, sourceReceipt())).toEqual(sourceReceipt());
    expect(parseImmutableProjectPngReceiptV1(TENANT, PROJECT, pngReceipt())).toEqual(pngReceipt());

    expect(() => parseImmutableSourceBlobReceiptV1(TENANT, sourceReceipt({ providerVersion: "v1" }))).toThrow(
      /receipt/i,
    );
    expect(() => parseImmutableProjectPngReceiptV1(TENANT, PROJECT, pngReceipt({ providerVersion: "v1" }))).toThrow(
      /receipt/i,
    );
  });

  it.each([
    ["foreign tenant", "tenant-b", sourceReceipt()],
    ["wrong digest", TENANT, sourceReceipt({ digest: "b".repeat(64) })],
    ["wrong generation", TENANT, sourceReceipt({ objectGeneration: "223e4567-e89b-42d3-a456-426614174000" })],
    ["wrong object key", TENANT, sourceReceipt({ objectKey: `${SOURCE_KEY}x` })],
    ["invalid ETag", TENANT, sourceReceipt({ etag: "bad\netag" })],
  ])("rejects a %s source locator before storage I/O", (_label, tenant, value) => {
    expect(() => parseImmutableSourceBlobReceiptV1(tenant, value)).toThrow();
  });

  it("binds project PNG receipts to both tenant and project", () => {
    expect(() => parseImmutableProjectPngReceiptV1("tenant-b", PROJECT, pngReceipt())).toThrow(/locator/i);
    expect(() => parseImmutableProjectPngReceiptV1(TENANT, "project-b", pngReceipt())).toThrow(/locator/i);
    expect(() => parseImmutableProjectPngObjectKeyV1(TENANT, SOURCE_KEY)).toThrow(/image\.png/i);
  });

  it("provides a strict provider-neutral render input pin for the later session migration", () => {
    expect(parseImmutableRenderInputLocatorV1(TENANT, { kind: "source-blob", receipt: sourceReceipt() })).toEqual({
      kind: "source-blob",
      receipt: sourceReceipt(),
    });
    expect(
      parseImmutableRenderInputLocatorV1(TENANT, {
        kind: "project-png",
        projectId: PROJECT,
        receipt: pngReceipt(),
      }),
    ).toEqual({ kind: "project-png", projectId: PROJECT, receipt: pngReceipt() });

    expect(() =>
      parseImmutableRenderInputLocatorV1(TENANT, {
        kind: "source-blob",
        receipt: sourceReceipt(),
        tenantId: TENANT,
      }),
    ).toThrow(/locator/i);
    expect(() =>
      parseImmutableRenderInputLocatorV1(TENANT, {
        kind: "project-png",
        projectId: "project-b",
        receipt: pngReceipt(),
      }),
    ).toThrow(/locator/i);
  });
});

import { describe, expect, it } from "vitest";

import {
  normalizeCombinedOrganizationSelectorHeaderV1,
  normalizeOrganizationSelectorHeaderV1,
  ORGANIZATION_SELECTOR_HEADER_V1,
} from "./organization-selector-header";

const CONFLICTING = Object.freeze({ kind: "conflicting" });

describe("organization selector header normalization", () => {
  it("names the one shared wire header", () => {
    expect(ORGANIZATION_SELECTOR_HEADER_V1).toBe("x-poietra-organization-id");
  });

  it("treats a missing header as an absent selector on both transports", () => {
    expect(normalizeOrganizationSelectorHeaderV1(undefined)).toEqual({ kind: "absent" });
    expect(normalizeOrganizationSelectorHeaderV1([])).toEqual({ kind: "absent" });
    expect(normalizeCombinedOrganizationSelectorHeaderV1(null)).toEqual({ kind: "absent" });
  });

  it("forwards exactly one selector value untouched without judging its bytes", () => {
    expect(normalizeOrganizationSelectorHeaderV1(["tenant-a"])).toEqual({
      kind: "selected",
      requestedOrganizationId: "tenant-a",
    });
    expect(normalizeCombinedOrganizationSelectorHeaderV1("tenant-a")).toEqual({
      kind: "selected",
      requestedOrganizationId: "tenant-a",
    });
    const malformed = "A".repeat(65);
    expect(normalizeOrganizationSelectorHeaderV1([malformed])).toEqual({
      kind: "selected",
      requestedOrganizationId: malformed,
    });
    expect(normalizeCombinedOrganizationSelectorHeaderV1("")).toEqual({
      kind: "selected",
      requestedOrganizationId: "",
    });
  });

  it("reports conflicting selector values so each transport keeps its own wire rejection", () => {
    expect(normalizeOrganizationSelectorHeaderV1(["tenant-a", "tenant-b"])).toEqual(CONFLICTING);
    expect(normalizeOrganizationSelectorHeaderV1(["tenant-a", "tenant-a"])).toEqual(CONFLICTING);
  });

  it("treats a comma-joined Fetch header value as conflicting selector values", () => {
    expect(normalizeCombinedOrganizationSelectorHeaderV1("tenant-a, tenant-b")).toEqual(CONFLICTING);
    expect(normalizeCombinedOrganizationSelectorHeaderV1("tenant-a,tenant-b")).toEqual(CONFLICTING);
  });
});

import { describe, expect, it } from "vitest";

import {
  FastManimRuncRootlessIdentityMapV1,
  isFastManimRuncRootlessIdentityMapV1,
} from "./fast-manim-runc-rootless-identity";

function identity(overrides: Readonly<Record<string, unknown>> = {}) {
  return new FastManimRuncRootlessIdentityMapV1({
    allowedGidRanges: [
      { size: 1, start: 1000 },
      { size: 65_536, start: 200_000 },
    ],
    allowedUidRanges: [
      { size: 1, start: 1000 },
      { size: 65_536, start: 100_000 },
    ],
    gidMappings: [
      { containerID: 0, hostID: 1000, size: 1 },
      { containerID: 1, hostID: 200_000, size: 65_532 },
    ],
    uidMappings: [
      { containerID: 0, hostID: 1000, size: 1 },
      { containerID: 1, hostID: 100_000, size: 65_532 },
    ],
    ...overrides,
  });
}

describe("FastManimRuncRootlessIdentityMapV1", () => {
  it("copies one canonical 0..65532 mapping and resolves mapped container root", () => {
    const contract = identity();
    expect(contract.hostRootIdentity()).toEqual({ gid: 1000, uid: 1000 });
    expect(contract.ociMappings()).toEqual({
      gidMappings: [
        { containerID: 0, hostID: 1000, size: 1 },
        { containerID: 1, hostID: 200_000, size: 65_532 },
      ],
      uidMappings: [
        { containerID: 0, hostID: 1000, size: 1 },
        { containerID: 1, hostID: 100_000, size: 65_532 },
      ],
    });
    expect(Object.isFrozen(contract.ociMappings().uidMappings)).toBe(true);
    expect(isFastManimRuncRootlessIdentityMapV1(contract)).toBe(true);
    class OverriddenIdentity extends FastManimRuncRootlessIdentityMapV1 {}
    expect(
      isFastManimRuncRootlessIdentityMapV1(
        new OverriddenIdentity({
          allowedGidRanges: [{ size: 65_533, start: 200_000 }],
          allowedUidRanges: [{ size: 65_533, start: 100_000 }],
          gidMappings: [{ containerID: 0, hostID: 200_000, size: 65_533 }],
          uidMappings: [{ containerID: 0, hostID: 100_000, size: 65_533 }],
        }),
      ),
    ).toBe(false);
  });

  it.each([
    { uidMappings: [{ containerID: 1, hostID: 100_000, size: 65_533 }] },
    { uidMappings: [{ containerID: 0, hostID: 100_000, size: 65_532 }] },
    {
      uidMappings: [
        { containerID: 0, hostID: 1000, size: 1 },
        { containerID: 2, hostID: 100_000, size: 65_532 },
      ],
    },
    {
      uidMappings: [
        { containerID: 0, hostID: 1000, size: 1 },
        { containerID: 1, hostID: 1000, size: 65_532 },
      ],
    },
    { uidMappings: [{ containerID: 0, hostID: 300_000, size: 65_533 }] },
  ])("rejects incomplete, overlapping, or unallowlisted mappings", (overrides) => {
    expect(() => identity(overrides)).toThrow(/mapping|range|cover/i);
  });

  it("rejects non-canonical host allowlists", () => {
    expect(() =>
      identity({
        allowedUidRanges: [
          { size: 65_536, start: 100_000 },
          { size: 1, start: 1000 },
        ],
      }),
    ).toThrow(/sorted/i);
    expect(() =>
      identity({
        allowedUidRanges: [
          { size: 1, start: 1000 },
          { size: 1, start: 1001 },
          { size: 65_536, start: 100_000 },
        ],
      }),
    ).toThrow(/merge adjacent/i);
  });
});

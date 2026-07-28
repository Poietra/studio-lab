import { describe, expect, it } from "vitest";

import { FastManimRuncRootlessIdentityMapV1 } from "./fast-manim-runc-rootless-identity";
import { assertFastManimRuncSubordinateIdCoverageV1 } from "./fast-manim-runc-subordinate-ids";

const identityMap = new FastManimRuncRootlessIdentityMapV1({
  allowedGidRanges: [
    { size: 1, start: 1_000 },
    { size: 65_532, start: 200_000 },
  ],
  allowedUidRanges: [
    { size: 1, start: 1_000 },
    { size: 65_532, start: 100_000 },
  ],
  gidMappings: [
    { containerID: 0, hostID: 1_000, size: 1 },
    { containerID: 1, hostID: 200_000, size: 65_532 },
  ],
  uidMappings: [
    { containerID: 0, hostID: 1_000, size: 1 },
    { containerID: 1, hostID: 100_000, size: 65_532 },
  ],
});
const service = Object.freeze({ gid: 1_000, uid: 1_000, username: "studio" });

describe("runc subordinate-ID readiness", () => {
  it("accepts merged name and numeric-UID ranges while exempting the service identity", () => {
    expect(() =>
      assertFastManimRuncSubordinateIdCoverageV1(identityMap, service, {
        subgid: "studio:200000:65532\n",
        subuid: "unrelated:1:not-a-number\nstudio:100000:30000\n1000:130000:35532\n",
      }),
    ).not.toThrow();
  });

  it.each([
    ["UID", { subgid: "studio:200000:65532\n", subuid: "studio:100000:65531\n" }],
    ["GID", { subgid: "studio:200001:65531\n", subuid: "studio:100000:65532\n" }],
  ])("rejects an uncovered %s mapping", (label, files) => {
    expect(() => assertFastManimRuncSubordinateIdCoverageV1(identityMap, service, files)).toThrow(
      `configured ${label} mappings exceed`,
    );
  });

  it("rejects a malformed entry belonging to the service", () => {
    expect(() =>
      assertFastManimRuncSubordinateIdCoverageV1(identityMap, service, {
        subgid: "studio:200000:65532\n",
        subuid: "studio:100000:nope\n",
      }),
    ).toThrow("/etc/subuid entry on line 1 is malformed");
  });
});

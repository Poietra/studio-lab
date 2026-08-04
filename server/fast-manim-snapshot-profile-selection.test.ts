import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  createFastManimSnapshotProfileSelectionPolicyV1,
  createFastManimSnapshotProfileSelectionRequestV1,
  createFastManimSnapshotSelectedProfileDigestV1,
  digestFastManimSnapshotProfileSelectionPolicyV1,
  type FastManimSnapshotProfileSelectionRequestV1,
  fastManimSnapshotProfileCandidateV1,
  fastManimSnapshotProfileSelectionPolicyV1Schema,
  parseFastManimSnapshotProfileSelectionResultV1,
} from "./fast-manim-snapshot-profile-selection";

const FRAME = { height: 8, width: 14.222222222222221 } as const;
const SOURCE = `from manim import BLUE, GREEN, Line, Rectangle, Scene


class StaticShapes(Scene):
    def construct(self):
        rectangle = Rectangle(width=2.5, height=1.5).set_fill(BLUE, opacity=1.0)
        rectangle.set_stroke(width=0)
        rectangle.set_z_index(1)
        line = Line([-2.0, -1.0, 0.0], [2.0, 1.5, 0.0], color=GREEN)
        self.add(rectangle, line)
`;

function request(
  policy = createFastManimSnapshotProfileSelectionPolicyV1(FRAME, { pngAvailable: true }),
): FastManimSnapshotProfileSelectionRequestV1 {
  return createFastManimSnapshotProfileSelectionRequestV1({
    policy,
    projectId: "demo",
    requestId: "req-1",
    sceneId: "scene:6853803802e7b0ef72bc89adfdebac9f42c294b60c5bff6b70588a8f2987e2b4",
    sceneName: "StaticShapes",
    sourceHash: createHash("sha256").update(SOURCE, "utf8").digest("hex"),
    sourcePath: "scenes/demo.py",
    sourceText: SOURCE,
  });
}

function selectedResult(
  selectionRequest: FastManimSnapshotProfileSelectionRequestV1,
  selected = selectionRequest.policy.candidates[0]!,
  producerDocumentBytes = Buffer.from(canonicalJsonV1({ kind: "fake-producer-document" }), "utf8"),
) {
  return {
    kind: "selected" as const,
    policyHash: selectionRequest.policyHash,
    producerDocumentBase64: producerDocumentBytes.toString("base64"),
    producerDocumentDigest: createHash("sha256").update(producerDocumentBytes).digest("hex"),
    projectId: selectionRequest.projectId,
    requestId: selectionRequest.requestId,
    sceneId: selectionRequest.sceneId,
    sceneName: selectionRequest.sceneName,
    schema: "poietra.fast-manim-snapshot-profile-selection-result" as const,
    selected: {
      runtimeConfigHash: selected.runtimeConfigHash,
      snapshotVersion: selected.snapshotVersion,
    },
    selectionDigest: createFastManimSnapshotSelectedProfileDigestV1(selectionRequest, selected),
    sourceHash: selectionRequest.sourceHash,
    sourcePath: selectionRequest.sourcePath,
    version: 1 as const,
  };
}

function canonicalBytes(value: unknown) {
  return Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8");
}

describe("fast-manim producer-owned profile selection", () => {
  it("offers V1-V10 in canonical order and keeps the cross-runtime identities fixed", () => {
    const selectionRequest = request();
    const selected = selectionRequest.policy.candidates[0]!;

    expect(selectionRequest.policy.candidates.map(({ snapshotVersion }) => snapshotVersion)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(selectionRequest.policy.candidates.at(-1)).toMatchObject({
      runtimeConfig: {
        capabilities: ["cubic-path-geometry", "logical-group", "shape-primitives"],
        frame: FRAME,
        randomSeed: 0,
        snapshotVersion: 10,
      },
      runtimeConfigHash: "b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec",
      snapshotVersion: 10,
    });
    expect(selectionRequest.sourceHash).toBe("fca8ddecffa4a37ca4f97e7a9de9f6d3c9935b3e95d866bd41a1b67e9f91ad03");
    expect(selectionRequest.policyHash).toBe("2df57c0e268fea952d80e941ddef0919286ba1aee6f9aa3a7378188250fc356b");
    expect(selected.runtimeConfigHash).toBe("5eb22569bc257af3a71b87e62fdb23c070c8204ac4aa27ad684d8bff9b7b5a7a");
    expect(createFastManimSnapshotSelectedProfileDigestV1(selectionRequest, selected)).toBe(
      "a6ab1ecb55a5dd3903ed961047d622efcda05e63b24afc6060c1dabd5c00a8e1",
    );
  });

  it("omits unavailable PNG and frame-specific profiles without hiding invalid base frames", () => {
    expect(
      createFastManimSnapshotProfileSelectionPolicyV1(FRAME, { pngAvailable: false }).candidates.map(
        ({ snapshotVersion }) => snapshotVersion,
      ),
    ).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    expect(
      createFastManimSnapshotProfileSelectionPolicyV1({ height: 9, width: 16 }, { pngAvailable: true }).candidates.map(
        ({ snapshotVersion }) => snapshotVersion,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(() =>
      createFastManimSnapshotProfileSelectionPolicyV1({ height: 0, width: 16 }, { pngAvailable: false }),
    ).toThrow();
  });

  it("accepts one canonical correlated selected result", () => {
    const selectionRequest = request();
    const result = selectedResult(selectionRequest);
    const parsed = parseFastManimSnapshotProfileSelectionResultV1(canonicalBytes(result), selectionRequest);

    expect(parsed).toMatchObject({ ...result, selected: selectionRequest.policy.candidates[0] });
    if (parsed.kind !== "selected") throw new Error("Expected one selected profile.");
    expect(Buffer.from(parsed.producerDocumentBytes)).toEqual(
      Buffer.from(canonicalJsonV1({ kind: "fake-producer-document" }), "utf8"),
    );
  });

  it("accepts one canonical unresolved result without inventing a concrete profile", () => {
    const selectionRequest = request();
    const result = {
      kind: "unresolved" as const,
      policyHash: selectionRequest.policyHash,
      projectId: selectionRequest.projectId,
      reason: "unsupported" as const,
      requestId: selectionRequest.requestId,
      sceneId: selectionRequest.sceneId,
      sceneName: selectionRequest.sceneName,
      schema: "poietra.fast-manim-snapshot-profile-selection-result" as const,
      sourceHash: selectionRequest.sourceHash,
      sourcePath: selectionRequest.sourcePath,
      version: 1 as const,
    };

    expect(parseFastManimSnapshotProfileSelectionResultV1(canonicalBytes(result), selectionRequest)).toEqual(result);
  });

  it("rejects noncanonical, stale, unoffered, and digest-drifted selections", () => {
    const selectionRequest = request();
    const result = selectedResult(selectionRequest);
    expect(() =>
      parseFastManimSnapshotProfileSelectionResultV1(Buffer.from(JSON.stringify(result, null, 2)), selectionRequest),
    ).toThrow(/canonical/i);
    expect(() =>
      parseFastManimSnapshotProfileSelectionResultV1(
        canonicalBytes({ ...result, requestId: "another-request" }),
        selectionRequest,
      ),
    ).toThrow(/different request or source/i);
    expect(() =>
      parseFastManimSnapshotProfileSelectionResultV1(
        canonicalBytes({ ...result, selectionDigest: "f".repeat(64) }),
        selectionRequest,
      ),
    ).toThrow(/deterministic digest/i);
    expect(() =>
      parseFastManimSnapshotProfileSelectionResultV1(
        canonicalBytes({ ...result, producerDocumentDigest: "f".repeat(64) }),
        selectionRequest,
      ),
    ).toThrow(/producer document bytes/i);

    const restrictedPolicy = fastManimSnapshotProfileSelectionPolicyV1Schema.parse({
      ...selectionRequest.policy,
      candidates: selectionRequest.policy.candidates.slice(0, 1),
    });
    const restrictedRequest = request(restrictedPolicy);
    const unoffered = fastManimSnapshotProfileCandidateV1(9, FRAME);
    expect(() =>
      parseFastManimSnapshotProfileSelectionResultV1(
        canonicalBytes(selectedResult(restrictedRequest, unoffered)),
        restrictedRequest,
      ),
    ).toThrow(/did not offer/i);
  });

  it("binds candidate ordering and exact runtime configuration into the policy digest", () => {
    const policy = request().policy;
    expect(() =>
      fastManimSnapshotProfileSelectionPolicyV1Schema.parse({
        ...policy,
        candidates: [...policy.candidates].reverse(),
      }),
    ).toThrow(/sorted/i);
    expect(digestFastManimSnapshotProfileSelectionPolicyV1(policy)).not.toBe(
      digestFastManimSnapshotProfileSelectionPolicyV1({ ...policy, candidates: policy.candidates.slice(0, -1) }),
    );
  });

  it.each([
    [{ height: 1e-7, width: 1e20 }, "ac3a595c8e534d7c4b9e771b820e85e13f1551d5721cecde5c04a7173aea62f1"],
    [{ height: 1e20, width: 1e-7 }, "0f205aef389c63f1329b799f9079c9e340caa182a1f669e4289e9050f212dbd1"],
  ] as const)("keeps policy and selected bytes cross-runtime stable for frame %o", (frame, expectedPolicyHash) => {
    const policy = createFastManimSnapshotProfileSelectionPolicyV1(frame, { pngAvailable: false });
    expect(policy.candidates.map(({ snapshotVersion }) => snapshotVersion)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(digestFastManimSnapshotProfileSelectionPolicyV1(policy)).toBe(expectedPolicyHash);

    const selectionRequest = request(policy);
    const pythonCanonicalBytes = Buffer.from('{"kind":"float-regression","value":1e-07}', "utf8");
    const parsed = parseFastManimSnapshotProfileSelectionResultV1(
      canonicalBytes(selectedResult(selectionRequest, policy.candidates[0]!, pythonCanonicalBytes)),
      selectionRequest,
    );
    if (parsed.kind !== "selected") throw new Error("Expected one selected profile.");
    expect(Buffer.from(parsed.producerDocumentBytes)).toEqual(pythonCanonicalBytes);
  });
});

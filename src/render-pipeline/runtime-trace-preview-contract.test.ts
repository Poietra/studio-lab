import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_RUNTIME_TRACE_RUN_RESPONSE_ENVELOPE_BYTES_V2,
  FAST_MANIM_RUNTIME_TRACE_RUN_SCHEMA_V1,
  fastManimRuntimeTraceRunViewSchema,
  fastManimRuntimeTraceRunViewV1Schema,
  fastManimRuntimeTraceRunViewV2Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_RUN_ROOTS_V2,
} from "./runtime-trace-preview-contract";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "./runtime-trace-v3-shared-contract";

const SHA256 = "a".repeat(64);
const SCENE_ID = `scene:${"b".repeat(64)}`;

function endpoint(frameIndex: number) {
  return {
    center: { x: -1_000_000_000, y: 1_000_000_000 },
    dimensions: { height: 1_000_000_000, width: 1_000_000_000 },
    frameIndex,
    sampleTime: canonicalFastManimRuntimeTraceSampleTimeV3(frameIndex),
  };
}

function root(index: number) {
  const suffix = index.toString(16).padStart(64, "0");
  return {
    binding: {
      id: `source-binding:${suffix}`,
      name: "界".repeat(80),
      ordinal: index + 1,
      span: { endColumn: 2_000_000, endLine: 10_000, startColumn: 1_999_999, startLine: 10_000 },
    },
    entityId: `root:${"e".repeat(234)}${index.toString(16).padStart(1, "0")}`.slice(0, 240),
    evidence: {
      endpoints: { initial: endpoint(0), terminal: endpoint(899) },
      updaterStatus: index % 2 === 0 ? ("none" as const) : ("conflict" as const),
    },
  };
}

function viewV2(rootCount = MAX_FAST_MANIM_RUNTIME_TRACE_RUN_ROOTS_V2) {
  return {
    bundle: {},
    producerEvidence: { correlationSha256: SHA256, semanticsSha256: SHA256 },
    projectId: "project",
    requestId: "request",
    roots: Array.from({ length: rootCount }, (_, index) => root(index)),
    runtimeConfigHash: SHA256,
    sceneId: SCENE_ID,
    sceneName: "Scene",
    schema: FAST_MANIM_RUNTIME_TRACE_RUN_SCHEMA_V1,
    sourceHash: SHA256,
    sourcePath: "scene.py",
    status: "verified",
    traceDigest: SHA256,
    version: 2,
  } as const;
}

describe("Runtime Trace preview wire contract", () => {
  it("accepts the maximum closed V2 authority envelope below the shared byte ceiling", () => {
    const value = viewV2();
    expect(fastManimRuntimeTraceRunViewV2Schema.parse(value)).toEqual(value);
    expect(fastManimRuntimeTraceRunViewSchema.parse(value)).toEqual(value);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(
      FAST_MANIM_RUNTIME_TRACE_RUN_RESPONSE_ENVELOPE_BYTES_V2,
    );
  });

  it("keeps pure V2 and version-aware schemas distinct without widening V1", () => {
    const failureV1 = {
      failure: { code: "result-rejected", message: "Rejected." },
      projectId: "project",
      requestId: "request",
      runtimeConfigHash: SHA256,
      sceneId: SCENE_ID,
      sceneName: "Scene",
      schema: FAST_MANIM_RUNTIME_TRACE_RUN_SCHEMA_V1,
      sourceHash: SHA256,
      sourcePath: "scene.py",
      status: "failed",
      version: 1,
    } as const;

    expect(fastManimRuntimeTraceRunViewV1Schema.parse(failureV1)).toEqual(failureV1);
    expect(fastManimRuntimeTraceRunViewSchema.parse(failureV1)).toEqual(failureV1);
    expect(fastManimRuntimeTraceRunViewV2Schema.safeParse(failureV1).success).toBe(false);
    expect(fastManimRuntimeTraceRunViewV1Schema.safeParse(viewV2(1)).success).toBe(false);
  });

  it("rejects oversized, widened, and non-canonical V2 roots", () => {
    expect(fastManimRuntimeTraceRunViewV2Schema.safeParse(viewV2(129)).success).toBe(false);

    const widened = structuredClone(viewV2(1));
    Object.assign(widened.roots[0]!.evidence, { authority: "edit" });
    expect(fastManimRuntimeTraceRunViewV2Schema.safeParse(widened).success).toBe(false);

    const nonCanonical = structuredClone(viewV2(1));
    nonCanonical.roots[0]!.binding.name = "Å";
    expect(fastManimRuntimeTraceRunViewV2Schema.safeParse(nonCanonical).success).toBe(false);
  });
});

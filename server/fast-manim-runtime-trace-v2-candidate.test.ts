import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2,
  type FastManimRuntimeTraceCandidateErrorV2,
  verifyFastManimRuntimeTraceOpeningPositionCandidateV2,
} from "./fast-manim-runtime-trace-v2-candidate";
import { createFastManimRuntimeTraceCandidateProducerRequestV2 } from "./fast-manim-runtime-trace-v2-profile";
import {
  canonicalFastManimRuntimeTraceCoordinateV2,
  digestFastManimRuntimeTraceVisualSemanticsV2,
  type FastManimRuntimeTraceV2,
} from "./fast-manim-runtime-trace-v2-result-contract";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";
import {
  fastManimRuntimeTraceV2Fixture,
  RUNTIME_TRACE_V2_GRID_TITLE_ROOT,
} from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";

const finalWaitBoundary = "        self.play(Transform(grid_title, grid_transform_title))\n        self.wait()\n";
const candidateSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
  finalWaitBoundary,
  "        self.play(Transform(grid_title, grid_transform_title))\n" +
    "        grid_title.shift((1.25, -0.5, 0))\n" +
    "        self.wait()\n",
);

function candidateRequest(source = candidateSource) {
  const base = fastManimRuntimeTraceV2Fixture();
  return createFastManimRuntimeTraceCandidateProducerRequestV2(
    {
      projectId: base.projectId,
      requestId: base.requestId,
      sceneName: base.sceneName,
      sourceHash: createHash("sha256").update(source, "utf8").digest("hex"),
      sourcePath: base.sourcePath,
    },
    source,
    { height: 8, width: 128 / 9 },
  );
}

function candidateFixture() {
  const trace: FastManimRuntimeTraceV2 = structuredClone(fastManimRuntimeTraceV2Fixture());
  const request = candidateRequest();
  Object.assign(trace, {
    projectId: request.projectId,
    requestId: request.requestId,
    runtimeConfigHash: request.runtimeConfigHash,
    sceneId: request.sceneId,
    sceneName: request.sceneName,
    sceneOccurrence: request.sceneOccurrence,
    sourceHash: request.sourceHash,
    sourcePath: request.sourcePath,
  });
  trace.roots.forEach((root) => {
    root.binding.id = fastManimSourceBindingIdentifierV1(trace.sourceHash, trace.sceneId, root.binding);
  });
  for (const frame of trace.frames.slice(FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2)) {
    for (const draw of frame.draws) {
      if (draw.rootId !== RUNTIME_TRACE_V2_GRID_TITLE_ROOT) continue;
      draw.translation.x = canonicalFastManimRuntimeTraceCoordinateV2(draw.translation.x + 1.25);
      draw.translation.y = canonicalFastManimRuntimeTraceCoordinateV2(draw.translation.y - 0.5);
    }
  }
  trace.producer.semanticsSha256 = digestFastManimRuntimeTraceVisualSemanticsV2(trace);
  return { request, trace };
}

function verify(trace: FastManimRuntimeTraceV2, request = candidateRequest()) {
  const base = fastManimRuntimeTraceV2Fixture();
  return verifyFastManimRuntimeTraceOpeningPositionCandidateV2({
    base,
    candidate: trace,
    candidateRequest: request,
    trusted: { producer: base.producer, roots: base.roots },
  });
}

function expectCandidateError(trace: FastManimRuntimeTraceV2, code: FastManimRuntimeTraceCandidateErrorV2["code"]) {
  trace.producer.semanticsSha256 = digestFastManimRuntimeTraceVisualSemanticsV2(trace);
  expect(() => verify(trace)).toThrowError(
    expect.objectContaining<Partial<FastManimRuntimeTraceCandidateErrorV2>>({ code }),
  );
}

describe("fast-manim Runtime Trace V2 OpeningManim position candidate", () => {
  it("accepts an unchanged 0–839 prefix and one source-matched grid_title translation in frames 840–899", () => {
    const { request, trace } = candidateFixture();
    expect(verify(trace, request)).toEqual(trace);
    expect(trace.frames.slice(0, FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2)).toEqual(
      fastManimRuntimeTraceV2Fixture().frames.slice(0, FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2),
    );
  }, 30_000);

  it("rejects any change before the t=14 frame boundary", () => {
    const { trace } = candidateFixture();
    trace.frames[839]!.draws.at(-1)!.translation.x = 0.125;
    expectCandidateError(trace, "candidate-prefix");
  }, 30_000);

  it("rejects a non-grid_title change or a non-uniform grid_title translation", () => {
    const nonTarget = candidateFixture().trace;
    for (const frame of nonTarget.frames.slice(FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2)) {
      frame.draws[0]!.translation.x = 0.125;
    }
    expectCandidateError(nonTarget, "candidate-semantic");

    const nonUniform = candidateFixture().trace;
    for (const frame of nonUniform.frames.slice(FAST_MANIM_RUNTIME_TRACE_OPENING_EDIT_FRAME_V2)) {
      frame.draws.at(-1)!.translation.x = 1.5;
    }
    expectCandidateError(nonUniform, "candidate-semantic");
  }, 60_000);
});
